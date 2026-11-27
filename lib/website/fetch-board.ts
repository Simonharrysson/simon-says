import "server-only";
import { e2eWebRoot } from "@/lib/e2e/guard";
import type { NotesClient } from "@/lib/notes/engine";
import { CHEAP_MODEL, oneShot } from "@/lib/notes/oneshot";
import { BOARD_JSON_SCHEMA, BOARD_SYSTEM_PROMPT, BoardOutput, buildBoardUserText, filterBoard, type BoardSuggestion } from "./board";
import { checkUrl, ROBOTS_TOKEN, safeFetch, type FetchFailure, type SafeFetchOptions } from "./fetch";
import { boardLinks, decodeHtml, pageText } from "./html";
import { ROBOTS_MAX_BYTES, robotsAllows, robotsRules } from "./robots";

// "Hämta styrelsen från webbplatsen" end to end: robots.txt, the start page, at most two likely
// subpages (Styrelse, Om oss, Kontakt), then one cheap Claude call (Haiku 5.5, effort low,
// structured output) over the page text. Returns suggestions or a reason code; never throws and
// never logs page text, names or URLs.

export const MAX_SUBPAGES = 2;
/** Longest URL path (+ query) we read or match against robots.txt. */
export const PATH_MAX = 2048;
/** Hard wall-clock budget for reading the site (robots, pages, parsing); Claude has its own. */
export const SITE_BUDGET_MS = 10_000;
export const BOARD_TIMEOUT_MS = 15_000;

export type BoardOutcome = FetchFailure | "robots" | "no_text" | "claude" | "spend";

export type BoardFromWebsite = { ok: true; people: BoardSuggestion[]; pages: number } | { ok: false; reason: BoardOutcome };

export interface BoardDeps {
  /** Overrides for tests (resolver, transport). */
  fetch?: Pick<SafeFetchOptions, "resolve" | "transport" | "e2eRoot">;
  client?: NotesClient;
}

export async function boardFromWebsite(website: string, opts: { orgId: string; existingNames: string[]; deps?: BoardDeps; budgetMs?: number }): Promise<BoardFromWebsite> {
  const start = checkUrl(website);
  if (!start) return { ok: false, reason: "bad_url" };
  // Every fetch shares one deadline: past it, whatever is in flight is aborted and we stop.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), opts.budgetMs ?? SITE_BUDGET_MS);
  try {
    const pages = await readSite(start, { ...(opts.deps?.fetch ?? { e2eRoot: e2eWebRoot() }), signal: deadline.signal });
    if (deadline.signal.aborted) return { ok: false, reason: "timeout" };
    if (!pages.ok) return pages;
    return await askClaude(pages.texts, opts);
  } finally {
    clearTimeout(timer);
  }
}

async function readSite(start: URL, net: Pick<SafeFetchOptions, "resolve" | "transport" | "e2eRoot" | "signal">): Promise<{ ok: true; texts: string[] } | { ok: false; reason: BoardOutcome }> {
  // robots.txt per origin (a redirect can move us from exempel.se to www.exempel.se).
  const robots = new Map<string, Promise<ReturnType<typeof robotsRules> | null>>();
  const rulesFor = (url: URL) => {
    let p = robots.get(url.origin);
    if (!p) {
      p = safeFetch(`${url.origin}/robots.txt`, { ...net, accept: ["text/plain"], maxBytes: ROBOTS_MAX_BYTES }).then((r) => {
        if (r.ok) return robotsRules(new TextDecoder().decode(r.bytes), ROBOTS_TOKEN);
        // No robots.txt (missing, or an HTML page in its place): no rules. A server error, no
        // answer, or one too big to read: don't read the site (RFC 9309: assume "disallow").
        if ((r.reason === "http_status" && (r.status ?? 0) < 500) || r.reason === "content_type") return [];
        return null;
      });
      robots.set(url.origin, p);
    }
    return p;
  };
  const allowed = async (url: URL) => {
    const path = `${url.pathname}${url.search}`;
    // A path this long is not a page we need (and keeps the robots match bounded): skip it.
    if (path.length > PATH_MAX) return false;
    const rules = await rulesFor(url);
    return rules !== null && robotsAllows(rules, path);
  };

  if (!(await allowed(start))) return { ok: false, reason: "robots" };
  const home = await safeFetch(start, { ...net, accept: ["text/html", "application/xhtml+xml"] });
  if (!home.ok) return { ok: false, reason: home.reason };
  if (home.url.origin !== start.origin && !(await allowed(home.url))) return { ok: false, reason: "robots" };
  const homeHtml = decodeHtml(home.bytes, home.charset);

  // The best candidates robots.txt lets us read, two at most.
  const candidates = boardLinks(homeHtml, home.url, 6);
  const permitted = await Promise.all(candidates.map(allowed));
  const links = candidates.filter((_, i) => permitted[i]).slice(0, MAX_SUBPAGES);
  const subpages = await Promise.all(
    links.map(async (url) => {
      const r = await safeFetch(url, { ...net, accept: ["text/html", "application/xhtml+xml"] });
      // A subpage that fails is skipped; the start page still counts.
      return r.ok ? pageText(decodeHtml(r.bytes, r.charset)) : null;
    }),
  );
  // Board pages first: they matter most when the text is cut.
  const texts = [...subpages.filter((t): t is string => Boolean(t)), pageText(homeHtml)].filter((t) => t.length > 0);
  if (texts.join("").length < 20) return { ok: false, reason: "no_text" };
  return { ok: true, texts };
}

async function askClaude(pages: string[], opts: { orgId: string; existingNames: string[]; deps?: BoardDeps }): Promise<BoardFromWebsite> {
  const user = buildBoardUserText(pages);
  const res = await oneShot({
    label: "website board",
    model: CHEAP_MODEL,
    effort: "low",
    system: BOARD_SYSTEM_PROMPT,
    user,
    jsonSchema: BOARD_JSON_SCHEMA,
    schema: BoardOutput,
    maxTokens: 4000,
    timeoutMs: BOARD_TIMEOUT_MS,
    orgId: opts.orgId,
    client: opts.deps?.client,
  });
  if (!res.ok) return { ok: false, reason: res.reason === "spend" ? "spend" : "claude" };
  return { ok: true, people: filterBoard(res.value, user, opts.existingNames), pages: pages.length };
}
