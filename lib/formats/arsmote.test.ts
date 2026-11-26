import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";

const env = { KILL_SWITCH: false, GLOBAL_DAILY_USD: 25, ANTHROPIC_API_KEY: "test" };
const spend = { usd: 0 };
const recorded: string[] = [];
vi.mock("@/lib/env", () => ({ getEnv: () => env }));
vi.mock("@/lib/db/usage", () => ({ dayUsd: async () => spend.usd }));
vi.mock("@/lib/db/claude-usage", () => ({ recordClaudeUsage: async (orgId: string) => void recorded.push(orgId) }));

const { extractStadgarAgendas, arsmoteProfile } = await import("./arsmote");
const { ARSMOTE } = await import("./standard");

// Fictional stadgar (fixtures/stadgar): an invented förening.
const STADGAR = readFileSync(join(process.cwd(), "fixtures/stadgar/fiktiv-forening.txt"), "utf8");
const ORG = "00000000-0000-4000-8000-000000000001";

function fakeClient(answer: unknown, over: Partial<BetaMessage> = {}) {
  const bodies: BetaMessageStreamParams[] = [];
  const client = {
    beta: {
      messages: {
        stream(body: BetaMessageStreamParams) {
          bodies.push(body);
          return {
            finalMessage: async () =>
              ({
                id: "msg",
                type: "message",
                role: "assistant",
                model: "claude-opus-5-5",
                stop_reason: "end_turn",
                content: [{ type: "text", text: JSON.stringify(answer) }],
                usage: { input_tokens: 3000, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                ...over,
              }) as unknown as BetaMessage,
          };
        },
      },
    },
  };
  return { client: client as never, bodies };
}

beforeEach(() => {
  env.KILL_SWITCH = false;
  spend.usd = 0;
  recorded.length = 0;
});

describe("extractStadgarAgendas", () => {
  it("one call returns both lists, cleaned; usage on the org", async () => {
    const { client, bodies } = fakeClient({
      board: ["1. Fråga om beslutsmässighet", "fråga om beslutsmässighet"],
      arsmote: ["§1 Mötets öppnande", "Val av mötesordförande", "Fastställande av medlemsavgift.", ""],
    });
    const res = await extractStadgarAgendas({ kind: "doc", text: STADGAR }, { orgId: ORG, client });
    expect(res).toMatchObject({
      ok: true,
      board: ["Fråga om beslutsmässighet"],
      arsmote: ["Mötets öppnande", "Val av mötesordförande", "Fastställande av medlemsavgift"],
    });
    expect(bodies).toHaveLength(1);
    expect(recorded).toEqual([ORG]);
  });

  it("kill switch → spend, no call; malformed → malformed", async () => {
    env.KILL_SWITCH = true;
    const { client, bodies } = fakeClient({ board: [], arsmote: [] });
    expect(await extractStadgarAgendas({ kind: "doc", text: STADGAR }, { orgId: ORG, client })).toEqual({ ok: false, error: "spend" });
    expect(bodies).toHaveLength(0);
    env.KILL_SWITCH = false;
    const bad = fakeClient({ items: [] });
    expect(await extractStadgarAgendas({ kind: "doc", text: STADGAR }, { orgId: ORG, client: bad.client })).toEqual({ ok: false, error: "malformed" });
  });
});

describe("arsmoteProfile", () => {
  it("no items → the standard Årsmöte", () => {
    expect(arsmoteProfile([])).toBe(ARSMOTE);
  });

  it("the stadgar's order; standard items keep key and role; closing items added last", () => {
    const p = arsmoteProfile(["Mötets öppnande", "Val av justerare och rösträknare", "Fastställande av medlemsavgift", "Val av revisorer"]);
    expect(p.kind).toBe("arsmote");
    expect(p.fixedAgendaItems.map((i) => [i.key, i.label, i.role, i.position ?? ""])).toEqual([
      ["open", "Mötets öppnande", "procedural", ""],
      ["adjuster", "Val av justerare och rösträknare", "procedural", ""],
      ["s1", "Fastställande av medlemsavgift", "other", ""],
      ["s2", "Val av revisorer", "other", ""],
      ["other", "Övriga frågor", "other", "last"],
      ["close", "Mötets avslutande", "procedural", "last"],
    ]);
  });

  it("caps at 18 stadgar items (+ closing), drops duplicates, stays valid", () => {
    const items = Array.from({ length: 25 }, (_, i) => `Ärende ${i + 1}`);
    const p = arsmoteProfile([...items, "ärende 1"]);
    expect(p.fixedAgendaItems.length).toBe(20);
    expect(new Set(p.fixedAgendaItems.map((i) => i.key)).size).toBe(20);
  });
});
