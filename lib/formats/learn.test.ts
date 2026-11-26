import { beforeEach, describe, expect, it, vi } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import fixture from "@/fixtures/agenda/veckomote.doc.json";
import { VECKOMOTE } from "./standard";
import { docStructure } from "./structure";

const env = { KILL_SWITCH: false, GLOBAL_DAILY_USD: 25, ANTHROPIC_API_KEY: "test" };
const spend = { usd: 0 };
const recorded: { orgId: string; usd: number }[] = [];
vi.mock("@/lib/env", () => ({ getEnv: () => env }));
vi.mock("@/lib/db/usage", () => ({ dayUsd: async () => spend.usd }));
vi.mock("@/lib/db/claude-usage", () => ({
  recordClaudeUsage: async (orgId: string, u: { usd: number }) => void recorded.push({ orgId, usd: u.usd }),
}));

const { proposeFormat, forceLearned } = await import("./learn");
const { LEARN_SYSTEM_PROMPT } = await import("./learn-prompt");

const ORG = "00000000-0000-4000-8000-000000000001";
const structure = docStructure(fixture as unknown as docs_v1.Schema$Document);
const DOCS = [{ isTemplate: false, structure }];

/** A proposal as structured output returns it: position null, and poor style Claude should not get to keep. */
const PROPOSED = {
  kind: "veckomote",
  title: "Mötesprotokoll",
  infoTable: ["Datum", "Tid", "Närvarande", "Sekreterare"],
  agendaHeading: "Agenda",
  fixedAgendaItems: [
    { key: "approve", label: "Godkänn dagordning", role: "procedural", position: null },
    { key: "checkin", label: "Må-runda", role: "checkin", position: null },
    { key: "followup", label: "Från förra veckan", role: "followup", position: null },
    { key: "other", label: "Övrigt", role: "other", position: "last" },
  ],
  numbering: "numbered",
  tasksSection: { label: "Vad ska vi göra till nästa gång?", groupBy: "role" },
  notesSection: { label: "Anteckningar" },
  decisionPrefix: "B:",
  taskStyle: "role-first",
  tone: "full-sentences",
  signatures: null,
  requiredItems: [],
};
const ANSWER = {
  profile: PROPOSED,
  explanation: "Era protokoll börjar med en tabell och en numrerad agenda.",
  quality_note: "Uppgifterna saknar ofta datum; Simon Says skriver alltid ut dem.",
};

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
                usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                ...over,
              }) as unknown as BetaMessage,
          };
        },
      },
    },
  };
  return { client, bodies };
}

const userText = (b: BetaMessageStreamParams) =>
  (b.messages[0].content as { type: string; text: string }[]).map((c) => c.text).join("");

