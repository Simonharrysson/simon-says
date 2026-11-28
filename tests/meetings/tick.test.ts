import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuth2Client } from "google-auth-library";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { MeetingRow, NoteItemRow } from "@/lib/db/types";
import type { NotesTab, RenderResult } from "@/lib/docs/notes";
import type { TranscriptLine } from "@/lib/docs/transcript";
import type { UpdateNotesInput, UpdateNotesResult } from "@/lib/notes/engine";
import type { NotesItem } from "@/lib/notes/schema";
import type { docs_v1 } from "@googleapis/docs";
import { TAB } from "@/test/docsim";
import { anchoredDoc, applyDoc, docText, FMT_ENDED, FMT_STARTED, fmtMeeting, insertItemBeforeOvrigt, linesOf, renderInto, ROLES } from "@/test/formatdoc";

// after() needs a Next request scope: record the scheduled work and run it in the test.
const scheduled = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void scheduled.push(fn),
}));
const current = vi.hoisted(() => ({ db: null as import("@supabase/supabase-js").SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => current.db }));

type EnvOverride = { KILL_SWITCH?: boolean; GLOBAL_DAILY_HOURS?: number; GLOBAL_DAILY_USD?: number };
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
const { renderedRows, itemRangeName, itemSpan } = await import("@/lib/docs/notes");
const { withoutOwnLines: withoutOwn } = await import("@/lib/docs/format-render");
const { GoogleAuthLostError } = await import("@/lib/google/client");
const { ingestSegments } = await import("@/lib/segments/ingest");
const { createOrg } = await import("@/lib/db/orgs");
const { POST: postEnd } = await import("@/app/api/meetings/[id]/end/route");
const { GET: getFinalize } = await import("@/app/api/cron/finalize/route");
const { NextRequest } = await import("next/server");
const { planFormatRender } = await import("@/lib/docs/format-render");
const { parseNotesTab } = await import("@/lib/docs/tab");
const { planAnchoring, INITIAL_LIVE_LINE } = await import("@/lib/agenda/anchor");
const { scanAgenda, newAgendaItems, adoptedAgendaRanges } = await import("@/lib/agenda/scan");
const { VECKOMOTE } = await import("@/lib/formats/standard");
const { meetingRoles } = await import("@/lib/formats/schema");
const { buildRequest, anchorRoles } = await import("@/lib/notes/engine");
const { CHECKIN_PLACEHOLDER } = await import("@/lib/notes/checkin");
const { ensureStandardRow } = await import("@/lib/formats/store");

// ---------------------------------------------------------------------------------------------
// Pure parts (run everywhere)

const seg = (over: Partial<import("@/lib/meetings/tick").SegmentRead>): import("@/lib/meetings/tick").SegmentRead => ({
  el_session_id: "sess-a",
  segment_index: 0,
  run_index: 0,
  speaker: "speaker_0",
  text: "hej",
  start_ms: 0,
  tick_no: 1,
  transcript_written_at: null,
  ...over,
});

/** A notes tab where each row is one paragraph covered exactly by its named range. */
function tabOf(
  meetingId: string,
  rows: Pick<NoteItemRow, "id" | "range_name" | "last_rendered_text">[],
  opts: { revisionId?: string; text?: Record<string, string | null>; shrink?: string[] } = {},
): NotesTab {
  const paragraphs: NotesTab["paragraphs"] = [];
  const ranges: NotesTab["ranges"] = new Map();
  let at = 1;
  const push = (text: string, name?: string, shrink = false) => {
    paragraphs.push({ start: at, end: at + text.length + 1, text: `${text}\n`, suggested: false });
    if (name) ranges.set(name, [[{ start: at, end: at + text.length - (shrink ? 1 : 0) }]]);
    at += text.length + 1;
  };
  push("LIVE · uppdaterad –", `ss-${meetingId}-header`);
  for (const r of rows) {
    const t = opts.text && r.id in opts.text ? opts.text[r.id] : r.last_rendered_text;
    if (t === null) continue; // range and paragraph deleted
    push(t ?? "", r.range_name ?? undefined, opts.shrink?.includes(r.id));
  }
  return { revisionId: opts.revisionId ?? "rev", tabId: "t.notes", paragraphs, ranges };
}

const row = (over: Partial<NoteItemRow> & { id: string }): NoteItemRow => ({
  meeting_id: "m",
  section: "decision",
  text: `text ${over.id}`,
  owner: null,
  due: null,
  locked: false,
  deleted_by_human: false,
  last_rendered_text: `✓ text ${over.id}`,
  range_name: `ss-m-${over.id}`,
  position: 0,
  ...over,
});

describe("headers and time", () => {
  it("formats Europe/Stockholm HH:mm in winter and summer", () => {
    expect(tick.stockholmTime(new Date("2026-11-24T13:05:00Z"))).toBe("14:05");
    expect(tick.stockholmTime(new Date("2026-07-01T22:30:00Z"))).toBe("00:30");
  });
  it("live and ended header lines", () => {
    expect(tick.liveHeader(new Date("2026-11-24T13:05:00Z"))).toBe("LIVE · uppdaterad 14:05");
    expect(tick.endedHeader(new Date("2026-11-24T15:59:00Z"))).toBe("Avslutat 16:59");
  });
  it("format layout header lines (the status line in the notes section)", () => {
    expect(tick.liveHeader(new Date("2026-11-25T17:05:00Z"), "format")).toBe("Simon Says antecknar live · uppdaterad 18:05");
    expect(tick.endedHeader(new Date("2026-11-25T18:10:00Z"), "format")).toBe("Simon Says · avslutat 19:10");
    expect(tick.liveHeader(new Date("2026-11-25T17:05:00Z"), "v1")).toBe("LIVE · uppdaterad 18:05");
  });
  it("tickDue: 45 s target", () => {
    const now = new Date("2026-11-24T12:00:45Z");
    expect(tick.tickDue(null, now)).toBe(true);
    expect(tick.tickDue("2026-11-24T12:00:00Z", now)).toBe(true);
    expect(tick.tickDue("2026-11-24T12:00:01Z", now)).toBe(false);
  });
});

describe("buildTranscript", () => {
  const sessions = [
    { id: "sess-b", started_at: "2026-11-24T12:10:00Z" },
    { id: "sess-a", started_at: "2026-11-24T12:00:00Z" },
  ];
  it("one block per tick, raw S<n>-<label> lines in a fixed order", () => {
    const { blocks } = tick.buildTranscript(
      [
        seg({ tick_no: 2, el_session_id: "sess-b", start_ms: 700_000, text: "andra" }),
        seg({ tick_no: 1, start_ms: 2000, segment_index: 1, speaker: "speaker_1", text: "två" }),
        seg({ tick_no: 1, start_ms: 1000, text: "ett\nrad" }),
      ],
      sessions,
      [],
    );
    expect(blocks).toEqual([
      "[00:00:01] S1-speaker_0: ett rad\n[00:00:02] S1-speaker_1: två",
      "[00:11:40] S2-speaker_0: andra",
    ]);
  });
  it("a late segment joins the next block; earlier blocks stay byte-identical", () => {
    const first = tick.buildTranscript([seg({ start_ms: 5000 })], sessions, []).blocks;
    const later = tick.buildTranscript(
      [seg({ start_ms: 5000 }), seg({ tick_no: 2, start_ms: 1000, segment_index: 9, text: "sent" })],
      sessions,
      [],
    ).blocks;
    expect(later[0]).toBe(first[0]);
    expect(later[1]).toBe("[00:00:01] S1-speaker_0: sent");
  });
  it("names come through merges; blocks keep the raw label", () => {
    const speakers = [
      { el_session_id: "sess-a", speaker_label: "speaker_1", display_name: "speaker_1", merged_into_label: "speaker_0" },
      { el_session_id: "sess-a", speaker_label: "speaker_0", display_name: "Anna", person_id: null },
    ];
    const out = tick.buildTranscript(
      [seg({}), seg({ speaker: "speaker_1", segment_index: 1, start_ms: 10 }), seg({ speaker: "speaker_2", segment_index: 2, start_ms: 20 })],
      sessions,
      speakers,
    );
    expect(out.blocks[0]).toContain("S1-speaker_1: hej");
    expect(out.speakerNames).toEqual({ "S1-speaker_0": "Anna", "S1-speaker_1": "Anna" });
    const lines = tick.transcriptLines(
      [seg({}), seg({ speaker: "speaker_1", segment_index: 1, start_ms: 10 }), seg({ speaker: "speaker_2", segment_index: 2, start_ms: 20 })],
      sessions,
      speakers,
    );
    expect(lines.map((l) => l.speaker)).toEqual(["Anna", "Anna", "S1-speaker_2"]);
  });
  it("transcriptLines: only unwritten, assigned segments", () => {
    const lines = tick.transcriptLines(
      [seg({ transcript_written_at: "2026-11-24T12:00:00Z" }), seg({ segment_index: 1, start_ms: 3000, text: "ny" })],
      sessions,
      [],
    );
    expect(lines).toEqual([{ speaker: "S1-speaker_0", atMs: 3000, text: "ny" }]);
  });
});

describe("blocksForCall", () => {
  it("never more than 20 new blocks after the last sent one", () => {
    const blocks = Array.from({ length: 30 }, (_, i) => `b${i + 1}`);
    expect(tick.blocksForCall(blocks, 0)).toHaveLength(20);
    expect(tick.blocksForCall(blocks, 5)).toHaveLength(25);
    expect(tick.blocksForCall(blocks, 28)).toHaveLength(30);
  });
});

describe("retireFrozenNow (Ruling 17)", () => {
  it("drops a 'now' row whose range no longer covers its whole line, keeps the rest", () => {
    const rows = [row({ id: "n1" }), row({ id: "n2", section: "now", last_rendered_text: "Budget" })];
    expect(tick.retireFrozenNow(tabOf("m", rows), rows).map((r) => r.id)).toEqual(["n1", "n2"]);
    expect(tick.retireFrozenNow(tabOf("m", rows, { shrink: ["n2"] }), rows).map((r) => r.id)).toEqual(["n1"]);
    // Only "now" rows are retired: a shrunk decision stays (the render guard skips it).
    expect(tick.retireFrozenNow(tabOf("m", rows, { shrink: ["n1"] }), rows).map((r) => r.id)).toEqual(["n1", "n2"]);
  });
});

describe("readState + desiredItems", () => {
  it("drops Claude's version of an item a human locked or deleted since, keeps the human's", () => {
    const rows = [row({ id: "n1" }), row({ id: "n2" }), row({ id: "n3" })];
    const claude: NotesItem[] = [
      { id: "n1", section: "decision", text: "claude n1" },
      { id: "n2", section: "decision", text: "claude n2" },
      { id: "n3", section: "decision", text: "claude n3" },
      { id: "n4", section: "action", text: "ny" },
    ];
    const st = tick.readState(tabOf("m", rows, { text: { n1: "✓ människa", n2: null } }), rows);
    expect(st.diff.locked.map((i) => i.id)).toEqual(["n1"]);
    expect(st.diff.deletedIds).toEqual(["n2"]);
    expect(tick.desiredItems(claude, st.diff)).toEqual([
      { id: "n3", section: "decision", text: "claude n3" },
      { id: "n4", section: "action", text: "ny" },
      { id: "n1", section: "decision", text: "✓ människa" },
    ]);
  });
});

describe("cron route", () => {
  it("401 without the cron secret", async () => {
    expect((await getFinalize(new Request("https://x.test/api/cron/finalize"))).status).toBe(401);
    const wrong = new Request("https://x.test/api/cron/finalize", { headers: { authorization: "Bearer nope" } });
    expect((await getFinalize(wrong)).status).toBe(401);
  });
});


// ---------------------------------------------------------------------------------------------
// Format layout (A12): pure parts on the A1 agenda fixture, through the Docs simulator

type Doc = docs_v1.Schema$Document;
type Req = docs_v1.Schema$Request;
type MeetingInput = Parameters<typeof tick.agendaContext>[2];

