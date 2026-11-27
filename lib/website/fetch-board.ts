import "server-only";
import { e2eWebRoot } from "@/lib/e2e/guard";
import type { NotesClient } from "@/lib/notes/engine";
import { CHEAP_MODEL, oneShot } from "@/lib/notes/oneshot";
import { BOARD_JSON_SCHEMA, BOARD_SYSTEM_PROMPT, BoardOutput, buildBoardUserText, filterBoard, type BoardSuggestion } from "./board";
import { checkUrl, ROBOTS_TOKEN, safeFetch, type FetchFailure, type SafeFetchOptions } from "./fetch";
import { boardLinks, decodeHtml, pageText } from "./html";
import { robotsAllows, robotsRules } from "./robots";

// "Hämta styrelsen från webbplatsen" end to end: robots.txt, the start page, at most two likely
// subpages (Styrelse, Om oss, Kontakt), then one cheap Claude call (Haiku 5.5, effort low,
// structured output) over the page text. Returns suggestions or a reason code; never throws and
// never logs page text, names or URLs.

export const MAX_SUBPAGES = 2;
export const BOARD_TIMEOUT_MS = 20_000;

export type BoardOutcome = FetchFailure | "robots" | "no_text" | "claude" | "spend";

export type BoardFromWebsite = { ok: true; people: BoardSuggestion[]; pages: number } | { ok: false; reason: BoardOutcome };

export interface BoardDeps {
  /** Overrides for tests (resolver, transport). */
  fetch?: Pick<SafeFetchOptions, "resolve" | "transport" | "e2eRoot">;
  client?: NotesClient;
}

export async function boardFromWebsite(website: string, opts: { orgId: string; existingNames: string[]; deps?: BoardDeps }): Promise<BoardFromWebsite> {
  const start = checkUrl(website);
  if (!start) return { ok: false, reason: "bad_url" };
  const net: Pick<SafeFetchOptions, "resolve" | "transport" | "e2eRoot"> = opts.deps?.fetch ?? { e2eRoot: e2eWebRoot() };

  // robots.txt per origin (a redirect can move us from exempel.se to www.exempel.se).
  const robots = new Map<string, Promise<ReturnType<typeof robotsRules> | null>>();
  const rulesFor = (url: URL) => {
    let p = robots.get(url.origin);
    if (!p) {
      p = safeFetch(`${url.origin}/robots.txt`, { ...net, accept: ["text/plain"], maxBytes: 512 * 1024 }).then((r) => {
        if (r.ok) return robotsRules(new TextDecoder().decode(r.bytes), ROBOTS_TOKEN);
        // No usable robots.txt (missing, an HTML page, too big): no rules. A server error or no
        // answer at all: don't read the site (RFC 9309 says to assume "disallow" then).
        if ((r.reason === "http_status" && (r.status ?? 0) < 500) || r.reason === "content_type" || r.reason === "too_large") return [];
        return null;
      });
      robots.set(url.origin, p);
    }
    return p;
  };
  const allowed = async (url: URL) => {
    const rules = await rulesFor(url);
    return rules !== null && robotsAllows(rules, `${url.pathname}${url.search}`);
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
  const pages = [...subpages.filter((t): t is string => Boolean(t)), pageText(homeHtml)].filter((t) => t.length > 0);
  if (pages.join("").length < 20) return { ok: false, reason: "no_text" };

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
