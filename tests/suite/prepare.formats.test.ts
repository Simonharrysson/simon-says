import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { docs_v1 } from "@googleapis/docs";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { NoteItemRow } from "@/lib/db/types";
import type { EnvOverride } from "@/test/suite-db";

// Förbered möte (todo #6), end to end: "Från förra veckan" proven through a prepared agenda.
// Meeting 1 leaves open tasks → the ordförande prepares meeting 2 (Simon Says writes the agenda
// Doc: standing items, the open tasks under "Från förra veckan" rendered by the notes engine, plus
// an item only the ordförande knows) → meeting 2 starts in that Doc and adopts those lines (never
// written twice) → it marks one "✓ klart" in the same line → done flows back to meeting 1.
// The planners are the ones the prepare route runs (lib/prepare/doc.ts) and the carry planner is
// the start's own (carriedForMeeting).

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
const { carriedForMeeting, carriedItems, openTasks, previousMeetingOfKinds } = await import("@/lib/agenda/followup");
const { FormatSim, block, notesTicks, scriptedClient } = await import("@/test/meeting-sim");
const { applyDoc, fixtureDoc, linesOf } = await import("@/test/formatdoc");
const { itemSpan } = await import("@/lib/docs/notes");
const { parseNotesTab } = await import("@/lib/docs/tab");
const { skeletonRequests, skeletonTableFill } = await import("@/lib/docs/skeleton");
const { skeletonBlocks } = await import("@/lib/formats/skeleton");
const { docOf, paraEl, TAB } = await import("@/test/docsim");
const { VECKOMOTE } = await import("@/lib/formats/standard");
const { buildDraft, droppedSources, kindsOfType } = await import("@/lib/prepare/draft");
const { followupKey, planCarried, planItemRanges, prepKey, prepMeeting } = await import("@/lib/prepare/doc");
const { createOrg } = await import("@/lib/db/orgs");
const { ensureStandardRow } = await import("@/lib/formats/store");
const { ownerLabel, resolveOwner } = await import("@/lib/people/roles");
const db = await import("@/test/suite-db");

type Doc = docs_v1.Schema$Document;
type DraftItem = import("@/lib/prepare/draft").DraftItem;

const PEOPLE = [
  { name: "Anna Berg", role: "Kassör", id: "p-anna" },
  { name: "Erik Lund", role: null, id: "p-erik" },
  { name: "Maja Holm", role: "Ordförande", id: "p-maja" },
];
const label = (people: { id: string; name: string; role: string | null }[]) => (o: string) => ownerLabel(resolveOwner(o, people), o, "role");
const week = (n: number) => new Date(Date.UTC(2026, 10, 4 + 7 * n, 17, 5));
const FEST: DraftItem = { id: "add:fest", label: "Fest på universitetet", role: "topic", source: "added", on: true };

/**
 * "Skapa dagordning" as the prepare route runs it, on a docsim Doc: the skeleton (createFormatDoc's
 * batches), our item ranges, then the carried lines by the notes engine. Returns the Doc, the
 * prepared agenda's stored rows and its id.
 */
function prepare(prev: { id: string; rows: NoteItemRow[] }, people: { id: string; name: string; role: string | null }[], extra: DraftItem[]) {
  const id = randomUUID();
  const key = prepKey(id);
  const carried = carriedItems(prev.id, openTasks(prev.rows), "followup", people, "role");
  const draft = buildDraft({ profile: VECKOMOTE, carried, ctx: { profile: VECKOMOTE, ownerLabel: label(people) }, topics: [] });
  // The ordförande adds what Simon Says can't know, before Övrigt.
  const items = [...draft.slice(0, -1), ...extra, draft.at(-1)!];
  const doc: Doc = docOf([paraEl("")]);
  const blocks = skeletonBlocks(VECKOMOTE, { items: items.filter((i) => i.on).map((i) => ({ label: i.label })) });
  applyDoc(doc, skeletonRequests(TAB, blocks, VECKOMOTE.numbering));
  applyDoc(doc, skeletonTableFill(parseNotesTab(doc, TAB), blocks));
  const ranged = planItemRanges(parseNotesTab(doc, TAB), VECKOMOTE, key, items);
  applyDoc(doc, ranged.requests);
  const tab = parseNotesTab(doc, TAB);
  const fk = followupKey(tab, ranged.lines, items)!;
  const { plan, rows } = planCarried(tab, prepMeeting(key, "doc", TAB, ranged.lines, items), [], carried.map((r) => ({ ...r, anchor: fk })), {
    profile: VECKOMOTE,
    ownerLabel: label(people),
    rewritten: false,
  });
  applyDoc(doc, plan.requests);
  return { doc, key, rows, items, dropped: droppedSources(items) };
}