describe("format layout: transcript masking (Må-runda)", () => {
  const sessions = [{ id: "sess-a", started_at: "2026-11-25T17:05:00Z" }];
  const tick1 = [
    seg({ start_ms: 1000, segment_index: 0, text: "Hej allihop" }),
    seg({ start_ms: 2000, segment_index: 1, text: "Jag mår bra idag" }),
    seg({ start_ms: 3000, segment_index: 2, text: "Lite trött" }),
  ];
  const tick2 = [
    seg({ tick_no: 2, start_ms: 4000, segment_index: 3, text: "Jag har sovit dåligt" }),
    seg({ tick_no: 2, start_ms: 5000, segment_index: 4, text: "Nu tar vi förra veckan" }),
  ];
  const tick3 = [seg({ tick_no: 3, start_ms: 6000, segment_index: 5, text: "Mejlet är skickat" })];
  const all = [...tick1, ...tick2, ...tick3];

  it("no window: exactly v1's blocks", () => {
    expect(tick.buildTranscript(all, sessions, [], null)).toEqual(tick.buildTranscript(all, sessions, []));
    expect(tick.buildTranscript(all, sessions, [], { startMs: null, endMs: null, closed: false, failures: 0 })).toEqual(
      tick.buildTranscript(all, sessions, []),
    );
  });

  it("an open window masks from its start: one placeholder per run, no Må-runda line", () => {
    const open = { startMs: 2000, endMs: null, closed: false, failures: 0 };
    const { blocks } = tick.buildTranscript(tick1, sessions, [], open);
    expect(blocks).toEqual([`[00:00:01] S1-speaker_0: Hej allihop\n[00:00:02] –: ${CHECKIN_PLACEHOLDER}`]);
    expect(blocks.join("\n")).not.toMatch(/mår bra|trött/);
  });

  it("0069: the citable lines are the real ones per block, never a Må-runda placeholder", () => {
    const open = { startMs: 2000, endMs: null, closed: false, failures: 0 };
    const { blocks, sources } = tick.buildTranscript(tick1, sessions, [], open);
    expect(sources).toHaveLength(blocks.length);
    expect(sources[0].map((s) => s.startMs)).toEqual([1000]);
    expect(tick.buildTranscript(tick1, sessions, []).sources[0].length).toBe(tick1.length);
  });

  it("a block keeps its bytes after the window closes; a tick wholly inside it still gets a block", () => {
    const open = { startMs: 2000, endMs: null, closed: false, failures: 0 };
    const closed = { startMs: 2000, endMs: 5000, closed: true, failures: 0 };
    const t1 = tick.buildTranscript(tick1, sessions, [], open).blocks;
    const t3 = tick.buildTranscript(all, sessions, [], closed).blocks;
    expect(t3[0]).toBe(t1[0]);
    expect(t3[1]).toBe(`[00:00:04] –: ${CHECKIN_PLACEHOLDER}\n[00:00:05] S1-speaker_0: Nu tar vi förra veckan`);
    expect(t3[2]).toBe("[00:00:06] S1-speaker_0: Mejlet är skickat");
    // Tick 2 wholly inside a still open window: a block of its own (only the placeholder).
    const inside = tick.buildTranscript([...tick1, ...tick2], sessions, [], open).blocks;
    expect(inside).toHaveLength(2);
    expect(inside[1]).toBe(`[00:00:04] –: ${CHECKIN_PLACEHOLDER}`);
  });

  it("checkinSpan: the first time is raised above every earlier tick's segment (late segments)", () => {
    expect(tick.checkinSpan(tick2, tick1)).toEqual({ firstMs: 4000, lastMs: 5000 });
    const late = [seg({ tick_no: 2, start_ms: 1500, segment_index: 9 }), ...tick2];
    expect(tick.checkinSpan(late, tick1)).toEqual({ firstMs: 3001, lastMs: 5000 });
    expect(tick.checkinSpan(tick1, [])).toEqual({ firstMs: 1000, lastMs: 3000 });
  });
});

describe("format layout: attendees, items, server rows", () => {
  const sessions = [{ id: "sess-a", started_at: "2026-11-25T17:05:00Z" }];
  it("attendeesText: named speakers in first-heard order, through merges; '' when none", () => {
    const speakers = [
      { el_session_id: "sess-a", speaker_label: "speaker_0", display_name: "Erik Lund", person_id: null },
      { el_session_id: "sess-a", speaker_label: "speaker_1", display_name: "Anna Berg", person_id: null },
      { el_session_id: "sess-a", speaker_label: "speaker_2", display_name: "speaker_2", merged_into_label: "speaker_1" },
      { el_session_id: "sess-a", speaker_label: "speaker_3", display_name: "speaker_3", person_id: null },
    ];
    const segs = [
      seg({ speaker: "speaker_2", start_ms: 500 }),
      seg({ speaker: "speaker_0", start_ms: 900, segment_index: 1 }),
      seg({ speaker: "speaker_1", start_ms: 2000, segment_index: 2 }),
      seg({ speaker: "speaker_3", start_ms: 100, segment_index: 3 }),
    ];
    expect(tick.attendeesText(speakers, segs, sessions)).toBe("Anna Berg, Erik Lund");
    // Whatever order the rows come in.
    expect(tick.attendeesText([...speakers].reverse(), [...segs].reverse(), sessions)).toBe("Anna Berg, Erik Lund");
    expect(tick.attendeesText([], segs, sessions)).toBe("");
  });

  it("claudeItems leaves out info rows, the Må-runda line and tasks copies; carried rows stay", () => {
    const items: NotesItem[] = [
      { id: "n1", section: "decision", text: "a", anchor: "ag-4" },
      { id: "n2", section: "action", text: "b", anchor: "ag-4" },
      { id: "n2-t", section: "action", text: "b", anchor: "tasks", copyOf: "n2" },
      { id: "c1", section: "action", text: "c", anchor: "ag-3", carried: true },
      { id: "info-tid", section: "note", text: "18:05", anchor: "info.tid" },
      { id: "info-narvarande", section: "attendees", text: "Anna Berg", anchor: "info.narvarande" },
      { id: "checkin-done", section: "note", text: "Må-runda genomförd.", anchor: "ag-2" },
    ];
    expect(tick.claudeItems(items).map((i) => i.id)).toEqual(["n1", "n2", "c1"]);
  });

  it("serverItems: Närvarande when named, the Må-runda line once a started window closed, Tid on the final pass", () => {
    const base = { attendees: "", window: null, checkinKey: "ag-2", tidRow: true, final: false, startedAt: FMT_STARTED, endedAt: FMT_ENDED };
    expect(tick.serverItems(base)).toEqual([]);
    expect(tick.serverItems({ ...base, attendees: "Anna Berg", window: { startMs: 1, endMs: null, closed: false, failures: 0 } })).toEqual([
      { id: "info-narvarande", section: "attendees", text: "Anna Berg", anchor: "info.narvarande" },
    ]);
    // Closed without ever starting (no Må-runda found): no line.
    expect(tick.serverItems({ ...base, window: { startMs: null, endMs: null, closed: true, failures: 3 } })).toEqual([]);
    expect(tick.serverItems({ ...base, window: { startMs: 1, endMs: 9, closed: true, failures: 0 }, final: true })).toEqual([
      { id: "checkin-done", section: "note", text: "Må-runda genomförd.", anchor: "ag-2" },
      { id: "info-tid", section: "note", text: "18:05–19:10", anchor: "info.tid" },
    ]);
    expect(tick.serverItems({ ...base, final: true, tidRow: false })).toEqual([]);
  });

  it("withOwnerIds: resolves owners, keeps a carried row's id, clears an owner-less row", () => {
    const people = [
      { id: "p-anna", org_id: "o", name: "Anna Berg", member_user_id: null, role: "Kassör" },
      { id: "p-erik", org_id: "o", name: "Erik Lund", member_user_id: null, role: null },
    ];
    const rows = [
      row({ id: "n1", section: "action", owner: "kassören" }),
      row({ id: "c1", section: "action", owner: "Erik", owner_person_id: "p-old", carried_from_id: "n9", carried_from_meeting: "m0" }),
      row({ id: "n2", section: "note", owner: null, owner_person_id: "p-anna" }),
    ];
    expect(tick.withOwnerIds(rows, people).map((r) => r.owner_person_id)).toEqual(["p-anna", "p-old", null]);
  });
});

describe("format layout: the agenda context (F4) and new items (F5)", () => {
  const M = "m-ctx";
  it("a human inserts an item mid-list: stored anchors keep their item, the new one gets ag-7 (topic)", () => {
    const { doc, plan } = anchoredDoc(M);
    const meeting = fmtMeeting(M, plan);
    // Our note under Ekonomi (ag-5) first, as an earlier tick would have written it.
    const { rows } = renderInto(doc, meeting, [], [{ id: "n1", section: "note", text: "Kassan är god", anchor: "ag-5" }]);
    expect(linesOf(doc)).toContain("– Kassan är god.");
    insertItemBeforeOvrigt(doc, "Budget 2027");

    const tab = parseNotesTab(doc, TAB);
    const scan = scanAgenda(withoutOwn(tab, rows), VECKOMOTE);
    // The scan's own keys shifted (ag-6 is now "Budget 2027"): never used for stored anchors.
    expect(scan.items.find((i) => i.key === "ag-6")?.label).toBe("Budget 2027");
    const fresh = newAgendaItems(scan, tab, meeting.section_ranges);
    expect(fresh.map((f) => f.key)).toEqual(["ag-7"]);
    const ctx = tick.agendaContext(tab, scan, meeting, VECKOMOTE, [{ name: "Anna Berg", role: "Kassör" }], fresh);
    expect(ctx.anchors.map((a) => [a.key, a.label, a.role])).toEqual([
      ["ag-1", "Godkänn dagordning", "procedural"],
      ["ag-2", "Må-runda", "checkin"],
      ["ag-3", "Från förra veckan", "followup"],
      ["ag-4", "Kommande event", "topic"],
      ["ag-5", "Ekonomi", "topic"],
      ["ag-7", "Budget 2027", "topic"],
      ["ag-6", "Övrigt", "other"],
    ]);
    expect(ctx.anchors.find((a) => a.key === "ag-4")!.humanText).toBe("Sommarfest på Kårallen\nWorkshop om sponsring");
    // Our own line is not the human's text under Ekonomi.
    expect(ctx.anchors.find((a) => a.key === "ag-5")!.humanText).toBe("");
    expect(ctx).toMatchObject({ formatName: "Veckomöte", decisionPrefix: "Beslut:", groupBy: "role", people: [{ name: "Anna Berg", role: "Kassör" }] });
    expect(anchorRoles(ctx).get("ag-7")).toBe("topic");
    expect(anchorRoles(ctx).get("notes")).toBe("notes");

    // Rendered with the new anchor: the note lands under "Budget 2027" and the range is created.
    const out = renderInto(doc, meeting, rows, [
      { id: "n1", section: "note", text: "Kassan är god", anchor: "ag-5" },
      { id: "n2", section: "note", text: "Budgeten ska vara klar i januari", anchor: "ag-7" },
    ], { newAnchors: fresh });
    const lines = linesOf(doc);
    expect(lines.slice(lines.indexOf("Ekonomi"), lines.indexOf("Övrigt") + 1)).toEqual([
      "Ekonomi",
      "– Kassan är god.",
      "Budget 2027",
      "– Budgeten ska vara klar i januari.",
      "Övrigt",
    ]);
    const after = parseNotesTab(doc, TAB);
    expect(itemSpan(after, `ss-${M}-ag-7`)?.rangeText).toBe("Budget 2027");
    // Next tick: ag-7 is a stored anchor, nothing is new.
    const next = { ...meeting, section_ranges: { ...meeting.section_ranges, "ag-7": `ss-${M}-ag-7` }, agenda_roles: { ...ROLES, "ag-7": "topic" as const } };
    const scan2 = scanAgenda(withoutOwn(after, out.rows), VECKOMOTE);
    expect(newAgendaItems(scan2, after, next.section_ranges)).toEqual([]);
    const ctx2 = tick.agendaContext(after, scan2, next, VECKOMOTE, []);
    expect(ctx2.anchors.find((a) => a.key === "ag-7")).toMatchObject({ label: "Budget 2027", role: "topic" });
    expect(ctx2.anchors.find((a) => a.key === "ag-5")).toMatchObject({ label: "Ekonomi", humanText: "" });
  });

  it("Må-runda text typed in the Doc never reaches the notes engine (R2-M2)", () => {
    const { doc, plan } = anchoredDoc(M);
    const ma = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Må-runda\n")!;
    applyDoc(doc, [{ insertText: { text: "\nAnna är sjuk idag", location: { tabId: TAB, index: ma.end - 1 } } }]);
    const el = doc.tabs![0].documentTab!.body!.content!.find((e) => e.paragraph?.elements?.[0]?.textRun?.content === "Anna är sjuk idag\n")!;
    el.paragraph!.bullet!.nestingLevel = 1;
    const tab = parseNotesTab(doc, TAB);
    const meeting = fmtMeeting(M, plan);
    const scan = scanAgenda(tab, VECKOMOTE);
    const ctx = tick.agendaContext(tab, scan, meeting, VECKOMOTE, []);
    expect(ctx.anchors.find((a) => a.key === "ag-2")!.humanText).toBe("Anna är sjuk idag");
    const hidden = tick.hideCheckinText(tab, scan, meeting, ctx);
    expect(hidden.agenda.anchors.find((a) => a.key === "ag-2")!.humanText).toBe("");
    expect(hidden.agenda.anchors.find((a) => a.key === "ag-4")!.humanText).toBe("Sommarfest på Kårallen\nWorkshop om sponsring");
    expect(hidden.text).not.toContain("Anna är sjuk");
    expect(hidden.text).toContain("Må-runda\n");
    expect(hidden.text).toContain("Workshop om sponsring");
    // No checkin item (a förening without a Må-runda): nothing hidden.
    const none = { ...meeting, agenda_roles: { ...ROLES, "ag-2": "topic" as const } };
    expect(tick.hideCheckinText(tab, scan, none, ctx).text).toContain("Anna är sjuk");
  });

  it("an anchor whose item text is gone is listed gone, without a label", () => {
    const { doc, plan } = anchoredDoc(M);
    const ma = parseNotesTab(doc, TAB).paragraphs.find((p) => p.text === "Må-runda\n")!;
    applyDoc(doc, [{ deleteContentRange: { range: { tabId: TAB, startIndex: ma.start, endIndex: ma.end - 1 } } }]);
    const tab = parseNotesTab(doc, TAB);
    const ctx = tick.agendaContext(tab, scanAgenda(tab, VECKOMOTE), fmtMeeting(M, plan), VECKOMOTE, []);
    expect(ctx.anchors.at(-1)).toEqual({ key: "ag-2", label: "", role: "checkin", humanText: "", gone: true });
    expect(anchorRoles(ctx).has("ag-2")).toBe(false);
  });

  it("rekeyNewItems: a later read keeps the keys Claude was told (by label), others get fresh keys", () => {
    const { doc, plan } = anchoredDoc(M);
    insertItemBeforeOvrigt(doc, "Lokalfrågan");
    insertItemBeforeOvrigt(doc, "Budget 2027");
    const tab = parseNotesTab(doc, TAB);
    const scan = scanAgenda(tab, VECKOMOTE);
    const found = newAgendaItems(scan, tab, plan.sectionRanges);
    expect(found.map((f) => f.key)).toEqual(["ag-7", "ag-8"]);
    // Claude was told only about "Budget 2027" as ag-7.
    const keyed = tick.rekeyNewItems(found, scan, [{ key: "ag-7", label: "Budget 2027" }], Object.keys(plan.sectionRanges));
    expect(keyed.map((k) => k.key)).toEqual(["ag-8", "ag-7"]);
  });
});

