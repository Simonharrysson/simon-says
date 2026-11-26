import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { DashInput, DashItem, DashMeeting } from "./overview";

// Scripted Claude answers only: no API calls. Fictional förening, no real content.

const env = { KILL_SWITCH: false, GLOBAL_DAILY_USD: 25, ANTHROPIC_API_KEY: "test" };
const spend = { usd: 0 };
const recorded: { orgId: string; usd: number }[] = [];
vi.mock("@/lib/env", () => ({ getEnv: () => env }));
vi.mock("@/lib/db/usage", () => ({ dayUsd: async () => spend.usd }));
vi.mock("@/lib/db/claude-usage", () => ({
  recordClaudeUsage: async (orgId: string, u: { usd: number }) => void recorded.push({ orgId, usd: u.usd }),
}));

const { proposeGoals, GOALS_SYSTEM_PROMPT } = await import("./goals");
const { goalsInput, scrubNames, GoalsSchema, MAX_DECISIONS } = await import("./goals-input");
const { safeAgendaLabels } = await import("./safe-labels");
const { safeItemLabel, firstNames } = await import("@/lib/formats/structure");

const ORG = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-26T18:00:00Z");

const meeting = (id: string, date: string, over: Partial<DashMeeting> = {}): DashMeeting => ({
  id,
  org_id: ORG,
  started_at: `${date}T17:00:00Z`,
  status: "done",
  is_test: false,
  layout: "format",
  agenda_roles: { "ag-1": "checkin", "ag-2": "topic" },
  agenda_labels: { "ag-1": "Må-runda", "ag-2": "Medlemsvärvning" },
  ...over,
});
let pos = 0;
const row = (meeting_id: string, id: string, kind: "decision" | "task", text: string, over: Partial<DashItem> = {}): DashItem => ({
  meeting_id,
  id,
  section: kind === "task" ? "action" : "decision",
  kind,
  text,
  owner: "Ada Kask",
  owner_person_id: "p-ada",
  due: null,
  done: false,
  deleted_by_human: false,
  copy_of: null,
  carried_from_meeting: null,
  carried_from_id: null,
  anchor: "ag-2",
  position: pos++,
  ...over,
});

const INPUT: DashInput = {
  meetings: [
    meeting("m1", "2026-09-10"),
    meeting("m2", "2026-10-08"),
    meeting("m3", "2026-11-05"),
    meeting("mt", "2026-11-12", { is_test: true }),
  ],
  items: [
    row("m1", "d1", "decision", "Vi ställer upp med ett bord på kårens mässa"),
    row("m2", "d2", "decision", "Ada Kask tar fram en flyer till nollningen"),
    row("m3", "d3", "decision", "Bos förslag om prova-på-kväll godkänns"),
    row("m3", "d4", "decision", "HEMLIGT från Må-rundan", { anchor: "ag-1" }),
    row("mt", "d5", "decision", "TESTMÖTE-beslut"),
    row("m3", "t1", "task", "Boka rum för prova-på-kvällen"),
  ],
  speakers: [{ meeting_id: "m1", el_session_id: "s", speaker_label: "0", person_id: "p-ada", display_name: "Ada Kask" }],
  people: [
    { id: "p-ada", name: "Ada Kask", role: "Kassör" },
    { id: "p-bo", name: "Bo Tärn", role: null },
  ],
};