/** What the start's pre-fill saves for a meeting in the prepared Doc (no earlier meeting on it). */
function startCarry(meetingId: string, prev: { id: string; rows: NoteItemRow[] }, p: ReturnType<typeof prepare>, people: { id: string; name: string; role: string | null }[]) {
  const tab = parseNotesTab(p.doc, TAB);
  return carriedForMeeting({
    meetingId,
    prev,
    sameDoc: { id: p.key, rows: p.rows },
    intact: (name) => Boolean(itemSpan(tab, name)),
    excluded: new Set(p.dropped.map((s) => s.replace(":", "\u0000"))),
    followup: "ag-3",
    people,
    groupBy: "role",
  });
}

const agendaOf = (doc: Doc) => {
  const lines = linesOf(doc);
  return lines.slice(lines.indexOf("Agenda"), lines.indexOf("Vad ska vi göra till nästa gång?"));
};

describe("feature: formats (Förbered möte: Från förra veckan through a prepared agenda)", () => {
  it("meeting 1's open tasks are in the prepared Doc under Från förra veckan; meeting 2 adopts them and ✓ klart flows back", async () => {
    // Meeting 1: two tasks, a decision.
    const m1 = FormatSim.start({
      id: "w1",
      doc: fixtureDoc(),
      profile: VECKOMOTE,
      people: PEOPLE,
      startedAt: week(0),
      script: {
        notes: notesTicks([
          [
            { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg", due: "fredag" },
            { op: "add", id: "x2", kind: "task", anchor: "ag-6", text: "Skicka kallelsen", owner: "Erik" },
            { op: "add", id: "x3", kind: "decision", anchor: "ag-5", text: "Medlemsavgiften är 200 kr" },
          ],
        ]),
      },
    });
    await m1.tick(block([{ at: 1000, speaker: 0, text: "Anna bokar Kårallen till fredag, Erik skickar kallelsen. Avgiften är 200." }]));
    await m1.tick(null, { final: true });

    // Prepare meeting 2: the Doc lists last week's open tasks, per role/person, and the party.
    const prev = { id: "w1", rows: m1.rows };
    const p = prepare(prev, PEOPLE, [FEST]);
    expect(agendaOf(p.doc)).toEqual([
      "Agenda",
      "Godkänn dagordning",
      "Må-runda",
      "Från förra veckan",
      "– Erik Lund: Skicka kallelsen.",
      "– Kassör: Boka Kårallen (fredag).",
      "Fest på universitetet",
      "Övrigt",
    ]);

    // Meeting 2 starts in the prepared Doc: the lines are adopted (same ranges), not written again.
    const carried = startCarry("w2", prev, p, PEOPLE);
    expect(carried.map((r) => [r.id, r.range_name, r.carried_from_meeting, r.carried_from_id])).toEqual([
      ["c1", `ss-${p.key}-c1`, "w1", "n2"],
      ["c2", `ss-${p.key}-c2`, "w1", "n1"],
    ]);
    const m2 = FormatSim.start({
      id: "w2",
      doc: p.doc,
      profile: VECKOMOTE,
      people: PEOPLE,
      startedAt: week(1),
      carried,
      script: {
        notes: notesTicks([
          [
            { op: "change", id: "c2", done: true },
            { op: "add", id: "x1", kind: "decision", anchor: "ag-4", text: "Festen hålls fredag 12 december" },
          ],
        ]),
      },
    });
    expect(m2.meeting.agenda_roles?.["ag-3"]).toBe("followup");
    expect(linesOf(m2.doc).filter((l) => l.includes("Boka Kårallen"))).toEqual(["– Kassör: Boka Kårallen (fredag)."]);
    await m2.tick(block([{ at: 1000, speaker: 0, text: "Kårallen är bokad. Festen blir fredag den tolfte." }]));
    await m2.tick(null, { final: true });

    // "✓ klart" in the prepared line itself, the party's decision under its own item.
    expect(agendaOf(m2.doc)).toEqual([
      "Agenda",
      "Godkänn dagordning",
      "Må-runda",
      "Från förra veckan",
      "– Erik Lund: Skicka kallelsen.",
      "– Kassör: Boka Kårallen (fredag). ✓ klart",
      "Fest på universitetet",
      "– Beslut: Festen hålls fredag 12 december.",
      "Övrigt",
    ]);
    const done = m2.rows.find((r) => r.id === "c2")!;
    expect(done).toMatchObject({ done: true, carried_from_meeting: "w1", carried_from_id: "n1" });
  });

  it("a task the ordförande unticks, or deletes from the prepared Doc, is not carried at the start", () => {
    const rows1 = [
      { meeting_id: "w1", id: "n1", section: "action", kind: "task", text: "Boka Kårallen", owner: "Anna Berg", due: null, done: false, locked: false, deleted_by_human: false, position: 0 },
      { meeting_id: "w1", id: "n2", section: "action", kind: "task", text: "Skicka kallelsen", owner: "Erik", due: null, done: false, locked: false, deleted_by_human: false, position: 1 },
    ] as NoteItemRow[];
    const prev = { id: "w1", rows: rows1 };
    const p = prepare(prev, PEOPLE, []);
    // A human deletes the Erik line in the Doc before the meeting.
    const erik = parseNotesTab(p.doc, TAB).paragraphs.find((x) => x.text.startsWith("– Erik"))!;
    applyDoc(p.doc, [{ deleteContentRange: { range: { tabId: TAB, startIndex: erik.start, endIndex: erik.end } } }]);
    const tab = parseNotesTab(p.doc, TAB);
    const gone = new Set(p.rows.filter((r) => !r.range_name || !itemSpan(tab, r.range_name)).map((r) => `${r.carried_from_meeting}\u0000${r.carried_from_id}`));
    const carried = carriedForMeeting({
      meetingId: "w2",
      prev,
      sameDoc: { id: p.key, rows: p.rows },
      intact: (name) => Boolean(itemSpan(tab, name)),
      excluded: gone,
      followup: "ag-3",
      people: PEOPLE,
      groupBy: "role",
    });
    expect(carried.map((r) => [r.carried_from_id, r.range_name])).toEqual([["n1", `ss-${p.key}-c2`]]);
  });
});

describe.skipIf(!hasLocalSupabase)("feature: formats (Förbered möte on the local stack: previous meeting of the kind, runTick, propagateDone)", () => {
  let starter: TestUser;
  let orgId: string;
  let profileId: string;
  let people: { id: string; name: string; role: string | null }[] = [];

  beforeAll(async () => {
    starter = await createTestUser("suite-prepare");
    const r = await createOrg(starter.db, "Förberedda klubben");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    // Lines pinned without the concrete-tasks placeholders (tests/suite/tasks.test.ts covers those).
    await adminClient().from("orgs").update({ require_task_fields: false }).eq("id", orgId);
    profileId = await ensureStandardRow(orgId, "veckomote");
    const { data, error } = await adminClient()
      .from("people")
      .insert(PEOPLE.map((p) => ({ org_id: orgId, name: p.name, role: p.role })))
      .select("id, name, role");
    if (error) throw new Error(error.message);
    people = (data ?? []) as typeof people;
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  /** One meeting on `doc` (anchored as the start does), `carried` saved as the pre-fill saves them; ticks; final; done. */
  async function run(opts: { at: Date; ops: object[][]; doc?: Doc; carried?: NoteItemRow[]; roles?: Record<string, "procedural" | "followup" | "topic" | "other"> }) {
    const adopted = (opts.carried ?? []).filter((r) => r.range_name);
    const fresh = (opts.carried ?? []).filter((r) => !r.range_name);
    const m = await db.insertFormatMeeting({ orgId, starterId: starter.id, profileId, startedAt: opts.at, doc: opts.doc ?? fixtureDoc(), docId: `doc-${randomUUID()}`, prerender: fresh, roles: opts.roles });
    if (adopted.length) {
      const { error } = await adminClient().from("note_items").insert(adopted.map((r) => ({ ...r, meeting_id: m.id })));
      if (error) throw new Error(error.message);
    }
    const { client } = scriptedClient({ notes: notesTicks(opts.ops as never) });
    const f = db.docsimDeps(m.doc, client);
    await db.say(m.id, m.sessionId, "speaker_0", "Vi går igenom veckan.", 1000);
    expect(await tick.runTick(m.id, { final: false }, f.deps)).toBe("ok");
    await adminClient().from("meetings").update({ status: "ending", ended_at: new Date(opts.at.getTime() + 3600_000).toISOString() }).eq("id", m.id);
    expect(await tick.runTick(m.id, { final: true }, f.deps)).toBe("ok");
    await db.finish(m.id);
    return m;
  }

  it("meeting 1 → prepare (previous Veckomöte) → meeting 2 in the prepared Doc closes a task → done at the source", async () => {
    const w1 = await run({
      at: week(20),
      ops: [
        [
          { op: "add", id: "x1", kind: "task", anchor: "ag-4", text: "Boka Kårallen", owner: "Anna Berg" },
          { op: "add", id: "x2", kind: "task", anchor: "ag-6", text: "Skicka kallelsen", owner: "Erik" },
        ],
      ],
    });
    const at2 = week(21);
    const prevMeeting = await previousMeetingOfKinds(orgId, at2, kindsOfType("veckomote"), adminClient());
    expect(prevMeeting?.id).toBe(w1.id);
    const prev = { id: w1.id, rows: await db.noteRows(w1.id) };
    const p = prepare(prev, people, [FEST]);
    expect(agendaOf(p.doc)).toContain("– Kassör: Boka Kårallen.");

    const carried = startCarry(randomUUID(), prev, p, people);
    expect(carried.every((r) => r.range_name?.startsWith(`ss-${p.key}-`))).toBe(true);
    const kar = carried.find((r) => r.text === "Boka Kårallen")!;
    // The prepared Doc's five items (the start matches roles; here given as the prepare wrote them).
    const roles = { "ag-1": "procedural", "ag-2": "procedural", "ag-3": "followup", "ag-4": "topic", "ag-5": "other" } as const;
    const w2 = await run({ at: at2, doc: p.doc, carried, roles, ops: [[{ op: "change", id: kar.id, done: true }]] });
    expect(linesOf(w2.doc).filter((l) => l.includes("Boka Kårallen"))).toEqual(["– Kassör: Boka Kårallen. ✓ klart"]);
    expect((await db.noteRows(w2.id)).find((r) => r.id === kar.id)).toMatchObject({ done: true, carried_from_meeting: w1.id });
    // propagateDone (in the final tick): the source task in meeting 1 is closed.
    expect((await db.noteRows(w1.id)).find((r) => r.id === kar.carried_from_id)?.done).toBe(true);
    expect((await db.noteRows(w1.id)).find((r) => r.text === "Skicka kallelsen")?.done).toBe(false);
  });
});
