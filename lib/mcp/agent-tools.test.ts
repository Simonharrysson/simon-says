import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { HomeNoteRow } from "@/lib/home/tasks";
import { fakeReader } from "@/test/mcp-kit";
import { getOrgMemory, listAgentTasks, updateAgentTask } from "./agent-tools";
import type { McpReader } from "./reader";
import type { ToolCtx, ToolDeps } from "./tools";

const ORG = "55555555-5555-4555-8555-555555555555";
const M = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";

const note = (over: Partial<HomeNoteRow>): HomeNoteRow => ({
  meeting_id: M,
  id: "n1",
  section: "action",
  kind: "task",
  text: "Sammanställ offerterna",
  owner: "Claude",
  due: "fredag",
  done_when: "En tabell i Driven",
  locked: false,
  deleted_by_human: false,
  last_rendered_text: null,
  range_name: null,
  position: 0,
  ...over,
});

const ROWS: HomeNoteRow[] = [
  note({}),
  note({ id: "n2", text: "Boka lokal", owner: "Anna" }),
  note({ id: "d1", section: "decision", kind: "decision", text: "Offerter över 50 000 kr godkänns av VD", owner: null }),
  note({ id: "x1", section: "note", kind: "note", text: "Raderad hemlighet", owner: null, deleted_by_human: true }),
  note({ id: "x2", section: "note", kind: "note", text: "Kunden vill ha svar före jul", owner: null }),
];

function ctx(opts: { role?: "admin" | "member"; startedBy?: string; kind?: "foretag" | "privat"; reader?: Partial<McpReader> } = {}) {
  const setAgentTask = vi.fn(async () => true);
  const completeNoteTask = vi.fn(async () => ({ ok: true as const, doc: "written" as const }));
  const c: ToolCtx = {
    reader: fakeReader("u1", {
      orgs: async () => [{ id: ORG, name: "Bolaget", kind: opts.kind ?? "foretag", role: opts.role ?? "member" }],
      meetings: async (q) => (q.ids && !q.ids.includes(M) ? [] : [{ id: M, org_id: ORG, started_at: "2026-11-26T17:00:00Z", status: "done", started_by: opts.startedBy ?? "u1", doc_id: "doc1", title: "Säljmöte" }]),
      noteItems: async () => ROWS,
      people: async () => [{ id: "p1", org_id: ORG, name: "Anna", member_user_id: "u9" }],
      setAgentTask,
      ...opts.reader,
    }),
    user: { id: "u1", email: "a@b.se" } as User,
    deps: { completeNoteTask, actorClient: () => ({}) as SupabaseClient } as unknown as ToolDeps,
    now: new Date("2026-11-28T10:00:00Z"),
    origin: "https://simonsays.test",
    ids: {},
  };
  return { c, setAgentTask, completeNoteTask };
}

describe("list_agent_tasks", () => {
  it("one brief per task the meeting gave Claude, with only what the app shows of that meeting", async () => {
    const { c } = ctx();
    const r = await listAgentTasks(c, {});
    expect(r).toMatchObject({
      ok: true,
      data: {
        tasks: [
          {
            task_id: `n:${M}:n1`,
            task: "Sammanställ offerterna",
            done_when: "En tabell i Driven",
            due: "fredag",
            status: "open",
            can_update: true,
            meeting: { meeting_id: M, title: "Säljmöte", date: "2026-11-26", url: `https://simonsays.test/orgs/${ORG}/mote/${M}` },
            context: { decisions: ["Offerter över 50 000 kr godkänns av VD"], other_notes: ["Kunden vill ha svar före jul"] },
          },
        ],
        next_cursor: null,
      },
    });
    expect(JSON.stringify(r)).not.toContain("Raderad hemlighet");
    expect(JSON.stringify(r)).not.toContain("Boka lokal");
  });
  it("by default only the user's own (meetings they ran); include_others for the rest they see", async () => {
    const { c } = ctx({ startedBy: "u2" });
    expect(((await listAgentTasks(c, {})) as { data: { tasks: unknown[] } }).data.tasks).toEqual([]);
    expect(((await listAgentTasks(c, { include_others: true })) as { data: { tasks: { can_update: boolean }[] } }).data.tasks).toMatchObject([{ can_update: false }]);
  });
  it("filters by status (done ones only on request)", async () => {
    const { c } = ctx({ reader: { agentStatuses: async () => [{ meeting_id: M, item_id: "n1", status: "blocked", note: "Saknar priset", updated_at: "x" }] } });
    expect(((await listAgentTasks(c, { status: "blocked" })) as { data: { tasks: unknown[] } }).data.tasks).toHaveLength(1);
    expect(((await listAgentTasks(c, { status: "done" })) as { data: { tasks: unknown[] } }).data.tasks).toEqual([]);
  });
});

