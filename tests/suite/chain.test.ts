import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { NoteItemRow } from "@/lib/db/types";
import type { EnvOverride } from "@/test/suite-db";

// Feature 4: information from n meetings. A chain of four meetings in one förening (a false start
// among them): tasks carried week to week under "Från förra veckan", closed with "✓ klart" (done
// flows back to the source), Testmöten never mixed in. The per-meeting counts a dashboard (todo #2)
// would show come from meetingChainSummary.

const envOverride = vi.hoisted(() => ({}) as EnvOverride);
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const base = mod.parseEnv({
    ...testEnv,
    SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL ?? "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: process.env.LOCAL_SUPABASE_ANON_KEY ?? "anon",
    SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? "service",
  });
  return { ...mod, getEnv: () => ({ ...base, ...envOverride }) };
});

const tick = await import("@/lib/meetings/tick");
const { carriedItems, carryPlan, previousMeeting, previousOnDoc, propagateDone } = await import("@/lib/agenda/followup");
const { meetingChainSummary, loadMeetingChainSummary } = await import("@/lib/meetings/summary");
const { FormatSim, block, notesTicks, scriptedClient } = await import("@/test/meeting-sim");
const { fixtureDoc, linesOf } = await import("@/test/formatdoc");
const { itemSpan } = await import("@/lib/docs/notes");
const { parseNotesTab } = await import("@/lib/docs/tab");
const { TAB } = await import("@/test/docsim");
const { VECKOMOTE } = await import("@/lib/formats/standard");
const { createOrg } = await import("@/lib/db/orgs");
const { ensureStandardRow } = await import("@/lib/formats/store");
const db = await import("@/test/suite-db");

const PEOPLE = [
  { name: "Anna Berg", role: "Kassör", id: "p-anna" },
  { name: "Erik Lund", role: null, id: "p-erik" },
  { name: "Maja Holm", role: "Ordförande", id: "p-maja" },
];
const week = (n: number) => new Date(Date.UTC(2026, 10, 4 + 7 * n, 17, 5));

/** propagateDone without the database: done carried rows flip their source row (one hop, as the real one). */
function propagate(store: Map<string, NoteItemRow[]>, rows: NoteItemRow[]) {
  for (const r of rows) {
    if (!r.done || !r.carried_from_meeting || !r.carried_from_id) continue;
    const src = store.get(r.carried_from_meeting)?.find((s) => s.id === r.carried_from_id);
    if (src) src.done = true;
  }
}

/** What the start's prefill carries into `followup` from `prev` (and a false start on the same Doc). */
function carry(prev: { id: string; rows: NoteItemRow[] } | null, sameDoc: { id: string; rows: NoteItemRow[] } | null, doc: ReturnType<typeof fixtureDoc> | null) {
  const plan = carryPlan({ prev, sameDoc, intact: (name) => Boolean(doc && itemSpan(parseNotesTab(doc, TAB), name)) });
  const adopted = plan.adopted.map((r, position) => ({ ...r, anchor: "ag-3", position }));
  const fresh = prev ? carriedItems(prev.id, plan.open, "ag-3", PEOPLE.map((p) => ({ ...p })), "role").map((r, i) => ({ ...r, id: `c${adopted.length + i + 1}` })) : [];
  return [...adopted, ...fresh];
}

const lines = (rows: NoteItemRow[]) => rows.filter((r) => r.anchor === "ag-3").map((r) => `${r.id} ${r.owner}: ${r.text}${r.done ? " ✓" : ""}`);

