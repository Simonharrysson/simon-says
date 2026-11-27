import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Address, RawResponse, Transport } from "./fetch";

// The whole "Hämta styrelsen" path on a fictional site: robots.txt, the start page, the board page
// (ISO-8859-1), one cheap Claude call, and the filter. No network, no real Claude.

const env = { KILL_SWITCH: false, GLOBAL_DAILY_USD: 25, ANTHROPIC_API_KEY: "test" };
vi.mock("@/lib/env", () => ({ getEnv: () => env }));
vi.mock("@/lib/db/usage", () => ({ dayUsd: async () => 0 }));
const recorded: { orgId: string; usd: number }[] = [];
vi.mock("@/lib/db/claude-usage", () => ({ recordClaudeUsage: async (orgId: string, u: { usd: number }) => void recorded.push({ orgId, usd: u.usd }) }));

const { boardFromWebsite } = await import("./fetch-board");

const HOST = "seglarna-exempel.example";
type Page = { type?: string; body: Buffer | string; status?: number };

function site(pages: Record<string, Page>) {
  const asked: string[] = [];
  const resolve = async (): Promise<Address[]> => [{ address: "93.184.216.34", family: 4 }];
  const transport: Transport = async ({ url }) => {
    asked.push(url.pathname);
    const p = pages[url.pathname];
    const body = p ? (typeof p.body === "string" ? Buffer.from(p.body) : p.body) : Buffer.from("nej");
    const res: RawResponse = {
      status: p ? (p.status ?? 200) : 404,
      headers: { "content-type": p?.type ?? "text/plain" },
      body: (async function* () {
        yield new Uint8Array(body);
      })(),
      close() {},
    };
    return res;
  };
  return { asked, deps: { resolve, transport } };
}

function claude(answer: unknown) {
  const bodies: BetaMessageStreamParams[] = [];
  const client = {
    beta: {
      messages: {
        stream(body: BetaMessageStreamParams) {
          bodies.push(body);
          return {
            finalMessage: async () =>
              ({
                model: "claude-haiku-5-5",
                stop_reason: "end_turn",
                content: [{ type: "text", text: JSON.stringify(answer) }],
                usage: { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              }) as unknown as BetaMessage,
          };
        },
      },
    },
  };
  return { client, bodies };
}

const HOME = `<html><body><nav><a href="/styrelse">Styrelse</a> <a href="/om">Om oss</a> <a href="/intern/styrelse">Intern styrelse</a></nav><h1>Seglarna</h1></body></html>`;
const BOARD = Buffer.from("<html><body><h1>Styrelse</h1><p>Ordförande: Åsa Öhman</p><p>Kassör: Erik Lund</p></body></html>", "latin1");

beforeEach(() => {
  recorded.length = 0;
});

describe("boardFromWebsite", () => {
  it("reads the start page and the board page, asks the cheap model once and keeps only names on the pages", async () => {
    const s = site({
      "/robots.txt": { body: "User-agent: *\nDisallow: /intern/\n" },
      "/": { type: "text/html; charset=utf-8", body: HOME },
      "/styrelse": { type: "text/html; charset=iso-8859-1", body: BOARD },
      "/om": { type: "text/html", body: "<p>Vi seglar.</p>" },
    });
    const c = claude({ board: [{ name: "Åsa Öhman", role: "Ordförande" }, { name: "Erik Lund", role: "Kassör" }, { name: "Okänd Gäst", role: "Ledamot" }] });
    const r = await boardFromWebsite(`https://${HOST}/`, { orgId: "org-1", existingNames: ["Erik Lund"], deps: { fetch: s.deps, client: c.client as never } });
    expect(r).toEqual({
      ok: true,
      pages: 3,
      people: [
        { name: "Åsa Öhman", role: "Ordförande", exists: false },
        { name: "Erik Lund", role: "Kassör", exists: true },
      ],
    });
    // robots.txt first; /intern/ is never asked for; two subpages at most.
    expect(s.asked).toEqual(["/robots.txt", "/", "/styrelse", "/om"]);
    expect(c.bodies).toHaveLength(1);
    const body = c.bodies[0] as unknown as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.fallbacks).toBeUndefined();
    expect(body.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    // Usage is priced at Haiku's rate: 3000 × $0.10/M + 400 × $0.50/M.
    expect(recorded[0].usd).toBeCloseTo(0.0005, 6);
  });

  it("stops when robots.txt disallows the site, without fetching a page or calling Claude", async () => {
    const s = site({ "/robots.txt": { body: "User-agent: *\nDisallow: /\n" }, "/": { type: "text/html", body: HOME } });
    const c = claude({ board: [] });
    expect(await boardFromWebsite(`https://${HOST}/`, { orgId: "o", existingNames: [], deps: { fetch: s.deps, client: c.client as never } })).toEqual({ ok: false, reason: "robots" });
    expect(s.asked).toEqual(["/robots.txt"]);
    expect(c.bodies).toHaveLength(0);
  });

  it("a robots.txt that errors (5xx) means: don't read the site", async () => {
    const s = site({ "/robots.txt": { body: "", status: 503 }, "/": { type: "text/html", body: HOME } });
    expect(await boardFromWebsite(`https://${HOST}/`, { orgId: "o", existingNames: [], deps: { fetch: s.deps, client: claude({ board: [] }).client as never } })).toEqual({ ok: false, reason: "robots" });
  });

  it("fails softly with a reason code when the start page can't be read", async () => {
    const s = site({});
    const c = claude({ board: [] });
    expect(await boardFromWebsite(`https://${HOST}/`, { orgId: "o", existingNames: [], deps: { fetch: s.deps, client: c.client as never } })).toEqual({ ok: false, reason: "http_status" });
    expect(c.bodies).toHaveLength(0);
  });

  it("keeps to one overall time budget even when each request is within its own timeout", async () => {
    // Every answer comes after 40 ms: robots + start page + two subpages would take 160 ms.
    const s = site({
      "/robots.txt": { body: "" },
      "/": { type: "text/html", body: HOME },
      "/styrelse": { type: "text/html", body: BOARD },
      "/om": { type: "text/html", body: "<p>Vi seglar.</p>" },
    });
    const slow: typeof s.deps.transport = (req) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(s.deps.transport(req)), 40);
        req.signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))));
      });
    const c = claude({ board: [] });
    const r = await boardFromWebsite(`https://${HOST}/`, { orgId: "o", existingNames: [], budgetMs: 70, deps: { fetch: { ...s.deps, transport: slow }, client: c.client as never } });
    expect(r).toEqual({ ok: false, reason: "timeout" });
    expect(c.bodies).toHaveLength(0);
  });

  it("refuses a website that isn't https", async () => {
    expect(await boardFromWebsite(`http://${HOST}/`, { orgId: "o", existingNames: [] })).toEqual({ ok: false, reason: "bad_url" });
  });
});