describe("format layout: the render list (F2) and Claude's view of own lines (F3)", () => {
  const M = "m-desired";
  const emptyDiff = (rows: NoteItemRow[]) => ({ rows, locked: [] as NotesItem[], deletedIds: [] as string[] });

  it("the Må-runda line renders once and survives the next tick; copies and carried rows stay", () => {
    const { doc, plan } = anchoredDoc(M);
    const meeting = fmtMeeting(M, plan);
    const server = tick.serverItems({
      attendees: "Anna Berg, Erik Lund",
      window: { startMs: 2000, endMs: 5000, closed: true, failures: 0 },
      checkinKey: tick.checkinAnchor(meeting),
      tidRow: true,
      final: false,
      startedAt: FMT_STARTED,
      endedAt: FMT_ENDED,
    });
    const items: NotesItem[] = [
      { id: "c1", section: "action", text: "Mejla klubben om avgiften", owner: "Kassör", anchor: "ag-3", carried: true },
      { id: "n1", section: "action", text: "Boka sal", owner: "Anna Berg", anchor: "ag-4" },
    ];
    const tidRow = plan.rows.map((r) => ({ ...r, meeting_id: M }));
    let rows: NoteItemRow[] = tidRow;
    for (let t = 0; t < 2; t++) {
      const desired = tick.formatDesired(items, emptyDiff(rows), server, VECKOMOTE);
      expect(desired.map((d) => d.id)).toEqual(["c1", "n1", "info-narvarande", "checkin-done", "n1-t"]);
      const out = renderInto(doc, meeting, rows, desired);
      if (t === 1) expect(out.plan.requests).toEqual([]); // nothing moves on the second tick
      rows = out.rows;
    }
    const lines = linesOf(doc);
    expect(lines.filter((l) => l === "– Må-runda genomförd.")).toHaveLength(1);
    expect(lines[lines.indexOf("Må-runda") + 1]).toBe("– Må-runda genomförd.");
    expect(lines).toContain("Närvarande");
    expect(docText(doc)).toContain("Anna Berg, Erik Lund");
    expect(rows.find((r) => r.id === "checkin-done")).toMatchObject({ anchor: "ag-2", kind: "note", locked: false, range_name: `ss-${M}-checkin-done` });
    expect(rows.map((r) => r.id).sort()).toEqual(["c1", "checkin-done", "info-datum", "info-narvarande", "info-tid", "n1", "n1-t"]);
    // Left out of the list, the planner would remove it: that is why it is in every tick's list.
    const without = planFormatRender(meeting, parseNotesTab(doc, TAB), rows, tick.formatDesired(items, emptyDiff(rows), [], VECKOMOTE), {
      profile: VECKOMOTE,
      ownerLabel: (o) => o,
    });
    expect(without.removed.has("checkin-done")).toBe(true);
    expect(without.removed.has("info-narvarande")).toBe(false); // info cells are never removed
  });

  it("0069: a moment survives two renders (primary and tasks copy), reads back unlocked and carried by the items", () => {
    const { doc, plan } = anchoredDoc(M);
    const meeting = fmtMeeting(M, plan);
    const items: NotesItem[] = [
      { id: "n1", section: "action", text: "Boka sal", owner: "Anna Berg", anchor: "ag-4", sources: ["el:5:0"], saidAtMs: 2_512_000 },
      { id: "n2", section: "decision", text: "Höstfesten blir 14 november", anchor: "ag-4", sources: ["el:4:0"], saidAtMs: 2_480_000 },
    ];
    let rows: NoteItemRow[] = plan.rows.map((r) => ({ ...r, meeting_id: M }));
    for (let t = 0; t < 2; t++) {
      const out = renderInto(doc, meeting, rows, tick.formatDesired(items, emptyDiff(rows), [], VECKOMOTE));
      if (t === 1) expect(out.plan.requests).toEqual([]);
      rows = out.rows;
    }
    const lines = linesOf(doc);
    expect(lines.filter((l) => l.endsWith("Boka sal. (41:52)"))).toHaveLength(2); // the item and its tasks copy
    expect(lines.some((l) => l.endsWith("Höstfesten blir 14 november. (41:20)"))).toBe(true);
    for (const id of ["n1", "n1-t", "n2"]) expect(rows.find((r) => r.id === id)).toMatchObject({ locked: false, source_segment_ids: expect.any(Array), said_at_ms: expect.any(Number) });
    const back = tick.readState(parseNotesTab(doc, TAB), rows);
    expect(back.diff.locked).toEqual([]);
    expect(back.items.find((i) => i.id === "n1")).toMatchObject({ sources: ["el:5:0"], saidAtMs: 2_512_000 });
  });

  it("a server row a human edited or deleted stays theirs: only the locked version, never re-added", () => {
    const server: NotesItem[] = [{ id: "checkin-done", section: "note", text: "Må-runda genomförd.", anchor: "ag-2" }];
    const locked = { id: "checkin-done", section: "note" as const, text: "Må-runda klar" };
    const desired = tick.formatDesired([], { rows: [], locked: [locked], deletedIds: [] }, server, VECKOMOTE);
    expect(desired).toEqual([locked]);
    expect(tick.formatDesired([], { rows: [], locked: [], deletedIds: ["checkin-done"] }, server, VECKOMOTE)).toEqual([]);
  });

  it("F3: our rendered lines ('– ' prefix as stored) never reach Claude as human text", () => {
    const { doc, plan } = anchoredDoc(M);
    const meeting = fmtMeeting(M, plan);
    const { rows } = renderInto(doc, meeting, [], [{ id: "n1", section: "note", text: "Lokalen är bokad", anchor: "ag-5" }]);
    const own = rows.filter((r) => r.last_rendered_text).map((r) => r.last_rendered_text!);
    expect(own).toEqual(["– Lokalen är bokad."]);
    const tab = parseNotesTab(doc, TAB);
    // Even a scan that saw our line (no withoutOwnLines) is cleaned by ownLines.
    const ctx = tick.agendaContext(tab, scanAgenda(tab, VECKOMOTE), meeting, VECKOMOTE, []);
    const body = buildRequest({
      orgName: "Kodklubben",
      transcriptBlocks: ["[00:00:01] S1-speaker_0: hej"],
      speakerNames: {},
      notesTabText: tab.paragraphs.map((p) => p.text).join(""),
      items: [{ id: "n1", section: "note", text: "Lokalen är bokad", anchor: "ag-5" }],
      locked: [],
      deletedIds: [],
      final: false,
      agenda: ctx,
      ownLines: own,
    });
    const content = body.messages[0].content as { text: string }[];
    const tail = content[content.length - 1].text;
    expect(tail).toContain("Ekonomi");
    expect(tail).not.toContain("Lokalen är bokad.");
  });

  it("final pass: Tid becomes 18:05–19:10 and the status line 'Simon Says · avslutat 19:10'", () => {
    const { doc, plan } = anchoredDoc(M);
    const meeting = fmtMeeting(M, plan);
    const rows = plan.rows.map((r) => ({ ...r, meeting_id: M }));
    const live = renderInto(doc, meeting, rows, [], { header: tick.liveHeader(new Date("2026-11-25T17:31:00Z"), "format") });
    expect(linesOf(doc)).toContain("Simon Says antecknar live · uppdaterad 18:31");
    const server = tick.serverItems({ attendees: "", window: null, checkinKey: null, tidRow: true, final: true, startedAt: FMT_STARTED, endedAt: FMT_ENDED });
    const ended = renderInto(
      doc,
      { ...meeting, header_rendered: live.plan.header },
      live.rows,
      tick.formatDesired([], emptyDiff(live.rows), server, VECKOMOTE),
      { header: tick.endedHeader(FMT_ENDED, "format") },
    );
    expect(ended.plan.header).toBe("Simon Says · avslutat 19:10");
    const lines = linesOf(doc);
    expect(lines).toContain("Simon Says · avslutat 19:10");
    expect(lines).toContain("18:05–19:10");
    expect(ended.rows.find((r) => r.id === "info-tid")).toMatchObject({ text: "18:05–19:10", last_rendered_text: "18:05–19:10" });
  });
});


describe("format layout: fix round 1 (pure)", () => {
  const M = "m-fix1";
  const emptyDiff = (rows: NoteItemRow[]) => ({ rows, locked: [] as NotesItem[], deletedIds: [] as string[] });
  /** A human types `text` just before the final "." of our row's line (inside its range: the row locks). */
  const humanEdit = (doc: Doc, id: string, text: string) => {
    const span = itemSpan(parseNotesTab(doc, TAB), `ss-${M}-${id}`)!;
    applyDoc(doc, [{ insertText: { text, location: { tabId: TAB, index: span.paraEnd - 2 } } }]);
  };

  it("R-A6: with the primary locked, Claude edits the tasks copy under the primary's id; done reaches the copy only", () => {
    const { doc, plan } = anchoredDoc(M);
    const meeting = fmtMeeting(M, plan);
    const n1: NotesItem = { id: "n1", section: "action", text: "Boka salen", owner: "Kassör", anchor: "ag-4" };
    const rows = renderInto(doc, meeting, [], tick.formatDesired([n1], emptyDiff([]), [], VECKOMOTE)).rows;
    expect(linesOf(doc).filter((l) => l === "Kassör: Boka salen.")).toHaveLength(2);
    humanEdit(doc, "n1", " gärna");
    const st = tick.readState(parseNotesTab(doc, TAB), rows);
    expect(st.diff.locked.map((i) => i.id)).toEqual(["n1"]);
    const { items, proxied } = tick.copyProxies(st.diff.rows);
    expect(items).toEqual([{ id: "n1", section: "action", text: "Boka salen", owner: "Kassör", anchor: "ag-4" }]);
    expect([...proxied]).toEqual(["n1"]);
    // Claude: change n1 done:true.
    const answer = items.map((i) => ({ ...i, done: true }));
    expect(tick.unproxy(answer, proxied)).toEqual([
      { id: "n1-t", section: "action", text: "Boka salen", owner: "Kassör", anchor: "tasks", copyOf: "n1", done: true },
    ]);
    const out = renderInto(doc, meeting, st.diff.rows, tick.formatDesired(tick.unproxy(answer, proxied), st.diff, [], VECKOMOTE));
    const lines = linesOf(doc);
    expect(lines).toContain("Kassör: Boka salen gärna."); // the human's primary, untouched
    expect(lines).toContain("Kassör: Boka salen. ✓ klart"); // the copy keeps updating
    expect(out.rows.find((r) => r.id === "n1")).toMatchObject({ locked: true });
    expect(out.rows.find((r) => r.id === "n1-t")).toMatchObject({ done: true, locked: false, anchor: "tasks", copy_of: "n1" });
    // A copy whose primary is not human-edited is never proxied; a locked copy neither.
    expect(tick.copyProxies(rows).items).toEqual([]);
    expect(tick.copyProxies(st.diff.rows.map((r) => (r.id === "n1-t" ? { ...r, locked: true } : r))).items).toEqual([]);
  });

  it("sentTicks: the first notes_sent_tick ticks, by tick number", () => {
    const segs = [seg({ tick_no: 4 }), seg({ tick_no: 2 }), seg({ tick_no: 2, segment_index: 1 }), seg({ tick_no: 7 }), seg({ tick_no: null })];
    expect([...tick.sentTicks(segs, 0)]).toEqual([]);
    expect([...tick.sentTicks(segs, 2)]).toEqual([2, 4]);
    expect([...tick.sentTicks(segs, 9)]).toEqual([2, 4, 7]);
  });

  it("endPassWindow: masks from the first unsent line to min(CHECKIN_MAX_MS, last + 1), closed as unsure (no Må-runda line)", () => {
    const open = { startMs: null, endMs: null, closed: false, failures: 1 };
    const w = tick.endPassWindow(open, { firstMs: 60_000, lastMs: 90_000 });
    expect(w).toEqual({ startMs: 60_000, endMs: 90_001, closed: true, failures: 3 });
    expect(tick.endPassWindow(open, { firstMs: 60_000, lastMs: 40 * 60_000 })).toMatchObject({ startMs: 60_000, endMs: 20 * 60_000 });
    expect(tick.endPassWindow(open, { firstMs: 25 * 60_000, lastMs: 26 * 60_000 })).toEqual({ startMs: null, endMs: null, closed: true, failures: 3 });
    const base = { attendees: "", checkinKey: "ag-2", tidRow: false, final: true, startedAt: FMT_STARTED, endedAt: FMT_ENDED };
    expect(tick.serverItems({ ...base, window: w })).toEqual([]);
    // Masked in the blocks like any closed window.
    const blocks = tick.buildTranscript(
      [seg({ start_ms: 30_000 }), seg({ start_ms: 60_000, segment_index: 1, text: "Jag mår bra" })],
      [{ id: "sess-a", started_at: "2026-11-25T17:05:00Z" }],
      [],
      w,
    ).blocks;
    expect(blocks).toEqual([`[00:00:30] S1-speaker_0: hej\n[00:01:00] –: ${CHECKIN_PLACEHOLDER}`]);
  });

  it("adopts our ag-N range the anchor map lost, instead of making a second one", () => {
    const { doc, plan } = anchoredDoc(M);
    const meeting = fmtMeeting(M, plan);
    insertItemBeforeOvrigt(doc, "Budget 2027");
    const tab0 = parseNotesTab(doc, TAB);
    const fresh = newAgendaItems(scanAgenda(tab0, VECKOMOTE), tab0, plan.sectionRanges);
    expect(fresh.map((f) => f.key)).toEqual(["ag-7"]);
    renderInto(doc, meeting, [], [], { newAnchors: fresh }); // the range is made; the map is not stored
    const tab = parseNotesTab(doc, TAB);
    expect(adoptedAgendaRanges(tab, plan.sectionRanges, M)).toEqual({ "ag-7": `ss-${M}-ag-7` });
    expect(newAgendaItems(scanAgenda(tab, VECKOMOTE), tab, plan.sectionRanges, M)).toEqual([]);
    expect(adoptedAgendaRanges(tab, { ...plan.sectionRanges, "ag-7": `ss-${M}-ag-7` }, M)).toEqual({});
    expect(adoptedAgendaRanges(tab, plan.sectionRanges, "another-meeting")).toEqual({});
  });
});