describe("update_agent_task", () => {
  it("progress for the assigner: the status row, never the Doc", async () => {
    const { c, setAgentTask, completeNoteTask } = ctx();
    expect(await updateAgentTask(c, { task_id: `n:${M}:n1`, status: "blocked", note: " Saknar  priset " })).toMatchObject({ ok: true, data: { status: "blocked", note: "Saknar priset" } });
    expect(setAgentTask).toHaveBeenCalledWith(M, "n1", "blocked", "Saknar priset");
    expect(completeNoteTask).not.toHaveBeenCalled();
    expect(c.ids).toEqual({ task_id: `n:${M}:n1`, meeting_id: M, org_id: ORG });
  });
  it("done goes through completeNoteTask (✓ klart in the Doc), then the status", async () => {
    const { c, setAgentTask, completeNoteTask } = ctx();
    expect(await updateAgentTask(c, { task_id: `n:${M}:n1`, status: "done" })).toMatchObject({ ok: true, data: { status: "done", doc: "written" } });
    expect(completeNoteTask).toHaveBeenCalledWith(expect.anything(), "u1", M, "n1");
    expect(setAgentTask).toHaveBeenCalledWith(M, "n1", "done", null);
  });
  it("refuses, and writes nothing, for someone else, a person's task, a meeting not seen or a bad id", async () => {
    const cases: [ReturnType<typeof ctx>, string][] = [
      [ctx({ startedBy: "u2" }), `n:${M}:n1`],
      [ctx(), `n:${M}:n2`],
      [ctx(), `n:${OTHER}:n1`],
      [ctx(), `p:${M}`],
      [ctx({ kind: "privat" }), `n:${M}:n1`],
    ];
    for (const [{ c, setAgentTask, completeNoteTask }, task_id] of cases) {
      expect((await updateAgentTask(c, { task_id, status: "done" })).ok, task_id).toBe(false);
      expect(setAgentTask).not.toHaveBeenCalled();
      expect(completeNoteTask).not.toHaveBeenCalled();
    }
  });
  it("an admin may update it; an overlong note is refused", async () => {
    expect((await updateAgentTask(ctx({ startedBy: "u2", role: "admin" }).c, { task_id: `n:${M}:n1`, status: "in_progress" })).ok).toBe(true);
    expect((await updateAgentTask(ctx().c, { task_id: `n:${M}:n1`, status: "in_progress", note: "x".repeat(501) })).ok).toBe(false);
  });
});

describe("get_org_memory", () => {
  const memory = {
    org_id: ORG,
    lines: [
      { id: "l1", section: "customers", text: "Kårallen hyr ut lokalen", sources: [M], edited: false },
      { id: "l2", section: "priorities", text: "Hemligt projekt", sources: [OTHER], edited: false },
      { id: "l3", section: "glossary", text: "KS = kommunikationsstyrelsen", sources: [], edited: true, addedBy: "Maja Admin" },
      { id: "l4", section: "decisions", text: "kunden vill ha leverans i mars", sources: [M], edited: false, saidIn: M, speaker: "Anna Svensson" },
      { id: "l6", section: "glossary", text: "VD = vd", sources: [], edited: true },
      { id: "l5", section: "decisions", text: "lokalen är bokad", sources: [M], edited: false, saidIn: M },
    ],
    generated_at: "2026-11-27T10:00:00Z",
    sources_from: "2026-10-01T00:00:00Z",
    sources_count: 12,
    updated_at: "2026-11-27T10:00:00Z",
  };
  it("by section, with source links; a line whose source the user can't see is left out", async () => {
    const { c } = ctx({ reader: { orgMemory: async () => memory } });
    const r = await getOrgMemory(c, { org_id: ORG });
    expect(r).toMatchObject({
      ok: true,
      data: {
        built_from: { meetings: 12, since: "2026-10-01" },
        sections: {
          // A line from before attribution: its source meeting's date.
          customers: [{ text: "Sades i mötet 26 nov: Kårallen hyr ut lokalen", statement: "Kårallen hyr ut lokalen", sources: [{ meeting_id: M, date: "2026-11-26", url: `https://simonsays.test/orgs/${ORG}/mote/${M}` }] }],
          priorities: [],
          glossary: [
            { text: "Tillagt av Maja Admin: KS = kommunikationsstyrelsen", added_by: "Maja Admin", sources: [] },
            // Unknown admin: the Swedish sentence says so; the field is null, never an English stand-in.
            { text: "Tillagt av en admin: VD = vd", added_by: null, sources: [] },
          ],
          decisions: [
            // A stored speaker is never shown.
            { text: "Sades i mötet 26 nov: kunden vill ha leverans i mars", said_in: [{ meeting_id: M, date: "2026-11-26", url: `https://simonsays.test/orgs/${ORG}/mote/${M}` }] },
            { text: "Sades i mötet 26 nov: lokalen är bokad", said_in: [{ meeting_id: M, date: "2026-11-26", url: `https://simonsays.test/orgs/${ORG}/mote/${M}` }] },
          ],
        },
      },
    });
    expect(JSON.stringify(r)).not.toContain("Hemligt projekt");
    expect(JSON.stringify(r)).not.toContain("Anna Svensson");
    expect(JSON.stringify(r)).not.toContain("said_by");
  });
  it("refuses an org the user isn't in, and Privat", async () => {
    expect((await getOrgMemory(ctx().c, { org_id: OTHER })).ok).toBe(false);
    expect((await getOrgMemory(ctx({ kind: "privat" }).c, { org_id: ORG })).ok).toBe(false);
  });
  it("says how to build it when there is none", async () => {
    expect(await getOrgMemory(ctx().c, { org_id: ORG })).toMatchObject({ ok: true, data: { note: expect.stringContaining("Uppdatera") } });
  });
});