beforeEach(() => {
  env.KILL_SWITCH = false;
  spend.usd = 0;
  recorded.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("proposeFormat", () => {
  it("valid answer → ok, kind learned, standard style forced, usage recorded", async () => {
    const { client, bodies } = fakeClient(ANSWER);
    const res = await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.profile.kind).toBe("learned");
    expect(res.profile.decisionPrefix).toBe("Beslut:");
    expect(res.profile.tone).toBe(VECKOMOTE.tone);
    expect(res.profile.taskStyle).toBe(VECKOMOTE.taskStyle);
    expect(res.profile.fixedAgendaItems[0]).toEqual({ key: "approve", label: "Godkänn dagordning", role: "procedural" });
    expect(res.profile.fixedAgendaItems[3].position).toBe("last");
    expect(res.explanation).toBe(ANSWER.explanation);
    expect(res.qualityNote).toBe(ANSWER.quality_note);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].orgId).toBe(ORG);

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as unknown as { model: string; system: string; output_config: { format: { type: string } } };
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toBe(LEARN_SYSTEM_PROMPT);
    expect(body.output_config.format.type).toBe("json_schema");
  });

  it("privacy: the request carries the structure only", async () => {
    const { client, bodies } = fakeClient(ANSWER);
    await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never });
    const sent = JSON.stringify(bodies[0]);
    for (const text of ["Sommarfest på Kårallen", "Workshop om sponsring", "Elin Berglund", "Boka lokal"]) {
      expect(sent).not.toContain(text);
    }
    expect(userText(bodies[0])).toContain("Kommande event");
  });

  it("drops keys the schema does not know", async () => {
    const { client } = fakeClient({
      ...ANSWER,
      profile: { ...PROPOSED, secret: "x", fixedAgendaItems: [{ key: "a", label: "Övrigt", role: "other", position: null, note: "y" }] },
    });
    const res = await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res.profile)).not.toMatch(/"secret"|"note"/);
  });

  it("required items never come from minutes; max_tokens leaves room for thinking (final review R3)", async () => {
    const { client, bodies } = fakeClient({ ...ANSWER, profile: { ...PROPOSED, requiredItems: ["Val av justerare"] } });
    const res = await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never });
    expect(res.ok && res.profile.requiredItems).toEqual([]);
    expect((bodies[0] as unknown as { max_tokens: number }).max_tokens).toBe(16_000);
  });

  it("invalid profile → malformed", async () => {
    const { client } = fakeClient({ ...ANSWER, profile: { ...PROPOSED, numbering: "roman", title: "" } });
    expect(await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never })).toEqual({ ok: false, error: "malformed" });
  });

  it("not JSON → malformed", async () => {
    const { client } = fakeClient(ANSWER, { content: [{ type: "text", text: "nej" }] as never });
    expect(await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never })).toEqual({ ok: false, error: "malformed" });
  });

  it("refusal → refusal", async () => {
    const { client } = fakeClient(ANSWER, { stop_reason: "refusal" as never });
    expect(await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never })).toEqual({ ok: false, error: "refusal" });
  });

  it("request failure → error", async () => {
    const client = { beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new Error("boom")) }) } } };
    expect(await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never })).toEqual({ ok: false, error: "error" });
  });

  it("kill switch → spend without a call", async () => {
    env.KILL_SWITCH = true;
    const { client, bodies } = fakeClient(ANSWER);
    expect(await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never })).toEqual({ ok: false, error: "spend" });
    expect(bodies).toHaveLength(0);
  });

  it("daily cap reached → spend without a call", async () => {
    spend.usd = 25;
    const { client, bodies } = fakeClient(ANSWER);
    expect(await proposeFormat({ orgId: ORG, docs: DOCS }, { client: client as never })).toEqual({ ok: false, error: "spend" });
    expect(bodies).toHaveLength(0);
  });
});

describe("forceLearned", () => {
  it("Må-runda hiding is stored only when true", () => {
    expect(forceLearned({ ...VECKOMOTE, hideCheckin: false })).not.toHaveProperty("hideCheckin");
    expect(JSON.stringify(forceLearned({ ...VECKOMOTE }))).not.toContain("hideCheckin");
    expect(forceLearned({ ...VECKOMOTE, hideCheckin: true })?.hideCheckin).toBe(true);
  });
  it("forces kind and style on an edited profile", () => {
    const p = forceLearned({ ...VECKOMOTE, kind: "enkel", decisionPrefix: "X", tone: "short" });
    expect(p).toMatchObject({ kind: "learned", decisionPrefix: "Beslut:", tone: "full-sentences" });
  });

  it("repairs a repeated key and a second check-in / follow-up item instead of refusing (final review R3)", () => {
    const p = forceLearned({
      ...VECKOMOTE,
      fixedAgendaItems: [
        { key: "a", label: "Må-runda", role: "checkin" },
        { key: "a", label: "Hur mår vi", role: "checkin" },
        { key: "f", label: "Från förra veckan", role: "followup" },
        { key: "f", label: "Uppföljning", role: "followup" },
      ],
    });
    expect(p?.fixedAgendaItems.map((i) => [i.key, i.role])).toEqual([
      ["a", "checkin"],
      ["a-2", "topic"],
      ["f", "followup"],
      ["f-2", "topic"],
    ]);
  });

  it("rejects non-objects", () => {
    expect(forceLearned(null)).toBeNull();
    expect(forceLearned([])).toBeNull();
    expect(forceLearned("x")).toBeNull();
  });
});