describe("feature: chain (information from n meetings)", () => {
  it("four meetings: tasks carried week to week, ✓ klart flows back, a false start taken over; per-meeting counts", async () => {
    const store = new Map<string, NoteItemRow[]>();

    // Week 1: two tasks and a decision.
    const m1 = FormatSim.start({
      id: "w1",
      doc: fixtureDoc(),
      profile: VECKOMOTE,
      people: PEOPLE,
      startedAt: week(0),
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg" },
            { op: "add", id: "x2", kind: "task", anchor: "ag-6", text: "Skicka kallelsen", owner: "Erik" },
            { op: "add", id: "x3", kind: "decision", anchor: "ag-5", text: "Medlemsavgiften är 200 kr" },
          ],
        ]),
      },
    });
    await m1.tick(block([{ at: 1000, speaker: 0, text: "Anna bokar Kårallen, Erik skickar kallelsen. Avgiften är 200." }]));
    await m1.tick(null, { final: true });
    store.set("w1", m1.rows);

    // Week 2: both carried; Anna's done, a new task for the ordförande.
    const c2 = carry({ id: "w1", rows: store.get("w1")! }, null, null);
    expect(lines(c2)).toEqual(["c1 Erik: Skicka kallelsen", "c2 Anna Berg: Boka Kårallen"]);
    const m2 = FormatSim.start({
      id: "w2",
      doc: fixtureDoc(),
      profile: VECKOMOTE,
      people: PEOPLE,
      startedAt: week(1),
      carried: c2,
      script: {
        notes: notesTicks([
          [
            { op: "change", id: "c2", done: true },
            { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Beställa tröjor", owner: "ordföranden" },
          ],
        ]),
      },
    });
    expect(linesOf(m2.doc)).toContain("– Erik Lund: Skicka kallelsen.");
    expect(linesOf(m2.doc)).toContain("– Kassör: Boka Kårallen.");
    await m2.tick(block([{ at: 1000, speaker: 0, text: "Kårallen är bokad. Ordföranden beställer tröjor." }]));
    await m2.tick(null, { final: true });
    expect(linesOf(m2.doc)).toContain("– Kassör: Boka Kårallen. ✓ klart");
    store.set("w2", m2.rows);
    propagate(store, m2.rows);
    expect(store.get("w1")!.find((r) => r.id === "n1")!.done).toBe(true);

    // Week 3, a false start: the carried lines are written into the Doc, then it ends at once.
    const doc3 = fixtureDoc();
    const c3 = carry({ id: "w2", rows: store.get("w2")! }, null, doc3);
    expect(lines(c3)).toEqual(["c1 Erik: Skicka kallelsen", "c2 ordföranden: Beställa tröjor"]);
    const falseStart = FormatSim.start({ id: "w3-false", doc: doc3, profile: VECKOMOTE, people: PEOPLE, startedAt: week(2), carried: c3, script: {} });
    await falseStart.tick(null, { final: true });
    store.set("w3-false", falseStart.rows);

    // Week 3, restarted on the same Doc: the false start's lines are taken over, not written twice.
    const c4 = carry({ id: "w3-false", rows: store.get("w3-false")! }, { id: "w3-false", rows: store.get("w3-false")! }, doc3);
    expect(c4.map((r) => [r.id, r.range_name])).toEqual([
      ["c1", "ss-w3-false-c1"],
      ["c2", "ss-w3-false-c2"],
    ]);
    const m3 = FormatSim.start({
      id: "w3",
      doc: doc3,
      profile: VECKOMOTE,
      people: PEOPLE,
      startedAt: new Date(week(2).getTime() + 600_000),
      carried: c4,
      script: { notes: notesTicks([[{ op: "change", id: "c1", done: true }]]) },
    });
    await m3.tick(block([{ at: 1000, speaker: 1, text: "Kallelsen är skickad." }]));
    await m3.tick(null, { final: true });
    expect(linesOf(m3.doc).filter((l) => l.includes("Skicka kallelsen"))).toEqual(["– Erik Lund: Skicka kallelsen. ✓ klart"]);
    store.set("w3", m3.rows);
    propagate(store, m3.rows);

    const meetings = [
      { id: "w1", org_id: "o", started_at: week(0).toISOString(), status: "done" as const },
      { id: "w2", org_id: "o", started_at: week(1).toISOString(), status: "done" as const },
      { id: "w3-false", org_id: "o", started_at: week(2).toISOString(), status: "done" as const },
      { id: "w3", org_id: "o", started_at: new Date(week(2).getTime() + 600_000).toISOString(), status: "done" as const },
      { id: "t1", org_id: "o", started_at: week(1).toISOString(), status: "done" as const, is_test: true },
    ];
    const items = [...store.entries()].flatMap(([, rows]) => rows);
    expect(meetingChainSummary("o", { meetings, items }).map(({ startedAt: _s, ...r }) => r)).toEqual([
      { meetingId: "w1", decisions: 1, tasksOpened: 2, tasksClosed: 0, tasksOpen: 2 },
      { meetingId: "w2", decisions: 0, tasksOpened: 1, tasksClosed: 1, tasksOpen: 2 },
      { meetingId: "w3-false", decisions: 0, tasksOpened: 0, tasksClosed: 0, tasksOpen: 2 },
      { meetingId: "w3", decisions: 0, tasksOpened: 0, tasksClosed: 1, tasksOpen: 1 },
    ]);
  });
});