describe("a false start's carried line taken over by the next meeting (final review R1/R2)", () => {
  it("renders twice under the new meeting without a second line, a lock or a lost range", async () => {
    const { toNotesItem } = await import("@/lib/docs/notes");
    const { withoutEarlierLines } = await import("@/lib/agenda/scan");
    // False start A carried "Mejla klubben" into the Doc under Från förra veckan.
    const a = anchoredDoc("m-A");
    const doc = a.doc;
    const c1: NoteItemRow = {
      meeting_id: "m-A", id: "c1", section: "action", kind: "task", text: "Mejla klubben om avgiften", owner: null, due: null,
      locked: false, deleted_by_human: false, last_rendered_text: null, range_name: null, position: 0, anchor: "ag-3",
      done: false, carried_from_meeting: "W1", carried_from_id: "n1", copy_of: null,
    };
    const fromA = renderInto(doc, fmtMeeting("m-A", a.plan), [c1], [toNotesItem(c1)]).rows.find((r) => r.id === "c1")!;
    expect(fromA.range_name).toBe("ss-m-A-c1");
    // B anchors the same Doc (as anchorAgenda: earlier lines left out of the scan) and takes c1 over.
    const tab = parseNotesTab(doc, TAB);
    const planB = planAnchoring(scanAgenda(withoutEarlierLines(tab), VECKOMOTE), tab, { meetingId: "m-B", profile: VECKOMOTE, startedAt: FMT_STARTED });
    applyDoc(doc, planB.requests);
    const meetingB = fmtMeeting("m-B", planB);
    let rows: NoteItemRow[] = [{ ...fromA, meeting_id: "m-B", anchor: "ag-3" }, ...planB.rows.map((r) => ({ ...r, meeting_id: "m-B" }))];
    for (let i = 0; i < 2; i++) {
      const st = tick.readState(parseNotesTab(doc, TAB), rows);
      const row = st.diff.rows.find((r) => r.id === "c1")!;
      expect([row.locked, row.deleted_by_human]).toEqual([false, false]);
      rows = renderInto(doc, meetingB, st.diff.rows, st.items).rows;
      expect(rows.find((r) => r.id === "c1")!.range_name).toBe("ss-m-A-c1");
    }
    expect(linesOf(doc).filter((l) => l.includes("Mejla klubben om avgiften"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Against the local stack (CI)

describe.skipIf(!hasLocalSupabase)("ticks, end and finalize", () => {
  let starter: TestUser;
  let orgId: string;

  beforeAll(async () => {
    starter = await createTestUser("ticker");
    const r = await createOrg(starter.db, "Tickföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    // Lines pinned without the concrete-tasks placeholders (tests/suite/tasks.test.ts covers those).
    await adminClient().from("orgs").update({ require_task_fields: false }).eq("id", orgId);
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  async function meeting(opts: { heartbeatAgoSec?: number | null; transcript?: boolean } = {}) {
    const admin = adminClient();
    const id = randomUUID();
    const hb = opts.heartbeatAgoSec === undefined ? 0 : opts.heartbeatAgoSec;
    // Meeting and session start together, so session-relative times are meeting-relative.
    const startedAt = new Date(Date.now() - 600_000).toISOString();
    const { error } = await admin.from("meetings").insert({
      id,
      org_id: orgId,
      started_by: starter.id,
      doc_id: `doc-${id}`,
      notes_tab_id: "t.notes",
      transcript_tab_id: opts.transcript === false ? null : "t.transcript",
      header_range: `ss-${id}-header`,
      header_rendered: "LIVE · uppdaterad –",
      status: "live",
      consent_confirmed_at: new Date().toISOString(),
      started_at: startedAt,
      last_heartbeat_at: hb === null ? null : new Date(Date.now() - hb * 1000).toISOString(),
    });
    if (error) throw new Error(error.message);
    const sessionId = `el-${randomUUID()}`;
    const { error: se } = await admin
      .from("el_sessions")
      .insert({ id: sessionId, meeting_id: id, max_seconds: 3600, started_at: startedAt });
    if (se) throw new Error(se.message);
    await admin.from("meetings").update({ current_el_session_id: sessionId }).eq("id", id);
    return { id, sessionId };
  }

  let segCounter = 0;
  const say = (meetingId: string, sessionId: string, text: string, startMs: number) =>
    ingestSegments(meetingId, [
      { elSessionId: sessionId, segmentIndex: segCounter++, runIndex: 0, speaker: "speaker_0", text, startMs, endMs: startMs + 500 },
    ]);

  /** Fake Google + Claude, with the Doc state derived from note_items (+ human overrides). */
  function fakes(
    opts: {
      conflicts?: number;
      gate?: Promise<void>;
      authLost?: () => boolean;
      readFails?: () => boolean;
      claudeError?: boolean;
      /** Claude answers without usable ops: "refusal", "stop:max_tokens", "malformed", "all_dropped". */
      nonAnswer?: () => string | null;
      /** An end_turn answer with zero ops. */
      quiet?: boolean;
      onUpdate?: (input: UpdateNotesInput) => Promise<void>;
      /** The name round's Claude call (default: no names). */
      names?: import("@/lib/names/round").ExtractFn;
    } = {},
  ) {
    // A clock that fake sleeps move forward (deadline loops end without real waiting).
    let offset = 0;
    const calls: UpdateNotesInput[] = [];
    const headers: (string | undefined)[] = [];
    const appended: TranscriptLine[][] = [];
    const mails: string[] = [];
    let conflicts = opts.conflicts ?? 0;
    let renders = 0;
    const deps: Partial<import("@/lib/meetings/tick").TickDeps> = {
      getAuth: async (userId) => {
        if (opts.authLost?.()) throw new GoogleAuthLostError(userId, "invalid_grant");
        return {} as OAuth2Client;
      },
      readNotes: async (_auth, m: MeetingRow) => {
        if (opts.readFails?.()) throw new Error("docs 500");
        const { data } = await adminClient().from("note_items").select("*").eq("meeting_id", m.id).order("position");
        return tabOf(m.id, (data ?? []) as NoteItemRow[], { revisionId: `r${renders}` });
      },
      render: async (_auth, m, rows, desired, _rev, header): Promise<RenderResult> => {
        renders++;
        headers.push(header);
        if (conflicts > 0) {
          conflicts--;
          return { status: "conflict" };
        }
        const ids = new Set(desired.map((d) => d.id));
        const applied = new Set(
          desired.filter((d) => !rows.find((r) => r.id === d.id && (r.locked || r.deleted_by_human))).map((d) => d.id),
        );
        const removed = new Set(rows.filter((r) => !ids.has(r.id) && !r.locked && !r.deleted_by_human).map((r) => r.id));
        return { status: "ok", rows: renderedRows(m.id, rows, desired, { applied, removed }), headerRendered: header ?? null };
      },
      appendTranscript: async (_auth, _doc, _tab, lines) => {
        appended.push(lines);
      },
      extractNames: opts.names ?? (async () => []),
      updateNotes: async (input): Promise<UpdateNotesResult> => {
        calls.push(input);
        if (opts.gate) await opts.gate;
        if (opts.onUpdate) await opts.onUpdate(input);
        if (opts.claudeError) {
          return {
            ops: [],
            items: input.items,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, estimated: true },
            stopReason: "error",
            dropped: 0,
            nextId: input.nextId ?? "n1",
            failure: "error",
          };
        }
        const non = opts.nonAnswer?.() ?? null;
        if (non || opts.quiet) {
          return {
            ops: [],
            items: input.items,
            usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, usd: 0.005 },
            stopReason: non === "refusal" ? "refusal" : non?.startsWith("stop:") ? non.slice(5) : "end_turn",
            dropped: non === "all_dropped" ? 2 : 0,
            nextId: input.nextId ?? "n1",
            failure: non,
          };
        }
        const n = Number((input.nextId ?? "n1").slice(1));
        const add: NotesItem = { id: `n${n}`, section: "decision", text: `Beslut ${n}` };
        return {
          ops: [{ op: "add", item: add }],
          items: [...input.items, add],
          usage: { input: 1000, output: 100, cacheRead: 50, cacheWrite: 10, usd: 0.01 },
          stopReason: "end_turn",
          dropped: 0,
          nextId: `n${n + 1}`,
          failure: null,
        };
      },
      mailer: {
        send: async (msg) => {
          mails.push(msg.subject);
          return false;
        },
      },
      sleep: async (ms) => {
        offset += ms;
      },
      now: () => new Date(Date.now() + offset),
    };
    return { deps, calls, headers, appended, mails, renders: () => renders };
  }

  const read = async (id: string) =>
    (await adminClient().from("meetings").select("*").eq("id", id).single()).data as MeetingRow & {
      notes_next_id: string | null;
    };
  const events = async (id: string, kind: string) =>
    (await adminClient().from("meeting_events").select("kind, detail").eq("meeting_id", id).eq("kind", kind)).data ?? [];
  const backdate = (id: string, sec = 46) =>
    adminClient().from("meetings").update({ last_tick_at: new Date(Date.now() - sec * 1000).toISOString() }).eq("id", id);

  it("a tick: blocks to Claude, notes saved, header + counter + usage persisted, transcript appended", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "Vi bestämmer budgeten", 1000);
    const f = fakes();
    const { data: before } = await adminClient().from("usage_daily").select("claude_input_tokens").eq("org_id", orgId);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].transcriptBlocks).toEqual(["[00:00:01] S1-speaker_0: Vi bestämmer budgeten"]);
    expect(f.calls[0].orgName).toBe("Tickföreningen");
    expect(f.headers[0]).toMatch(/^LIVE · uppdaterad \d\d:\d\d$/);
    const m = await read(id);
    expect(m.notes_next_id).toBe("n2");
    expect(m.header_rendered).toBe(f.headers[0]);
    expect(m.tick_lease_until).toBeNull();
    expect(m.failed_ticks).toBe(0);
    expect(m.last_tick_ok_at).not.toBeNull();
    const { data: items } = await adminClient().from("note_items").select("id, range_name").eq("meeting_id", id);
    expect(items).toEqual([{ id: "n1", range_name: itemRangeName(id, "n1") }]);
    expect(f.appended).toEqual([[{ speaker: "S1-speaker_0", atMs: 1000, text: "Vi bestämmer budgeten" }]]);
    const { data: segs } = await adminClient().from("segments").select("tick_no, transcript_written_at").eq("meeting_id", id);
    expect(segs?.[0].tick_no).toBe(1);
    expect(segs?.[0].transcript_written_at).not.toBeNull();
    const { data: after } = await adminClient().from("usage_daily").select("claude_input_tokens").eq("org_id", orgId);
    const sum = (rows: { claude_input_tokens: number }[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.claude_input_tokens), 0);
    expect(sum(after) - sum(before)).toBe(1000);
    expect(await events(id, "tick_ok")).toHaveLength(1);
  });

  it("0069: a cited moment is stored, rendered and kept across a quiet tick (v1)", async () => {
    const { applyOps } = await import("@/lib/notes/engine");
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "Vi bestämmer budgeten", 1000);
    const f = fakes();
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0 };
    let cite = true;
    f.deps.updateNotes = async (input) => {
      f.calls.push(input);
      const ops = cite ? [{ op: "add" as const, item: { id: "n1", section: "decision" as const, text: "Budgeten antas" }, src: ["00:00:01"] }] : [];
      const r = applyOps(input.items, ops, { nextId: input.nextId, sources: input.sources });
      return { ops: r.ops, items: r.items, usage, stopReason: "end_turn", dropped: r.dropped, nextId: r.nextId, failure: null };
    };
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.calls[0].sources?.get("00:00:01")?.length).toBe(1);
    const row = async () =>
      (await adminClient().from("note_items").select("locked, last_rendered_text, source_segment_ids, said_at_ms").eq("meeting_id", id).eq("id", "n1").single()).data as Partial<NoteItemRow>;
    const first = await row();
    expect(first).toMatchObject({ locked: false, last_rendered_text: "✓ Budgeten antas (00:01)", said_at_ms: 1000 });
    expect(first.source_segment_ids).toEqual([`${sessionId}:${segCounter - 1}:0`]);
    cite = false;
    await say(id, sessionId, "Nästa punkt", 5000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.calls[1].items.find((i) => i.id === "n1")).toMatchObject({ sources: first.source_segment_ids, saidAtMs: 1000 });
    expect(await row()).toEqual(first);
  });

  it("concurrent runTick: one ok, one busy", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const f = fakes({ gate });
    const first = tick.runTick(id, { final: false }, f.deps);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("busy");
    open();
    expect(await first).toBe("ok");
  });

  it("two ticks 45 s apart both run (lease released); within 30 s skipped", async () => {
    const { id, sessionId } = await meeting();
    const f = fakes();
    await say(id, sessionId, "ett", 1000);
    await tick.maybeTick(id, f.deps);
    expect(f.calls).toHaveLength(1);
    await say(id, sessionId, "två", 2000);
    await tick.maybeTick(id, f.deps); // right after: skipped
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("busy"); // hard floor 30 s
    expect(f.calls).toHaveLength(1);
    await backdate(id, 46);
    await tick.maybeTick(id, f.deps);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].nextId).toBe("n2");
  });

  it("late segments get the next tick_no; earlier blocks unchanged", async () => {
    const { id, sessionId } = await meeting();
    const f = fakes();
    await say(id, sessionId, "först", 5000);
    await tick.runTick(id, { final: false }, f.deps);
    await say(id, sessionId, "sen", 1000); // earlier start time, arrives later
    await backdate(id);
    await tick.runTick(id, { final: false }, f.deps);
    expect(f.calls[1].transcriptBlocks[0]).toBe(f.calls[0].transcriptBlocks[0]);
    expect(f.calls[1].transcriptBlocks[1]).toBe("[00:00:01] S1-speaker_0: sen");
  });

  it("conflict: 1 + 4 retries, then skipped with a tick_conflict event", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes({ conflicts: 99 });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("conflict");
    expect(f.renders()).toBe(5);
    expect(await events(id, "tick_conflict")).toHaveLength(1);
    const m = await read(id);
    expect(m.failed_ticks).toBe(0);
    expect(m.notes_next_id).toBe("n2"); // ids handed out are never reissued
    const { data: items } = await adminClient().from("note_items").select("id").eq("meeting_id", id);
    expect(items).toEqual([]);
  });

  it("3 failed ticks in a row → one alarm email (once per hour)", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes({ readFails: () => true });
    for (let i = 0; i < 4; i++) {
      await backdate(id);
      expect(await tick.runTick(id, { final: false }, f.deps)).toBe("failed");
    }
    expect((await read(id)).failed_ticks).toBe(4);
    expect(await events(id, "tick_failed")).toHaveLength(4);
    expect(await events(id, "alarm")).toHaveLength(1);
    expect(f.mails).toHaveLength(1);
    // Failed before Claude answered: the tick number is given back.
    const { data: segs } = await adminClient().from("segments").select("tick_no").eq("meeting_id", id);
    expect(segs?.[0].tick_no).toBeNull();
  });

  it.each(["refusal", "stop:max_tokens", "malformed", "all_dropped"])(
    "Claude non-answer (%s) is a failed tick: no last_tick_ok_at, failed_ticks++, alarm at 3; transcript still written, blocks not resent",
    async (reason) => {
      const { id, sessionId } = await meeting();
      await say(id, sessionId, "hej", 1000);
      const f = fakes({ nonAnswer: () => reason });
      for (let i = 0; i < 3; i++) {
        await backdate(id);
        if (i > 0) await say(id, sessionId, `mer ${i}`, 2000 + i * 1000);
        expect(await tick.runTick(id, { final: false }, f.deps)).toBe("failed");
      }
      const m = await read(id);
      expect(m.last_tick_ok_at).toBeNull();
      expect(m.failed_ticks).toBe(3);
      const failed = await events(id, "tick_failed");
      expect(failed).toHaveLength(3);
      expect(JSON.stringify(failed[0].detail)).toContain(reason);
      expect(await events(id, "tick_ok")).toHaveLength(0);
      expect(await events(id, "alarm")).toHaveLength(1);
      // The blocks were sent: notes_sent_tick moved on, so each call only carries one new block.
      expect(f.calls.map((c) => c.transcriptBlocks.length)).toEqual([1, 2, 3]);
      expect((await read(id)).notes_sent_tick).toBe(3);
      // The transcript keeps flowing; the notes write (and its LIVE header) is skipped.
      expect(f.appended.flat().map((l) => l.text)).toEqual(["hej", "mer 1", "mer 2"]);
      expect(f.renders()).toBe(0);
    },
  );

  it("an end_turn answer with zero ops is an ok tick (a quiet stretch)", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes({ quiet: true });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    const m = await read(id);
    expect(m.last_tick_ok_at).not.toBeNull();
    expect(m.failed_ticks).toBe(0);
  });

  it("a stale tick whose lease moved on saves no rows (B2)", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    await adminClient()
      .from("note_items")
      .insert({ meeting_id: id, id: "n9", section: "decision", text: "Nyare ticks rad", range_name: itemRangeName(id, "n9") });
    // While Claude thinks, the lease expires and a newer tick takes it.
    const f = fakes({
      onUpdate: async () => {
        await adminClient().from("meetings").update({ tick_lease_id: randomUUID() }).eq("id", id);
      },
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("busy");
    const { data: items } = await adminClient().from("note_items").select("id").eq("meeting_id", id);
    expect(items).toEqual([{ id: "n9" }]);
  });

  it("the tick lease is 6 minutes", async () => {
    const { id } = await meeting();
    const { data } = await adminClient().rpc("claim_tick_lease", { p_meeting_id: id, p_min_interval_secs: 0 });
    expect(data[0].result).toBe("ok");
    const m = await read(id);
    const ms = Date.parse(m.tick_lease_until!) - Date.now();
    expect(ms).toBeGreaterThan(5.5 * 60_000);
    expect(ms).toBeLessThanOrEqual(6 * 60_000 + 5000);
  });

  it("a final pass that must skip Claude with transcript unsent logs final_without_claude", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    await adminClient().from("meetings").update({ status: "ending" }).eq("id", id);
    // 10 s left: below the 30 s Claude needs.
    const deadlineAt = new Date(Date.now() + 10_000);
    expect(await tick.runTick(id, { final: true, deadlineAt }, f.deps)).toBe("ok");
    expect(f.calls).toHaveLength(0);
    expect(await events(id, "final_without_claude")).toHaveLength(1);
    expect(await events(id, "tick_ok")).toHaveLength(0);
    // Don't leave an `ending` meeting for later sweeps in this org.
    await adminClient().from("meetings").update({ status: "done" }).eq("id", id);
  });

  it("GoogleAuthLostError → paused, segments untouched; resumed by cron after a token update", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    let lost = true;
    const f = fakes({ authLost: () => lost });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("doc_paused");
    const paused = await read(id);
    expect(paused.doc_paused_at).not.toBeNull();
    expect(await events(id, "doc_paused")).toHaveLength(1);
    const { data: segs } = await adminClient().from("segments").select("tick_no, transcript_written_at").eq("meeting_id", id);
    expect(segs).toEqual([{ tick_no: null, transcript_written_at: null }]);
    await backdate(id);
    await tick.maybeTick(id, f.deps); // paused: nothing
    expect(f.calls).toHaveLength(0);

    lost = false;
    await adminClient()
      .from("google_tokens")
      .upsert({ user_id: starter.id, refresh_token_enc: "x", scope: "s", updated_at: new Date(Date.now() + 1000).toISOString() });
    await backdate(id);
    await tick.finalizeSweep({ deps: f.deps, orgId });
    expect(f.calls).toHaveLength(1);
    expect((await read(id)).doc_paused_at).toBeNull();
    expect(await events(id, "resumed")).toHaveLength(1);
  });

  it("presence: no tab for 5 min ends it like Avsluta (done, final pass once, ended at the last heartbeat); session closed", async () => {
    const { id, sessionId } = await meeting({ heartbeatAgoSec: 6 * 60 });
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    const first = await tick.finalizeSweep({ deps: f.deps, orgId });
    expect(first.autoEnded).toBeGreaterThanOrEqual(1);
    await tick.finalizeSweep({ deps: f.deps, orgId });
    const m = await read(id);
    expect(m.status).toBe("done");
    expect(m.end_status).toBe("done");
    // ended_at is when the last tab was heard from, not when the cron ran.
    expect(Math.abs(Date.parse(m.ended_at!) - Date.parse(m.last_heartbeat_at!))).toBeLessThan(1000);
    expect(f.calls.filter((c) => c.final)).toHaveLength(1);
    expect(f.headers.at(-1)).toMatch(/^Avslutat \d\d:\d\d$/);
    expect(await events(id, "ended")).toHaveLength(1);
    expect(await events(id, "abandoned")).toHaveLength(0);
    const { data: s } = await adminClient().from("el_sessions").select("closed_at").eq("id", sessionId).single();
    expect(s?.closed_at).not.toBeNull();
  });

  it("the end mails the summary (0037): to a person with an address who wasn't there, once", async () => {
    // The starter is in the people list (so the meeting has a known attendee); Zelda wasn't there.
    const { data: added } = await adminClient()
      .from("people")
      .insert([
        { org_id: orgId, name: "Ture Startare", member_user_id: starter.id },
        { org_id: orgId, name: "Zelda Frånvarande", email: "zelda@example.com" },
      ])
      .select("id, name");
    try {
      const { id, sessionId } = await meeting({ heartbeatAgoSec: 6 * 60 });
      await say(id, sessionId, "hej", 1000);
      // The voice is named (Ture), so attendance is certain.
      const ture = (added ?? []).find((p) => p.name === "Ture Startare")!.id as string;
      const named = await adminClient()
        .from("speaker_map")
        .upsert({ meeting_id: id, el_session_id: sessionId, speaker_label: "speaker_0", person_id: ture, display_name: "Ture Startare", needs_confirm: false });
      expect(named.error).toBeNull();
      const f = fakes();
      await tick.finalizeSweep({ deps: f.deps, orgId });
      await tick.finalizeSweep({ deps: f.deps, orgId });
      expect((await read(id)).status).toBe("done");
      expect(f.mails.filter((s) => s.startsWith("Sammanfattning: "))).not.toHaveLength(0);
      // The fake mailer answers false: recorded as failed, never retried by the next sweep.
      const ev = await events(id, "summary");
      expect(ev).toHaveLength(1);
      expect(ev[0].detail).toMatchObject({ state: "sent", mode: "missed", sent: 0, failed: 1 });
      expect((await read(id)).summary_state).toBe("sent");
    } finally {
      await adminClient().from("people").delete().in("id", (added ?? []).map((p) => p.id as string));
    }
  });

  it("presence: nothing ever said → abandoned (the empty case, never a carry source)", async () => {
    const { id } = await meeting({ heartbeatAgoSec: 6 * 60 });
    const f = fakes();
    const summary = await tick.finalizeSweep({ deps: f.deps, orgId });
    expect(summary.abandoned).toBeGreaterThanOrEqual(1);
    expect((await read(id)).status).toBe("abandoned");
    expect(await events(id, "abandoned")).toHaveLength(1);
  });

  it("presence race: a heartbeat landing after the sweep's snapshot keeps the meeting live (review I1)", async () => {
    const { id, sessionId } = await meeting({ heartbeatAgoSec: 6 * 60 });
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    const cutoff = { cutoff: () => new Date(Date.now() - 5 * 60_000), hadHeartbeat: true };
    // The sweep saw it stale; then the laptop woke up and its heartbeat landed.
    await adminClient().from("meetings").update({ last_heartbeat_at: new Date().toISOString() }).eq("id", id);
    expect(await tick.endMeeting(id, { staleBefore: cutoff, deps: f.deps })).toBe("noop");
    const m = await read(id);
    expect(m.status).toBe("live");
    expect(m.ended_at).toBeNull();
    expect(f.calls.filter((c) => c.final)).toHaveLength(0);
    // Still stale at the claim: it ends.
    await adminClient().from("meetings").update({ last_heartbeat_at: new Date(Date.now() - 6 * 60_000).toISOString() }).eq("id", id);
    expect(await tick.endMeeting(id, { staleBefore: cutoff, deps: f.deps })).toBe("ended");
    expect((await read(id)).status).toBe("done");
  });

  it("presence race: no heartbeat yet counts from the start (fresh start → no claim)", async () => {
    const { id } = await meeting({ heartbeatAgoSec: null });
    const f = fakes();
    // started_at is 10 min ago in meeting(); a cutoff before it means "started recently".
    expect(await tick.claimEnd(id, { staleBefore: { cutoff: () => new Date(Date.now() - 20 * 60_000), hadHeartbeat: false }, deps: f.deps })).toBe("noop");
    expect(await tick.claimEnd(id, { abandon: true, staleBefore: { cutoff: () => new Date(Date.now() - 60_000), hadHeartbeat: false }, deps: f.deps })).toBe("claimed");
    const m = await read(id);
    expect(m.status).toBe("ending");
    // Abandoned: ended_at is the claim time (the 2 h resume window starts now).
    expect(Date.now() - Date.parse(m.ended_at!)).toBeLessThan(60_000);
  });

  it("presence: within the grace period (4 min without a tab) the meeting stays live", async () => {
    const { id, sessionId } = await meeting({ heartbeatAgoSec: 4 * 60 });
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    await tick.finalizeSweep({ deps: f.deps, orgId });
    const m = await read(id);
    expect(m.status).toBe("live");
    expect(m.ended_at).toBeNull();
  });

  it("ending twice is a no-op", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("ended");
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("noop");
    const m = await read(id);
    expect(m.status).toBe("done");
    expect(m.header_rendered).toMatch(/^Avslutat /);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].final).toBe(true);
    expect(await events(id, "ended")).toHaveLength(1);
    const { data: s } = await adminClient().from("el_sessions").select("closed_at").eq("id", sessionId).single();
    expect(s?.closed_at).not.toBeNull();
  });

  it("kill switch or dollar cap → no Claude call (end still finishes, header Avslutat)", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes();
    envOverride.KILL_SWITCH = true;
    await tick.maybeTick(id, f.deps);
    expect(f.renders()).toBe(0);
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("ended");
    expect(f.calls).toHaveLength(0);
    expect(f.headers.at(-1)).toMatch(/^Avslutat /);
    expect((await read(id)).status).toBe("done");

    envOverride.KILL_SWITCH = false;
    envOverride.GLOBAL_DAILY_USD = 0.000001;
    await adminClient().from("usage_daily").upsert({ org_id: orgId, day: new Date().toISOString().slice(0, 10), usd: 1 });
    const other = await meeting();
    await say(other.id, other.sessionId, "hej", 1000);
    await tick.maybeTick(other.id, f.deps);
    expect(await tick.runTick(other.id, { final: false }, f.deps)).toBe("ok"); // runs, but without Claude
    expect(f.calls).toHaveLength(0);
  });

  it("end route: 401 signed out, 404 for another org's member, starter ends (then noop)", async () => {
    const { id } = await meeting();
    const endCall = (mid: string) =>
      postEnd(new NextRequest(`https://x.test/api/meetings/${mid}/end`, { method: "POST" }), { params: Promise.resolve({ id: mid }) });
    const outsider = await createTestUser("outsider");
    // No stored Google token → the real final tick pauses the Doc (no network) and the end completes.
    await adminClient().from("google_tokens").delete().eq("user_id", starter.id);
    current.db = (await import("@/test/local-supabase")).anonClient();
    expect((await endCall(id)).status).toBe(401);
    current.db = outsider.db;
    expect((await endCall(id)).status).toBe(404);
    current.db = starter.db;
    expect((await endCall("nope")).status).toBe(404);
    scheduled.length = 0;
    // R1: answers at once with the meeting claimed as ending; the final pass runs after the response.
    const res = await endCall(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "ending" });
    expect((await read(id)).status).toBe("ending");
    expect(scheduled).toHaveLength(1);
    expect(await (await endCall(id)).json()).toEqual({ result: "noop" }); // already ending
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect((await read(id)).status).toBe("done");
    expect(await (await endCall(id)).json()).toEqual({ result: "noop" });
  });

  it("end with a failing Claude: stays ending (header Avslutat, transcript written); cron retries, after 3 attempts done + alarm", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const f = fakes({ claudeError: true });
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("ending");
    let m = await read(id);
    expect(m.status).toBe("ending");
    expect(m.end_attempts).toBe(1);
    expect(m.end_lease_until).toBeNull();
    expect(m.header_rendered).toMatch(/^Avslutat \d\d:\d\d$/);
    expect(f.calls.filter((c) => c.final)).toHaveLength(2);
    expect(f.appended.flat().map((l) => l.text)).toEqual(["hej"]);
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("noop");

    await tick.finalizeSweep({ deps: f.deps, orgId });
    expect((await read(id)).status).toBe("ending");
    await tick.finalizeSweep({ deps: f.deps, orgId });
    m = await read(id);
    expect(m.status).toBe("done");
    expect(m.end_attempts).toBe(3);
    expect(await events(id, "ended")).toEqual([expect.objectContaining({ detail: expect.objectContaining({ gaveUp: true }) })]);
    expect((await events(id, "alarm")).map((e) => (e.detail as { reason?: string }).reason)).toContain("no_final_pass");
    expect(f.mails).toContain("Simon Says: mötet avslutades utan slutpass");
  });

  it("a tick holding the lease past the end's deadline: stays ending, the cron's next run finishes it", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    const foreign = randomUUID();
    await adminClient()
      .from("meetings")
      .update({ tick_lease_until: new Date(Date.now() + 120_000).toISOString(), tick_lease_id: foreign })
      .eq("id", id);
    const f = fakes();
    expect(await tick.endMeeting(id, { deps: f.deps, deadlineAt: new Date(Date.now() + 30_000) })).toBe("ending");
    expect(f.calls).toHaveLength(0);
    const m = await read(id);
    expect(m.status).toBe("ending");
    expect(m.tick_lease_id).toBe(foreign); // not ours: left alone
    await adminClient().from("meetings").update({ tick_lease_until: null, tick_lease_id: null }).eq("id", id);
    await tick.finalizeSweep({ deps: f.deps, orgId });
    expect((await read(id)).status).toBe("done");
    expect(f.calls.filter((c) => c.final)).toHaveLength(1);
  });

  it("segments arriving during the final pass get a second final pass", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "först", 1000);
    let late = true;
    const f = fakes({
      onUpdate: async (input) => {
        if (input.final && late) {
          late = false;
          await say(id, sessionId, "sist", 2000); // ingest still accepts `ending`
        }
      },
    });
    expect(await tick.endMeeting(id, { deps: f.deps })).toBe("ended");
    expect(f.calls.filter((c) => c.final)).toHaveLength(2);
    expect(f.calls[1].transcriptBlocks.at(-1)).toContain("sist");
    expect(f.appended.flat().map((l) => l.text)).toEqual(["först", "sist"]);
    const { data: segs } = await adminClient().from("segments").select("tick_no").eq("meeting_id", id).is("tick_no", null);
    expect(segs).toEqual([]);
  });

  it("a tick releases only its own lease; not_found for a missing meeting", async () => {
    const { id, sessionId } = await meeting();
    await say(id, sessionId, "hej", 1000);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const f = fakes({ gate });
    const running = tick.runTick(id, { final: false }, f.deps);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    // Our lease "expired" and another tick took it.
    const other = randomUUID();
    await adminClient().from("meetings").update({ tick_lease_id: other }).eq("id", id);
    open();
    // B2: the stale tick saves no rows (the newer tick owns them) and reports busy.
    expect(await running).toBe("busy");
    const m = await read(id);
    expect(m.tick_lease_id).toBe(other);
    expect(m.tick_lease_until).not.toBeNull();
    expect(await tick.runTick(randomUUID(), { final: true }, f.deps)).toBe("not_found");
    expect(await tick.finishMeeting(randomUUID(), { deps: f.deps })).toBe("not_found");
  });

  it("a Privat recording without a Doc (0045): no Google at all, the stored rows are the notes", async () => {
    const { id, sessionId } = await meeting({ transcript: false });
    await adminClient().from("meetings").update({ doc_id: null, notes_tab_id: null, header_range: null }).eq("id", id);
    await say(id, sessionId, "Vi bestämmer budgeten", 1000);
    const f = fakes();
    const google = () => {
      throw new Error("a Doc-less meeting must not call Google");
    };
    const deps = { ...f.deps, getAuth: google, readNotes: google, render: google, appendTranscript: google };
    expect(await tick.runTick(id, { final: false }, deps)).toBe("ok");
    const items = async () => (await adminClient().from("note_items").select("id, text").eq("meeting_id", id).order("id")).data;
    expect(await items()).toEqual([{ id: "n1", text: "Beslut 1" }]);
    // The next tick starts from the stored rows: Claude sees n1 as a current item, nothing is lost.
    await say(id, sessionId, "Och lokalen", 2000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, deps)).toBe("ok");
    expect(f.calls[1].items.map((i) => i.id)).toEqual(["n1"]);
    expect(f.calls[1].notesTabText).toBe("");
    expect(await items()).toEqual([
      { id: "n1", text: "Beslut 1" },
      { id: "n2", text: "Beslut 2" },
    ]);
    // A lost Google grant can't pause it, and the end's final pass works the same way.
    expect(await tick.endMeeting(id, { deps })).toBe("ended");
    const m = await read(id);
    expect(m.status).toBe("done");
    expect(m.doc_paused_at).toBeNull();
  });
});

