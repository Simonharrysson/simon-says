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

const { extractRequiredItems, cleanItems, STADGAR_MAX_CHARS } = await import("./stadgar");

// Fictional stadgar (fixtures/stadgar): an invented förening, not any real one.
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
                usage: { input_tokens: 3000, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                ...over,
              }) as unknown as BetaMessage,
          };
        },
      },
    },
  };
  return { client: client as never, bodies };
}

const content = (b: BetaMessageStreamParams) => b.messages[0].content as { type: string; text?: string; source?: Record<string, string> }[];

const logs: string[] = [];
beforeEach(() => {
  env.KILL_SWITCH = false;
  spend.usd = 0;
  recorded.length = 0;
  logs.length = 0;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
});

describe("extractRequiredItems", () => {
  it("Doc text: items returned trimmed, numbering dropped; usage recorded; text sent once", async () => {
    const { client, bodies } = fakeClient({
      items: ["  Mötets öppnande ", "2. Fråga om mötets behöriga utlysande", "§3 Fråga om beslutsmässighet.", "Val av justerare", "val av justerare", ""],
    });
    const res = await extractRequiredItems({ kind: "doc", text: STADGAR }, { orgId: ORG, client });
    expect(res).toMatchObject({
      ok: true,
      items: ["Mötets öppnande", "Fråga om mötets behöriga utlysande", "Fråga om beslutsmässighet", "Val av justerare"],
    });
    expect(recorded).toEqual([ORG]);
    const blocks = content(bodies[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("Fråga om mötets behöriga utlysande");
    expect((bodies[0] as unknown as { model: string }).model).toBe("claude-opus-5-5");
  });

  it("20 items → 15, each at most 80 chars", async () => {
    const items = Array.from({ length: 20 }, (_, i) => `Punkt ${i + 1} ${"x".repeat(100)}`);
    const { client } = fakeClient({ items });
    const res = await extractRequiredItems({ kind: "doc", text: STADGAR }, { orgId: ORG, client });
    if (!res.ok) throw new Error(res.error);
    expect(res.items).toHaveLength(15);
    expect(res.items.every((i) => i.length <= 80)).toBe(true);
  });

  it("Doc text is capped at 100 000 chars", async () => {
    const { client, bodies } = fakeClient({ items: [] });
    await extractRequiredItems({ kind: "doc", text: "a".repeat(STADGAR_MAX_CHARS + 5000) }, { orgId: ORG, client });
    const text = content(bodies[0])[0].text!;
    expect(text.match(/a{1000,}/)![0].length).toBe(STADGAR_MAX_CHARS);
  });

  it("PDF input sends a document block with media_type application/pdf", async () => {
    const { client, bodies } = fakeClient({ items: ["Val av justerare"] });
    const base64 = Buffer.from("%PDF-1.4 fiktiv").toString("base64");
    const res = await extractRequiredItems({ kind: "pdf", base64 }, { orgId: ORG, client });
    expect(res.ok).toBe(true);
    const blocks = content(bodies[0]);
    expect(blocks[0]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } });
    expect(blocks[1].type).toBe("text");
  });

  it("kill switch → spend without a call", async () => {
    env.KILL_SWITCH = true;
    const { client, bodies } = fakeClient({ items: [] });
    expect(await extractRequiredItems({ kind: "doc", text: STADGAR }, { orgId: ORG, client })).toEqual({ ok: false, error: "spend" });
    expect(bodies).toHaveLength(0);
  });

  it("refusal → refusal; malformed → malformed; nothing of the stadgar logged", async () => {
    const refused = fakeClient({ items: [] }, { stop_reason: "refusal" as never });
    expect(await extractRequiredItems({ kind: "doc", text: STADGAR }, { orgId: ORG, client: refused.client })).toEqual({ ok: false, error: "refusal" });
    const bad = fakeClient({ wrong: true });
    expect(await extractRequiredItems({ kind: "doc", text: STADGAR }, { orgId: ORG, client: bad.client })).toEqual({ ok: false, error: "malformed" });
    expect(logs.join("\n")).not.toMatch(/Åsbacka|brädspel/i);
  });
});

describe("cleanItems", () => {
  it("drops empties and duplicates", () => {
    expect(cleanItems([" ", "A", "a", "B:"])).toEqual(["A", "B"]);
  });
});
