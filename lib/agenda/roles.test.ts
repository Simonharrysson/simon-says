import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { STYRELSEPROTOKOLL, VECKOMOTE } from "@/lib/formats/standard";

const env = { KILL_SWITCH: false, GLOBAL_DAILY_USD: 25, ANTHROPIC_API_KEY: "test" };
const spend = { usd: 0 };
const recorded: { orgId: string; usd: number }[] = [];
vi.mock("@/lib/env", () => ({ getEnv: () => env }));
vi.mock("@/lib/db/usage", () => ({ dayUsd: async () => spend.usd }));
vi.mock("@/lib/db/claude-usage", () => ({
  recordClaudeUsage: async (orgId: string, u: { usd: number }) => void recorded.push({ orgId, usd: u.usd }),
}));

const { fuzzyRoles, matchFixedItems } = await import("./roles");

const ITEMS = ["Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Ekonomi", "Övrigt"].map((label, i) => ({
  key: `ag-${i + 1}`,
  label,
}));
const FUZZY = { "ag-1": "procedural", "ag-2": "checkin", "ag-3": "followup", "ag-4": "topic", "ag-5": "topic", "ag-6": "other" };

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
                usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                ...over,
              }) as unknown as BetaMessage,
          };
        },
      },
    },
  };
  return { client, bodies };
}

beforeEach(() => {
  env.KILL_SWITCH = false;
  spend.usd = 0;
  recorded.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("fuzzyRoles", () => {
  it("maps the fixture labels", () => {
    expect(fuzzyRoles(ITEMS, VECKOMOTE.fixedAgendaItems)).toEqual(FUZZY);
  });

  it("matches synonyms, numbers and case", () => {
    const items = [
      { key: "ag-1", label: "Måsrunda" },
      { key: "ag-2", label: "§6. FÖREGÅENDE PROTOKOLL:" },
      { key: "ag-3", label: "Val av justerare" },
      { key: "ag-4", label: "Övriga frågor" },
      { key: "ag-5", label: "Sommarfest" },
    ];
    expect(fuzzyRoles(items, VECKOMOTE.fixedAgendaItems)).toEqual({
      "ag-1": "checkin",
      "ag-2": "followup",
      "ag-3": "procedural",
      "ag-4": "other",
      "ag-5": "topic",
    });
    expect(fuzzyRoles([{ key: "ag-1", label: "Mötets öppnande" }], STYRELSEPROTOKOLL.fixedAgendaItems)).toEqual({ "ag-1": "procedural" });
  });

  it("keeps only the first checkin and followup", () => {
    const items = [
      { key: "ag-1", label: "Må-runda" },
      { key: "ag-2", label: "Incheckning" },
      { key: "ag-3", label: "Från förra veckan" },
      { key: "ag-4", label: "Uppföljning" },
    ];
    expect(fuzzyRoles(items, VECKOMOTE.fixedAgendaItems)).toEqual({ "ag-1": "checkin", "ag-2": "topic", "ag-3": "followup", "ag-4": "topic" });
  });
});

describe("matchFixedItems", () => {
  const opts = (client: unknown) => ({ orgId: "org-1", client: client as never });

  it("uses Claude's roles, sends labels only with the engine settings, records usage", async () => {
    const { client, bodies } = fakeClient({
      roles: [
        { key: "ag-1", role: "procedural" },
        { key: "ag-2", role: "checkin" },
        { key: "ag-3", role: "followup" },
        { key: "ag-4", role: "topic" },
        { key: "ag-5", role: "procedural" }, // differs from fuzzy: Claude wins
        { key: "ag-6", role: "other" },
      ],
    });
    const roles = await matchFixedItems(ITEMS, VECKOMOTE.fixedAgendaItems, opts(client));
    expect(roles).toEqual({ ...FUZZY, "ag-5": "procedural" });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as unknown as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    const text = JSON.stringify(body.messages);
    expect(text).toContain("ag-4: Kommande event");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].orgId).toBe("org-1");
    expect(recorded[0].usd).toBeGreaterThan(0);
  });

  it("fills items Claude left out with their fuzzy role and enforces one checkin", async () => {
    const { client } = fakeClient({ roles: [{ key: "ag-2", role: "checkin" }, { key: "ag-4", role: "checkin" }] });
    const roles = await matchFixedItems(ITEMS, VECKOMOTE.fixedAgendaItems, opts(client));
    expect(roles).toEqual({ ...FUZZY, "ag-4": "topic" });
  });

  it("an unknown key falls back to fuzzy", async () => {
    const { client } = fakeClient({ roles: [{ key: "ag-1", role: "procedural" }, { key: "ag-9", role: "checkin" }] });
    expect(await matchFixedItems(ITEMS, VECKOMOTE.fixedAgendaItems, opts(client))).toEqual(FUZZY);
  });

  it("a refusal falls back to fuzzy (usage still recorded)", async () => {
    const { client } = fakeClient({ roles: [] }, { stop_reason: "refusal" as BetaMessage["stop_reason"] });
    expect(await matchFixedItems(ITEMS, VECKOMOTE.fixedAgendaItems, opts(client))).toEqual(FUZZY);
    expect(recorded).toHaveLength(1);
  });

  it("malformed output or a thrown request falls back to fuzzy", async () => {
    const { client } = fakeClient("not json");
    expect(await matchFixedItems(ITEMS, VECKOMOTE.fixedAgendaItems, opts(client))).toEqual(FUZZY);
    const failing = { beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new Error("boom")) }) } } };
    expect(await matchFixedItems(ITEMS, VECKOMOTE.fixedAgendaItems, opts(failing))).toEqual(FUZZY);
  });

  it("kill switch → fuzzy, no client call", async () => {
    env.KILL_SWITCH = true;
    const { client, bodies } = fakeClient({ roles: [] });
    expect(await matchFixedItems(ITEMS, VECKOMOTE.fixedAgendaItems, opts(client))).toEqual(FUZZY);
    expect(bodies).toHaveLength(0);
  });

  it("daily dollar cap reached → fuzzy, no client call", async () => {
    spend.usd = 25;
    const { client, bodies } = fakeClient({ roles: [] });
    expect(await matchFixedItems(ITEMS, VECKOMOTE.fixedAgendaItems, opts(client))).toEqual(FUZZY);
    expect(bodies).toHaveLength(0);
  });

  it("no items → no call", async () => {
    const { client, bodies } = fakeClient({ roles: [] });
    expect(await matchFixedItems([], VECKOMOTE.fixedAgendaItems, opts(client))).toEqual({});
    expect(bodies).toHaveLength(0);
  });
});