describe.skipIf(!hasLocalSupabase)("feature: chain (runTick, previousMeeting and propagateDone on the local stack)", () => {
  let starter: TestUser;
  let orgId: string;
  let profileId: string;
  const people = new Map<string, string>();

  beforeAll(async () => {
    starter = await createTestUser("suite-chain");
    const r = await createOrg(starter.db, "Kedjeklubben");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    profileId = await ensureStandardRow(orgId, "veckomote");
    const { data, error } = await adminClient()
      .from("people")
      .insert(PEOPLE.map((p) => ({ org_id: orgId, name: p.name, role: p.role })))
      .select("id, name");
    if (error) throw new Error(error.message);
    for (const p of data ?? []) people.set(p.name as string, p.id as string);
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  /** One meeting: prefill as the start does (previousMeeting, previousOnDoc, carryPlan), ticks, end. */
  async function run(opts: { at: Date; ops: object[][]; isTest?: boolean; docId?: string; doc?: ReturnType<typeof fixtureDoc>; endAtOnce?: boolean }) {
    const isTest = opts.isTest ?? false;
    const prev = await previousMeeting(orgId, isTest, opts.at, adminClient(), true);
    const docId = opts.docId ?? `doc-${randomUUID()}`;
    const onDoc = await previousOnDoc(orgId, isTest, docId, opts.at, adminClient());
    const rowsOf = async (id: string) => db.noteRows(id);
    const doc = opts.doc ?? fixtureDoc();
    const sameDoc = onDoc ? { id: onDoc.id, rows: await rowsOf(onDoc.id) } : null;
    const plan = carryPlan({
      prev: prev ? { id: prev.id, rows: await rowsOf(prev.id) } : null,
      sameDoc,
      intact: (name) => Boolean(itemSpan(parseNotesTab(doc, TAB), name)),
    });
    const ppl = [...people.entries()].map(([name, id]) => ({ id, name, role: PEOPLE.find((p) => p.name === name)!.role }));
    const adopted = plan.adopted.map((r, position) => ({ ...r, anchor: "ag-3", position }));
    const fresh = prev ? carriedItems(prev.id, plan.open, "ag-3", ppl, "role").map((r, i) => ({ ...r, id: `c${adopted.length + i + 1}` })) : [];
    // Adopted lines are in the Doc already: saved as they are, not rendered again.
    const m = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId, isTest, startedAt: opts.at, doc, docId, prerender: fresh });
    if (adopted.length) {
      const { error } = await adminClient().from("note_items").insert(adopted.map((r) => ({ ...r, meeting_id: m.id })));
      if (error) throw new Error(error.message);
    }
    const { client } = scriptedClient({ notes: notesTicks(opts.ops as never) });
    const f = db.docsimDeps(m.doc, client);
    if (!opts.endAtOnce) {
      await db.say(m.id, m.sessionId, "speaker_0", "Vi går igenom veckan.", 1000);
      expect(await tick.runTick(m.id, { final: false }, f.deps)).toBe("ok");
    }
    await adminClient().from("meetings").update({ status: "ending", ended_at: new Date(opts.at.getTime() + 3600_000).toISOString() }).eq("id", m.id);
    expect(await tick.runTick(m.id, { final: true }, f.deps)).toBe("ok");
    await db.finish(m.id);
    return { id: m.id, doc: m.doc, docId };
  }

  it("four real meetings and a Testmöte: carried, closed at the source (one hop), never mixed; loadMeetingChainSummary", async () => {
    const w1 = await run({
      at: week(10),
      ops: [
        [
          { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg" },
          { op: "add", id: "x2", kind: "task", anchor: "ag-6", text: "Skicka kallelsen", owner: "Erik" },
          { op: "add", id: "x3", kind: "decision", anchor: "ag-5", text: "Medlemsavgiften är 200 kr" },
        ],
      ],
    });
    // A Testmöte in between: never carried from, never carries into real meetings.
    const t1 = await run({ at: new Date(week(10).getTime() + 3600_000), isTest: true, ops: [[{ op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Fiktiv uppgift", owner: "Maja Holm" }]] });
    const w2 = await run({
      at: week(11),
      ops: [
        [
          { op: "change", id: "c2", done: true },
          { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Beställa tröjor", owner: "ordföranden" },
        ],
      ],
    });
    const w2rows = await db.noteRows(w2.id);
    expect(w2rows.filter((r) => r.carried_from_meeting).map((r) => [r.id, r.carried_from_meeting, r.text, r.done])).toEqual([
      ["c1", w1.id, "Skicka kallelsen", false],
      ["c2", w1.id, "Boka Kårallen", true],
    ]);
    expect((await db.noteRows(w1.id)).find((r) => r.id === "n1")?.done).toBe(true);
    expect((await db.noteRows(t1.id)).find((r) => r.id === "n1")?.done).toBe(false);

    // A false start on the week-3 Doc, then the restart on the same Doc takes its lines over.
    const doc3 = fixtureDoc();
    const docId3 = `doc-${randomUUID()}`;
    const f3 = await run({ at: week(12), ops: [], doc: doc3, docId: docId3, endAtOnce: true });
    const w3 = await run({ at: new Date(week(12).getTime() + 600_000), ops: [[{ op: "change", id: "c1", done: true }]], doc: f3.doc, docId: docId3 });
    expect(linesOf(f3.doc).filter((l) => l.includes("Skicka kallelsen"))).toEqual(["– Erik Lund: Skicka kallelsen. ✓ klart"]);
    const w3rows = await db.noteRows(w3.id);
    expect(w3rows.find((r) => r.id === "c1")).toMatchObject({ done: true, carried_from_meeting: w2.id, range_name: `ss-${f3.id}-c1` });
    // One hop: the week-2 row is closed, the week-1 original stays open (finding for the dashboard).
    expect((await db.noteRows(w2.id)).find((r) => r.id === "c1")?.done).toBe(true);
    expect((await db.noteRows(w1.id)).find((r) => r.id === "n2")?.done).toBe(false);

    const summary = await loadMeetingChainSummary(adminClient(), orgId);
    expect(summary.map(({ startedAt: _s, ...r }) => r)).toEqual([
      { meetingId: w1.id, decisions: 1, tasksOpened: 2, tasksClosed: 0, tasksOpen: 2 },
      { meetingId: w2.id, decisions: 0, tasksOpened: 1, tasksClosed: 1, tasksOpen: 2 },
      { meetingId: f3.id, decisions: 0, tasksOpened: 0, tasksClosed: 0, tasksOpen: 2 },
      { meetingId: w3.id, decisions: 0, tasksOpened: 0, tasksClosed: 1, tasksOpen: 1 },
    ]);
    expect((await loadMeetingChainSummary(adminClient(), orgId, { isTest: true })).map((r) => r.meetingId)).toEqual([t1.id]);
  });
});