describe.skipIf(!hasLocalSupabase)("ticks in the format layout (A12)", () => {
  let starter: TestUser;
  let orgId: string;
  let profileId: string;
  let anna: string;

  beforeAll(async () => {
    starter = await createTestUser("formatticker");
    const r = await createOrg(starter.db, "Kodklubben");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    // Lines pinned without the concrete-tasks placeholders (tests/suite/tasks.test.ts covers those).
    await adminClient().from("orgs").update({ require_task_fields: false }).eq("id", orgId);
    profileId = await ensureStandardRow(orgId, "veckomote");
    const { data, error } = await adminClient()
      .from("people")
      .insert([
        { org_id: orgId, name: "Anna Berg", role: "Kassör" },
        { org_id: orgId, name: "Erik Lund" },
      ])
      .select("id, name");
    if (error) throw new Error(error.message);
    anna = data!.find((p) => p.name === "Anna Berg")!.id;
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  const OPEN = { startMs: null, endMs: null, closed: false, failures: 0 };

  /** A format meeting on the anchored fixture Doc, as startMeeting leaves it (info-tid row saved). */
  async function formatMeeting(
    opts: { window?: typeof OPEN | null; status?: "live" | "ending"; prerender?: NoteItemRow[]; isTest?: boolean; roles?: Record<string, import("@/lib/db/types").ItemRole> } = {},
  ) {
    const admin = adminClient();
    const id = randomUUID();
    const { doc, plan } = anchoredDoc(id);
    const { error } = await admin.from("meetings").insert({
      id,
      org_id: orgId,
      started_by: starter.id,
      doc_id: `doc-${id}`,
      notes_tab_id: TAB,
      transcript_tab_id: null,
      header_range: plan.headerRange,
      header_rendered: INITIAL_LIVE_LINE,
      section_ranges: plan.sectionRanges,
      status: opts.status ?? "live",
      consent_confirmed_at: FMT_STARTED.toISOString(),
      started_at: FMT_STARTED.toISOString(),
      ended_at: opts.status === "ending" ? FMT_ENDED.toISOString() : null,
      last_heartbeat_at: new Date().toISOString(),
      agenda_doc: true,
      layout: "format",
      format_profile_id: profileId,
      is_test: opts.isTest ?? false,
      agenda_roles: opts.roles ?? ROLES,
      checkin_window: opts.window === undefined ? null : opts.window,
    });
    if (error) throw new Error(error.message);
    let rows: NoteItemRow[] = plan.rows.map((r) => ({ ...r, meeting_id: id }));
    if (opts.prerender?.length) {
      // As the start's pre-fill renders the carried rows.
      const pre = opts.prerender.map((r) => ({ ...r, meeting_id: id }));
      rows = renderInto(doc, fmtMeeting(id, plan), [...rows, ...pre], [...rows, ...pre].map(toItem)).rows;
    }
    const { error: ie } = await admin.from("note_items").insert(rows);
    if (ie) throw new Error(ie.message);
    const sessionId = `el-${randomUUID()}`;
    const { error: se } = await admin
      .from("el_sessions")
      // Name round already done: these tests set speaker_map themselves.
      .insert({
        id: sessionId,
        meeting_id: id,
        max_seconds: 3600,
        // Meeting and session start together, so session-relative times are meeting-relative.
        started_at: FMT_STARTED.toISOString(),
        name_round_at: new Date().toISOString(),
      });
    if (se) throw new Error(se.message);
    return { id, sessionId, doc };
  }
  const toItem = (r: NoteItemRow): NotesItem => ({
    id: r.id,
    section: r.section,
    text: r.text,
    ...(r.owner ? { owner: r.owner } : {}),
    ...(r.anchor ? { anchor: r.anchor } : {}),
    ...(r.carried_from_id ? { carried: true } : {}),
  });

  let segCounter = 0;
  const sayAs = (meetingId: string, sessionId: string, speaker: string, text: string, startMs: number) =>
    ingestSegments(meetingId, [
      { elSessionId: sessionId, segmentIndex: segCounter++, runIndex: 0, speaker, text, startMs, endMs: startMs + 500 },
    ]);
  const say = (meetingId: string, sessionId: string, text: string, startMs: number) => sayAs(meetingId, sessionId, "speaker_0", text, startMs);

  type Found = import("@/lib/notes/checkin").CheckinFound | "failed";
  /** Fake Docs (the simulator, rendered by the planner the tick passes) and fake Claude calls. */
  function fakes(
    doc: Doc,
    opts: {
      answer?: (input: UpdateNotesInput) => NotesItem[];
      detect?: (lines: { atMs: number }[]) => Found | "throw";
      onDetect?: () => Promise<void>;
    } = {},
  ) {
    const calls: UpdateNotesInput[] = [];
    const detects: { lines: { atMs: number; text: string }[] }[] = [];
    const headers: (string | undefined)[] = [];
    const deps: Partial<import("@/lib/meetings/tick").TickDeps> = {
      getAuth: async () => ({}) as OAuth2Client,
      readNotes: async () => parseNotesTab(doc, TAB),
      render: async (_auth, m, rows, desired, rev, header, format): Promise<RenderResult> => {
        headers.push(header);
        if (!format) throw new Error("format meeting rendered without its planner");
        const tab = parseNotesTab(doc, TAB);
        if (tab.revisionId !== rev) return { status: "conflict" };
        const plan = format.plan(m, tab, rows, desired, {
          profile: format.profile,
          ownerLabel: format.ownerLabel,
          headerText: header,
          newAnchors: format.newAnchors,
        });
        applyDoc(doc, plan.requests);
        return { status: "ok", rows: renderedRows(m.id, rows, desired, plan), headerRendered: plan.header };
      },
      appendTranscript: async () => undefined,
      extractNames: async () => [],
      detectCheckin: async (input) => {
        detects.push(input);
        if (opts.onDetect) await opts.onDetect();
        const found = opts.detect ? opts.detect(input.lines) : { startMs: null, endMs: null };
        if (found === "throw") throw new Error("detector down");
        return { found, usage: null };
      },
      updateNotes: async (input): Promise<UpdateNotesResult> => {
        calls.push(input);
        const items = opts.answer ? opts.answer(input) : input.items;
        return {
          ops: [],
          items,
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.0001 },
          stopReason: "end_turn",
          dropped: 0,
          nextId: input.nextId ?? "n1",
          failure: null,
        };
      },
      mailer: { send: async () => false },
      sleep: async () => undefined,
      now: () => new Date("2026-11-25T17:31:00Z"),
    };
    return { deps, calls, detects, headers };
  }

  const read = async (id: string) => (await adminClient().from("meetings").select("*").eq("id", id).single()).data as MeetingRow;
  const noteRows = async (id: string) =>
    ((await adminClient().from("note_items").select("*").eq("meeting_id", id)).data ?? []) as NoteItemRow[];
  const backdate = (id: string) =>
    adminClient().from("meetings").update({ last_tick_at: new Date(Date.now() - 46_000).toISOString() }).eq("id", id);
  const events = async (id: string, kind: string) =>
    (await adminClient().from("meeting_events").select("kind, detail").eq("meeting_id", id).eq("kind", kind).order("id")).data ?? [];

  it("Claude gets the agenda (roles, human text) and the people with roles; the LIVE line is updated", async () => {
    const { id, sessionId, doc } = await formatMeeting();
    await say(id, sessionId, "Vi börjar med dagordningen", 1000);
    const f = fakes(doc);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.calls).toHaveLength(1);
    const input = f.calls[0];
    expect(input.agenda?.anchors.map((a) => [a.key, a.label, a.role])).toEqual([
      ["ag-1", "Godkänn dagordning", "procedural"],
      ["ag-2", "Må-runda", "checkin"],
      ["ag-3", "Från förra veckan", "followup"],
      ["ag-4", "Kommande event", "topic"],
      ["ag-5", "Ekonomi", "topic"],
      ["ag-6", "Övrigt", "other"],
    ]);
    expect(input.agenda?.anchors[3].humanText).toBe("Sommarfest på Kårallen\nWorkshop om sponsring");
    expect(input.agenda?.people).toEqual(expect.arrayContaining([{ name: "Anna Berg", role: "Kassör" }, { name: "Erik Lund", role: null }]));
    expect(input.agenda).toMatchObject({ formatName: "Veckomöte", groupBy: "role" });
    // Server rows are not Claude's.
    expect(input.items.map((i) => i.id)).toEqual([]);
    expect(f.headers[0]).toBe("Simon Says antecknar live · uppdaterad 18:31");
    expect(linesOf(doc)).toContain("Simon Says antecknar live · uppdaterad 18:31");
    expect((await read(id)).header_rendered).toBe("Simon Says antecknar live · uppdaterad 18:31");
    expect(f.detects).toHaveLength(0); // no check-in window on this meeting
    const ok = await events(id, "tick_ok");
    expect(ok).toEqual([{ kind: "tick_ok", detail: expect.objectContaining({ anchorsAdded: 0 }) }]);
  });

  it("a top-level item added by a human gets ag-7 (topic); the next tick lists it and can add under it; own lines are not human text", async () => {
    const { id, sessionId, doc } = await formatMeeting();
    insertItemBeforeOvrigt(doc, "Budget 2027");
    await say(id, sessionId, "Budgeten ska vara klar i januari", 1000);
    const add = (input: UpdateNotesInput, item: NotesItem) =>
      input.agenda?.anchors.some((a) => a.key === "ag-7" && !a.gone) ? [...input.items, item] : input.items;
    const f = fakes(doc, {
      answer: (input) =>
        input.items.length === 0
          ? add(input, { id: "n1", section: "note", text: "Budgeten ska vara klar i januari", anchor: "ag-7" })
          : add(input, { id: "n2", section: "decision", text: "Budgeten antas", anchor: "ag-7" }),
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.calls[0].agenda?.anchors.find((a) => a.key === "ag-7")).toMatchObject({ label: "Budget 2027", role: "topic" });
    let m = await read(id);
    expect((m.section_ranges as Record<string, string>)["ag-7"]).toBe(`ss-${id}-ag-7`);
    expect(m.agenda_roles?.["ag-7"]).toBe("topic");
    expect((await events(id, "tick_ok"))[0].detail).toMatchObject({ anchorsAdded: 1 });

    await say(id, sessionId, "Vi antar budgeten", 2000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    const ctx = f.calls[1].agenda!;
    expect(ctx.anchors.find((a) => a.key === "ag-7")).toMatchObject({ label: "Budget 2027", role: "topic" });
    expect(ctx.anchors.find((a) => a.key === "ag-6")).toMatchObject({ label: "Övrigt", role: "other" });
    expect(anchorRoles(ctx).get("ag-7")).toBe("topic");
    // F3: our line goes to Claude as ownLines (prefix as stored) and never as human text.
    expect(f.calls[1].ownLines).toContain("– Budgeten ska vara klar i januari.");
    const content = buildRequest(f.calls[1]).messages[0].content as { text: string }[];
    expect(content[content.length - 1].text).not.toContain("januari.");
    const lines = linesOf(doc);
    expect(lines.slice(lines.indexOf("Budget 2027"), lines.indexOf("Övrigt"))).toEqual([
      "Budget 2027",
      "– Budgeten ska vara klar i januari.",
      "– Beslut: Budgeten antas.",
    ]);
    m = await read(id);
    expect(Object.keys(m.section_ranges).filter((k) => k.startsWith("ag-"))).toHaveLength(7);
    const rows = await noteRows(id);
    expect(rows.find((r) => r.id === "n2")).toMatchObject({ anchor: "ag-7", kind: "decision" });
  });

  it("Må-runda: masked from the detector's start, block bytes kept, one 'Må-runda genomförd.' line that survives", async () => {
    const { id, sessionId, doc } = await formatMeeting({ window: OPEN });
    await say(id, sessionId, "Hej allihop", 1000);
    await say(id, sessionId, "Jag mår bra idag", 2000);
    await say(id, sessionId, "Lite trött", 3000);
    let tickNo = 0;
    const f = fakes(doc, {
      detect: () => {
        tickNo++;
        if (tickNo === 1) return { startMs: 2000, endMs: null }; // the second new line
        if (tickNo === 2) return { startMs: null, endMs: 5000 };
        return { startMs: null, endMs: null };
      },
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.detects[0].lines.map((l) => l.atMs)).toEqual([1000, 2000, 3000]);
    const block1 = f.calls[0].transcriptBlocks[0];
    expect(block1).toContain(CHECKIN_PLACEHOLDER);
    expect(block1).not.toMatch(/mår bra|trött/);
    expect((await read(id)).checkin_window).toEqual({ startMs: 2000, endMs: null, closed: false, failures: 0, calls: 1 });

    await say(id, sessionId, "Jag har sovit dåligt", 4000);
    await say(id, sessionId, "Nu tar vi förra veckan", 5000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect((await read(id)).checkin_window).toEqual({ startMs: 2000, endMs: 5000, closed: true, failures: 0, calls: 2 });
    expect(linesOf(doc).filter((l) => l === "– Må-runda genomförd.")).toHaveLength(1);

    await say(id, sessionId, "Mejlet är skickat", 6000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.detects).toHaveLength(2); // closed: no detector call
    const blocks = f.calls[2].transcriptBlocks;
    expect(blocks[0]).toBe(block1);
    expect(blocks.join("\n")).not.toMatch(/mår bra|trött|sovit/);
    expect(blocks[1]).toContain("Nu tar vi förra veckan");
    expect(linesOf(doc).filter((l) => l === "– Må-runda genomförd.")).toHaveLength(1);
    const done = (await noteRows(id)).find((r) => r.id === "checkin-done");
    expect(done).toMatchObject({ anchor: "ag-2", text: "Må-runda genomförd.", locked: false, range_name: `ss-${id}-checkin-done` });
    // Claude never sees the server row.
    expect(f.calls[2].items.map((i) => i.id)).not.toContain("checkin-done");
    // Events: states and times only.
    expect((await events(id, "checkin")).map((e) => e.detail)).toEqual([
      { state: "open", startMs: 2000, endMs: null },
      { state: "closed", startMs: 2000, endMs: 5000 },
    ]);
  });

  it("Må-runda hiding off (the default start): no detector call, nothing masked, notes land under the Må-runda", async () => {
    // As startMeeting leaves a meeting whose format has no hideCheckin (every format by default).
    const roles = meetingRoles(ROLES, VECKOMOTE);
    expect(roles["ag-2"]).toBe("procedural");
    const { id, sessionId, doc } = await formatMeeting({ roles, window: null });
    await say(id, sessionId, "Jag mår bra idag", 1000);
    await say(id, sessionId, "Lite trött men på plats", 2000);
    const f = fakes(doc, {
      detect: () => ({ startMs: 1000, endMs: null }),
      answer: (input) => [...input.items, { id: "n1", section: "note", text: "Alla är på plats", anchor: "ag-2" }],
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.detects).toHaveLength(0);
    const blocks = f.calls[0].transcriptBlocks.join("\n");
    expect(blocks).toMatch(/mår bra/);
    expect(blocks).toMatch(/trött/);
    expect(blocks).not.toContain(CHECKIN_PLACEHOLDER);
    expect(f.calls[0].agenda?.anchors.find((a) => a.key === "ag-2")).toMatchObject({ label: "Må-runda", role: "procedural" });
    expect(linesOf(doc)).toContain("– Alla är på plats.");
    expect((await read(id)).checkin_window).toBeNull();
    expect((await noteRows(id)).map((r) => r.id)).not.toContain("checkin-done");
    expect(await events(id, "checkin")).toEqual([]);
  });

  it("a detector failing 3 ticks in a row closes the window (nothing masked)", async () => {
    const { id, sessionId, doc } = await formatMeeting({ window: OPEN });
    const f = fakes(doc, { detect: () => "failed" });
    for (let i = 0; i < 3; i++) {
      await say(id, sessionId, `rad ${i}`, 1000 + i * 1000);
      await backdate(id);
      expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    }
    expect((await read(id)).checkin_window).toMatchObject({ closed: true, startMs: null, failures: 3 });
    expect(f.calls.at(-1)!.transcriptBlocks.join("\n")).not.toContain(CHECKIN_PLACEHOLDER);
    expect((await noteRows(id)).map((r) => r.id)).not.toContain("checkin-done");
  });

  it("kill switch: neither the detector nor the notes call; carried rows and the Doc stay", async () => {
    const prev = await prevMeeting();
    const { id, sessionId, doc } = await formatMeeting({ window: OPEN, prerender: [carried(prev)] });
    const before = docText(doc);
    expect(linesOf(doc)).toContain("– Kassör: Mejla klubben om avgiften.");
    await say(id, sessionId, "Hej", 1000);
    envOverride.KILL_SWITCH = true;
    const f = fakes(doc, { detect: () => ({ startMs: 1000, endMs: null }) });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.detects).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect((await read(id)).checkin_window).toEqual(OPEN);
    expect((await noteRows(id)).map((r) => r.id).sort()).toEqual(["c1", "info-datum", "info-tid"]);
    // Only the LIVE line moved.
    expect(docText(doc).replace("uppdaterad 18:31", "uppdaterad –")).toBe(before);
  });

  /** A finished earlier meeting of the org with one open task (Anna Berg's). */
  async function prevMeeting(): Promise<string> {
    const admin = adminClient();
    const id = randomUUID();
    const { error } = await admin.from("meetings").insert({
      id,
      org_id: orgId,
      started_by: starter.id,
      doc_id: `doc-${id}`,
      notes_tab_id: TAB,
      status: "done",
      consent_confirmed_at: new Date().toISOString(),
      started_at: new Date("2026-11-18T17:05:00Z").toISOString(),
      layout: "format",
    });
    if (error) throw new Error(error.message);
    const { error: ie } = await admin.from("note_items").insert({
      meeting_id: id,
      id: "n3",
      section: "action",
      kind: "task",
      text: "Mejla klubben om avgiften",
      owner: "Anna Berg",
      done: false,
    });
    if (ie) throw new Error(ie.message);
    return id;
  }
  const carried = (prev: string): NoteItemRow => ({
    meeting_id: "",
    id: "c1",
    section: "action",
    kind: "task",
    anchor: "ag-3",
    text: "Mejla klubben om avgiften",
    owner: "Kassör",
    due: null,
    owner_person_id: anna,
    locked: false,
    deleted_by_human: false,
    done: false,
    carried_from_meeting: prev,
    carried_from_id: "n3",
    copy_of: null,
    range_name: null,
    last_rendered_text: null,
    position: 0,
  });

  it("change c1 done:true → '✓ klart' in the Doc and the previous meeting's task is done", async () => {
    const prev = await prevMeeting();
    const { id, sessionId, doc } = await formatMeeting({ prerender: [carried(prev)] });
    await say(id, sessionId, "Mejlet till klubben är skickat", 1000);
    const f = fakes(doc, { answer: (input) => input.items.map((i) => (i.id === "c1" ? { ...i, done: true } : i)) });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.calls[0].items).toEqual([expect.objectContaining({ id: "c1", carried: true })]);
    expect(linesOf(doc)).toContain("– Kassör: Mejla klubben om avgiften. ✓ klart");
    const rows = await noteRows(id);
    expect(rows.find((r) => r.id === "c1")).toMatchObject({ done: true, owner_person_id: anna, carried_from_id: "n3" });
    const { data: source } = await adminClient().from("note_items").select("done").eq("meeting_id", prev).eq("id", "n3").single();
    expect(source?.done).toBe(true);
  });

  it("a new task gets its owner's person id and a tasks-section copy", async () => {
    const { id, sessionId, doc } = await formatMeeting();
    await say(id, sessionId, "Anna bokar salen", 1000);
    const f = fakes(doc, {
      answer: (input) => [...input.items, { id: "n1", section: "action", text: "Boka salen", owner: "Anna Berg", anchor: "ag-4" }],
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    const rows = await noteRows(id);
    expect(rows.find((r) => r.id === "n1")).toMatchObject({ owner_person_id: anna, kind: "task", anchor: "ag-4" });
    expect(rows.find((r) => r.id === "n1-t")).toMatchObject({ anchor: "tasks", copy_of: "n1" });
    expect(linesOf(doc).filter((l) => l.includes("Kassör: Boka salen."))).toHaveLength(2);
  });

  it("an agenda Testmöte (A13) uses the fixture's people: roles reach Claude and the Doc, no people rows, no owner ids", async () => {
    const { id, sessionId, doc } = await formatMeeting({ isTest: true });
    await say(id, sessionId, "Oskar betalar hyran", 1000);
    const f = fakes(doc, {
      answer: (input) => [...input.items, { id: "n1", section: "action", text: "Betala hyran", owner: "Oskar Berglund", anchor: "ag-5" }],
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    // The fixture's five people, not the förening's (Anna Berg, Erik Lund).
    expect(f.calls[0].agenda?.people).toEqual([
      { name: "Maja Lindqvist", role: "Ordförande" },
      { name: "Oskar Berglund", role: "Kassör" },
      { name: "Elin Sjöberg", role: "Sekreterare" },
      { name: "Sam Carter", role: "PR-ansvarig" },
      { name: "Fatima Rahimi", role: "Eventansvarig" },
    ]);
    const rows = await noteRows(id);
    expect(rows.find((r) => r.id === "n1")).toMatchObject({ owner_person_id: null, kind: "task", anchor: "ag-5" });
    expect(rows.find((r) => r.id === "n1-t")).toMatchObject({ anchor: "tasks", copy_of: "n1", owner_person_id: null });
    expect(linesOf(doc).filter((l) => l.includes("Kassör: Betala hyran."))).toHaveLength(2);
    // Nothing was added to the förening's people.
    const { data: people } = await adminClient().from("people").select("name").eq("org_id", orgId);
    expect((people ?? []).map((p) => p.name)).not.toContain("Oskar Berglund");
  });

  it("two named speakers fill the Närvarande cell: 'Anna Berg, Erik Lund'", async () => {
    const { id, sessionId, doc } = await formatMeeting();
    await sayAs(id, sessionId, "speaker_1", "Hej, Anna här", 1000);
    await sayAs(id, sessionId, "speaker_0", "Och Erik", 2000);
    await adminClient().from("speaker_map").insert([
      { meeting_id: id, el_session_id: sessionId, speaker_label: "speaker_0", display_name: "Erik Lund" },
      { meeting_id: id, el_session_id: sessionId, speaker_label: "speaker_1", display_name: "Anna Berg" },
    ]);
    const f = fakes(doc);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect((await noteRows(id)).find((r) => r.id === "info-narvarande")).toMatchObject({
      text: "Anna Berg, Erik Lund",
      anchor: "info.narvarande",
      kind: "attendee",
    });
    const lines = linesOf(doc);
    expect(lines[lines.indexOf("Närvarande") + 1]).toBe("Anna Berg, Erik Lund");
    expect(f.calls[0].items.map((i) => i.id)).not.toContain("info-narvarande");
  });

  it("final pass: 'Simon Says · avslutat 19:10' and Tid '18:05–19:10'", async () => {
    const { id, sessionId, doc } = await formatMeeting({ status: "ending" });
    await say(id, sessionId, "Tack för idag", 1000);
    const f = fakes(doc);
    expect(await tick.runTick(id, { final: true }, f.deps)).toBe("ok");
    expect(f.headers.at(-1)).toBe("Simon Says · avslutat 19:10");
    expect((await read(id)).header_rendered).toBe("Simon Says · avslutat 19:10");
    const lines = linesOf(doc);
    expect(lines).toContain("Simon Says · avslutat 19:10");
    expect(lines[lines.indexOf("Tid") + 1]).toBe("18:05–19:10");
    expect((await noteRows(id)).find((r) => r.id === "info-tid")).toMatchObject({ text: "18:05–19:10", last_rendered_text: "18:05–19:10" });
    await adminClient().from("meetings").update({ status: "done" }).eq("id", id);
  });

  // Fix round 1 -------------------------------------------------------------------------------

  it("detector skipped (deadline) while the start is unknown: no notes call, nothing sent; the next tick sends them masked", async () => {
    const { id, sessionId, doc } = await formatMeeting({ window: OPEN });
    await say(id, sessionId, "Hej allihop", 1000);
    await say(id, sessionId, "Jag mår bra idag", 2000);
    const f = fakes(doc, { detect: (lines) => ({ startMs: lines[1].atMs, endMs: null }) });
    // 60 s left: enough for the notes call (30 s), not for the detector (75 s).
    const deadlineAt = new Date(f.deps.now!().getTime() + 60_000);
    expect(await tick.runTick(id, { final: false, deadlineAt }, f.deps)).toBe("ok");
    expect(f.detects).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect((await read(id)).notes_sent_tick ?? 0).toBe(0);
    expect((await events(id, "tick_ok"))[0].detail).toMatchObject({ held: true });

    await say(id, sessionId, "Lite trött", 3000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    // The detector reads every unsent line (the held tick's too) and finds the start in the held tick.
    expect(f.detects[0].lines.map((l) => l.atMs)).toEqual([1000, 2000, 3000]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].transcriptBlocks).toEqual([
      `[00:00:01] S1-speaker_0: Hej allihop\n[00:00:02] –: ${CHECKIN_PLACEHOLDER}`,
      `[00:00:03] –: ${CHECKIN_PLACEHOLDER}`,
    ]);
    expect((await read(id)).notes_sent_tick).toBe(2);
  });

  it("a detector that throws holds the notes too (start unknown)", async () => {
    const { id, sessionId, doc } = await formatMeeting({ window: OPEN });
    await say(id, sessionId, "Jag mår bra idag", 1000);
    const f = fakes(doc, { detect: () => "throw" });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(f.detects).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
    expect((await read(id)).checkin_window).toEqual({ startMs: null, endMs: null, closed: false, failures: 1, calls: 1 });
  });

  it("end pass with the start still unknown and no detector answer: over-masks the unsent lines, closes, no Må-runda line", async () => {
    const { id, sessionId, doc } = await formatMeeting({ window: OPEN, status: "ending" });
    await say(id, sessionId, "Hej allihop", 1000);
    await say(id, sessionId, "Jag mår bra idag", 2000);
    const f = fakes(doc, { detect: () => "throw" });
    expect(await tick.runTick(id, { final: true }, f.deps)).toBe("ok");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].transcriptBlocks).toEqual([`[00:00:01] –: ${CHECKIN_PLACEHOLDER}`]);
    expect((await read(id)).checkin_window).toEqual({ startMs: 1000, endMs: 2001, closed: true, failures: 3, calls: 1 });
    expect(linesOf(doc)).not.toContain("– Må-runda genomförd.");
    expect(linesOf(doc)).toContain("Simon Says · avslutat 19:10");
    await adminClient().from("meetings").update({ status: "done" }).eq("id", id);
  });

  it("R-A6: a human-edited task keeps its tasks copy updating ('✓ klart' there, the human's line untouched)", async () => {
    const { id, sessionId, doc } = await formatMeeting();
    await say(id, sessionId, "Anna bokar salen", 1000);
    let round = 0;
    const f = fakes(doc, {
      answer: (input) =>
        ++round === 1
          ? [...input.items, { id: "n1", section: "action", text: "Boka salen", owner: "Anna Berg", anchor: "ag-4" }]
          : input.items.map((i) => (i.id === "n1" ? { ...i, done: true } : i)),
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    expect(linesOf(doc).filter((l) => l === "Kassör: Boka salen.")).toHaveLength(2);
    // A human edits the primary (under Kommande event): it locks.
    const span = itemSpan(parseNotesTab(doc, TAB), `ss-${id}-n1`)!;
    applyDoc(doc, [{ insertText: { text: " gärna", location: { tabId: TAB, index: span.paraEnd - 2 } } }]);

    await say(id, sessionId, "Salen är bokad", 2000);
    await backdate(id);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    const input = f.calls[1];
    expect(input.items).toEqual([expect.objectContaining({ id: "n1", anchor: "ag-4", text: "Boka salen" })]);
    expect(input.locked.map((i) => i.id)).not.toContain("n1");
    expect(input.deletedIds).not.toContain("n1");
    const lines = linesOf(doc);
    expect(lines).toContain("Kassör: Boka salen gärna.");
    expect(lines).toContain("Kassör: Boka salen. ✓ klart");
    const rows = await noteRows(id);
    expect(rows.find((r) => r.id === "n1")).toMatchObject({ locked: true, done: false });
    expect(rows.find((r) => r.id === "n1-t")).toMatchObject({ locked: false, done: true, anchor: "tasks", copy_of: "n1" });
  });

  it("a tick whose lease moved on stores no check-in window (busy)", async () => {
    const { id, sessionId, doc } = await formatMeeting({ window: OPEN });
    await say(id, sessionId, "Jag mår bra idag", 1000);
    const f = fakes(doc, {
      detect: () => ({ startMs: 1000, endMs: null }),
      onDetect: async () => {
        await adminClient().from("meetings").update({ tick_lease_id: randomUUID() }).eq("id", id);
      },
    });
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("busy");
    expect((await read(id)).checkin_window).toEqual(OPEN);
    expect(f.calls).toHaveLength(0);
    await adminClient().from("meetings").update({ tick_lease_id: null, tick_lease_until: null }).eq("id", id);
  });

  it("an ag-N range of ours missing from the map is adopted, not duplicated", async () => {
    const { id, sessionId, doc } = await formatMeeting();
    insertItemBeforeOvrigt(doc, "Budget 2027");
    const m0 = await read(id);
    const tab0 = parseNotesTab(doc, TAB);
    const fresh = newAgendaItems(scanAgenda(tab0, VECKOMOTE), tab0, m0.section_ranges);
    // An earlier render made the range, but storing the map failed.
    renderInto(doc, m0, [], [], { newAnchors: fresh });
    await say(id, sessionId, "Budgeten", 1000);
    const f = fakes(doc);
    expect(await tick.runTick(id, { final: false }, f.deps)).toBe("ok");
    const m = await read(id);
    expect((m.section_ranges as Record<string, string>)["ag-7"]).toBe(`ss-${id}-ag-7`);
    expect(m.agenda_roles?.["ag-7"]).toBe("topic");
    expect(parseNotesTab(doc, TAB).ranges.get(`ss-${id}-ag-7`)).toHaveLength(1);
    expect(f.calls[0].agenda?.anchors.find((a) => a.key === "ag-7")).toMatchObject({ label: "Budget 2027", role: "topic" });
    expect((await events(id, "tick_ok"))[0].detail).toMatchObject({ anchorsAdded: 0 });
  });
});