const ANSWER = {
  goals: [
    { title: "Fler medlemmar under våren.", why: "Medlemsvärvning har varit uppe på tre möten sedan september." },
    { title: "En prova-på-kväll i december", why: "Beslutet i november och den öppna uppgiften om att boka rum pekar dit." },
    { title: "  ", why: "tom titel" },
  ],
  explanation: "Målen bygger på det som återkommer i era möten.",
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
                usage: { input_tokens: 700, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
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

describe("goalsInput", () => {
  it("fewer than 3 counted meetings (Testmöten do not count): null, so no call", () => {
    const few = { ...INPUT, meetings: [INPUT.meetings[0], INPUT.meetings[1], INPUT.meetings[3]] };
    expect(goalsInput(ORG, few, NOW)).toBeNull();
  });

  it("decisions, topics and open tasks of real meetings, names scrubbed, no owners, no Må-runda", () => {
    const g = goalsInput(ORG, INPUT, NOW)!;
    expect(g.meetings).toBe(3);
    expect(g.from).toBe("2026-09-10");
    expect(g.topics).toEqual([{ label: "Medlemsvärvning", meetings: 3, decisions: 3 }]);
    expect(g.decisions.map((d) => d.text)).toEqual([
      "en person förslag om prova-på-kväll godkänns",
      "en person tar fram en flyer till nollningen",
      "Vi ställer upp med ett bord på kårens mässa",
    ]);
    expect(g.openTasks).toEqual([{ since: "2026-11", text: "Boka rum för prova-på-kvällen" }]);
    const all = JSON.stringify(g);
    for (const s of ["HEMLIGT", "TESTMÖTE", "Ada", "Kask", "Kassör", "p-ada"]) expect(all).not.toContain(s);
  });

  it("at most MAX_DECISIONS decisions, newest first", () => {
    const many = Array.from({ length: MAX_DECISIONS + 10 }, (_, i) => row("m1", `x${i}`, "decision", `Beslut ${i}`));
    const g = goalsInput(ORG, { ...INPUT, items: [...INPUT.items, ...many] }, NOW)!;
    expect(g.decisions).toHaveLength(MAX_DECISIONS);
    expect(g.decisions[0].month).toBe("2026-11");
  });
});

describe("scrubNames", () => {
  it("full names, name parts and genitives; not inside other words", () => {
    expect(scrubNames("Ada Kask och Adas kompis Bo", ["Ada Kask", "Bo Tärn"])).toBe("en person och en person kompis en person");
    expect(scrubNames("Bokcirkel och Adapter", ["Ada Kask", "Bo Tärn"])).toBe("Bokcirkel och Adapter");
  });
});

describe("proposeGoals", () => {
  it("one call with the summary; goals cleaned (no empty title, no ending stop); usage recorded on the org", async () => {
    const { client, bodies } = fakeClient(ANSWER);
    const res = await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: client as never });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.goals).toEqual([
      { title: "Fler medlemmar under våren", why: "Medlemsvärvning har varit uppe på tre möten sedan september." },
      { title: "En prova-på-kväll i december", why: "Beslutet i november och den öppna uppgiften om att boka rum pekar dit." },
    ]);
    expect(res.explanation).toBe(ANSWER.explanation);
    expect(recorded).toEqual([{ orgId: ORG, usd: expect.any(Number) }]);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as unknown as { model: string; system: string; output_config: { format: { type: string } } };
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toBe(GOALS_SYSTEM_PROMPT);
    expect(body.output_config.format.type).toBe("json_schema");
  });

  it("privacy: the request holds no Testmöte, Må-runda, owner or name", async () => {
    const { client, bodies } = fakeClient(ANSWER);
    await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: client as never });
    const sent = JSON.stringify(bodies[0]);
    for (const s of ["HEMLIGT", "TESTMÖTE", "Ada", "Kask", "Kassör", "Tärn"]) expect(sent).not.toContain(s);
    expect(sent).toContain("Medlemsvärvning");
  });

  it("more than 5 goals: the first 5", async () => {
    const goals = Array.from({ length: 7 }, (_, i) => ({ title: `Mål ${i}`, why: "x" }));
    const { client } = fakeClient({ ...ANSWER, goals });
    const res = await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: client as never });
    expect(res.ok && res.goals.length).toBe(5);
  });

  it("no usable goal → malformed; not JSON → malformed", async () => {
    const empty = fakeClient({ ...ANSWER, goals: [{ title: " ", why: "" }] });
    expect(await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: empty.client as never })).toEqual({ ok: false, error: "malformed" });
    const bad = fakeClient(ANSWER, { content: [{ type: "text", text: "nej" }] as never });
    expect(await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: bad.client as never })).toEqual({ ok: false, error: "malformed" });
  });

  it("refusal → refusal; request failure → error", async () => {
    const refused = fakeClient(ANSWER, { stop_reason: "refusal" as never });
    expect(await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: refused.client as never })).toEqual({ ok: false, error: "refusal" });
    const broken = { beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new Error("boom")) }) } } };
    expect(await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: broken as never })).toEqual({ ok: false, error: "error" });
  });

  it("kill switch or daily cap → spend, without a call", async () => {
    env.KILL_SWITCH = true;
    const a = fakeClient(ANSWER);
    expect(await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: a.client as never })).toEqual({ ok: false, error: "spend" });
    expect(a.bodies).toHaveLength(0);
    env.KILL_SWITCH = false;
    spend.usd = 25;
    const b = fakeClient(ANSWER);
    expect(await proposeGoals({ orgId: ORG, summary: goalsInput(ORG, INPUT, NOW)! }, { client: b.client as never })).toEqual({ ok: false, error: "spend" });
    expect(b.bodies).toHaveLength(0);
  });
});

describe("GoalsSchema (approve)", () => {
  it("trims, empties why to null, refuses an empty or long title and more than 5", () => {
    expect(GoalsSchema.parse([{ title: "  Fler  medlemmar ", why: " " }])).toEqual([{ title: "Fler medlemmar", why: null }]);
    expect(GoalsSchema.safeParse([{ title: " " }]).success).toBe(false);
    expect(GoalsSchema.safeParse([{ title: "x".repeat(81) }]).success).toBe(false);
    expect(GoalsSchema.safeParse(Array.from({ length: 6 }, () => ({ title: "Mål" }))).success).toBe(false);
    expect(GoalsSchema.safeParse("nej").success).toBe(false);
    expect(GoalsSchema.parse([])).toEqual([]);
  });
});

describe("safeAgendaLabels", () => {
  it("ag keys only; drops names, digits and long labels (the format-learning filter)", () => {
    const names = firstNames(["Ada Kask"]);
    const labels = safeAgendaLabels(
      [
        { key: "ag-1", label: " Ekonomi " },
        { key: "ag-2", label: "Adas rapport" },
        { key: "ag-3", label: "Budget 2027" },
        { key: "tasks", label: "Att göra" },
        { key: "ag-4", label: "ett två tre fyra fem sex sju åtta nio" },
        { key: "ag-5", label: "Kommande  event" },
      ],
      (l) => safeItemLabel(l, names),
    );
    expect(labels).toEqual({ "ag-1": "Ekonomi", "ag-5": "Kommande event" });
  });
});
