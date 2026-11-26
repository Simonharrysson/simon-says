import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthLostError } from "@/lib/google/client";

type Filter = [op: string, col: string, val: unknown];
interface Query {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filters: Filter[];
}

const m = vi.hoisted(() => ({
  user: { id: "u1", email: "Starter@x.se" } as { id: string; email: string } | null,
  active: [] as { id: string }[],
  getOrg: vi.fn(),
  myRole: vi.fn(),
  memberEmails: vi.fn(),
  recordDocShares: vi.fn(),
  trashDoc: vi.fn(),
  getGoogleAuth: vi.fn(),
  createMeetingDoc: vi.fn(),
  createFormatDoc: vi.fn(),
  addTranscriptTab: vi.fn(),
  checkAgendaDoc: vi.fn(),
  anchorAgenda: vi.fn(),
  cleanupLosingAnchor: vi.fn(async (..._a: unknown[]) => 3),
  readNotesTab: vi.fn(),
  renderItems: vi.fn(),
  insert: vi.fn(),
  logEvent: vi.fn(),
  del: vi.fn(),
  killSwitch: false,
  /** The user's live meetings (any org) and meetings started in the last hour, as the admin client sees them. */
  liveRows: (): { id: string; started_at: string }[] => [],
  recentRows: (): { id: string; started_at: string }[] => [],
  guard: vi.fn(async (_fn: string, _args: unknown) => ({ data: "ok" as string, error: null })),
  /** Rows of other tables, as the admin client sees them. */
  docMeetings: [] as { id: string; doc_id: string; status: string }[],
  prevMeetings: [] as { id: string; org_id: string; is_test: boolean; status: string; started_at: string; agenda_doc?: boolean }[],
  profiles: [] as { id: string; org_id: string; kind: string; profile: unknown; is_default: boolean; created_at?: string }[],
  people: [] as { id: string; name: string; role: string | null; org_id: string }[],
  noteRows: [] as Record<string, unknown>[],
  noteInsert: vi.fn(),
  meetingUpdate: vi.fn(),
  noteUpdate: vi.fn(),
  profileInsert: vi.fn(),
  queries: [] as Query[],
  /** prepared_agendas rows (0033), as the admin client sees them. */
  prepared: [] as Record<string, unknown>[],
}));

const has = (q: Query, op: string, col: string) => q.filters.some((f) => f[0] === op && f[1] === col);
const val = (q: Query, col: string) => q.filters.find((f) => f[1] === col)?.[2];

/** The admin client's answer to one query: `{ data, error }` with `data` an array (or null for writes). */
async function adminAnswer(q: Query): Promise<{ data: unknown; error: null }> {
  m.queries.push(q);
  const ok = (data: unknown) => ({ data, error: null });
  if (q.table === "meetings") {
    if (q.op === "insert") return m.insert(q.payload);
    if (q.op === "update") return (m.meetingUpdate(q.payload, val(q, "id")), ok(null));
    if (q.op === "delete") return (m.del(val(q, "id")), ok(null));
    if (has(q, "eq", "doc_id")) {
      const statuses = val(q, "status") as string[];
      return ok(m.docMeetings.filter((r) => r.doc_id === val(q, "doc_id") && statuses.includes(r.status)));
    }
    if (has(q, "eq", "started_by") && has(q, "gte", "started_at")) return ok(m.recentRows());
    if (has(q, "eq", "started_by")) return ok(m.liveRows());
    if (has(q, "eq", "is_test")) {
      return ok(
        m.prevMeetings
          .filter((r) => r.org_id === val(q, "org_id") && r.is_test === val(q, "is_test") && r.status === "done")
          .filter((r) => !has(q, "eq", "agenda_doc") || (r.agenda_doc ?? false) === val(q, "agenda_doc"))
          .sort((a, b) => b.started_at.localeCompare(a.started_at)),
      );
    }
  }
  if (q.table === "format_profiles") {
    if (q.op === "insert") return ok([{ id: m.profileInsert(q.payload) }]);
    return ok(
      m.profiles.filter((p) =>
        q.filters.every(([op, col, v]) => op !== "eq" || (p as Record<string, unknown>)[col] === v),
      ),
    );
  }
  if (q.table === "people") return ok(m.people.filter((p) => p.org_id === val(q, "org_id")));
  if (q.table === "prepared_agendas") return ok(m.prepared.filter((p) => p.org_id === val(q, "org_id") && p.doc_id === val(q, "doc_id")));
  if (q.table === "note_items") {
    if (q.op === "insert") return (m.noteInsert(q.payload), ok(null));
    if (q.op === "update") return (m.noteUpdate(q.payload, val(q, "id")), ok(null));
    return ok(m.noteRows.filter((r) => r.meeting_id === val(q, "meeting_id")));
  }
  throw new Error(`unexpected admin query ${q.op} ${q.table}`);
}

/** A chainable, awaitable PostgREST stand-in recording the filters. */
function builder(table: string) {
  const q: Query = { table, op: "select", filters: [] };
  let one = false;
  const b: Record<string, unknown> = {
    select: () => b,
    insert: (p: unknown) => ((q.op = "insert"), (q.payload = p), b),
    update: (p: unknown) => ((q.op = "update"), (q.payload = p), b),
    delete: () => ((q.op = "delete"), b),
    order: () => b,
    limit: () => b,
    maybeSingle: () => ((one = true), b),
    single: () => ((one = true), b),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      adminAnswer(q)
        .then((r) => (one && Array.isArray(r.data) ? { ...r, data: r.data[0] ?? null } : r))
        .then(resolve, reject),
  };
  for (const op of ["eq", "in", "lt", "gte"]) b[op] = (col: string, v: unknown) => (q.filters.push([op, col, v]), b);
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: m.user } }) },
    from: () => ({
      select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: m.active, error: null }) }) }) }),
    }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ rpc: m.guard, from: (table: string) => builder(table) }),
}));
vi.mock("@/lib/db/orgs", () => ({ getOrg: m.getOrg, myRole: m.myRole }));
vi.mock("@/lib/db/members", () => ({ orgMemberList: m.memberEmails }));
vi.mock("@/lib/docs/access", () => ({ recordDocShares: m.recordDocShares }));
vi.mock("@/lib/db/events", () => ({ logEvent: m.logEvent }));
vi.mock("@/lib/docs/create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docs/create")>()),
  createMeetingDoc: m.createMeetingDoc,
  createFormatDoc: m.createFormatDoc,
  addTranscriptTab: m.addTranscriptTab,
  trashDoc: m.trashDoc,
}));
vi.mock("@/lib/agenda/access", () => ({ checkAgendaDoc: m.checkAgendaDoc }));
vi.mock("@/lib/agenda/anchor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agenda/anchor")>()),
  anchorAgenda: m.anchorAgenda,
  cleanupLosingAnchor: m.cleanupLosingAnchor,
}));
vi.mock("@/lib/docs/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docs/notes")>()),
  readNotesTab: m.readNotesTab,
  renderItems: m.renderItems,
}));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ KILL_SWITCH: m.killSwitch }) }));
vi.mock("@/lib/google/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/client")>()),
  getGoogleAuth: m.getGoogleAuth,
}));

const { POST } = await import("@/app/api/meetings/route");
const { AgendaShapeError } = await import("@/lib/agenda/anchor");
const { planFormatRender } = await import("@/lib/docs/format-render");
const { VECKOMOTE, STYRELSEPROTOKOLL } = await import("@/lib/formats/standard");
const { rolesFromSkeleton } = await import("@/lib/formats/skeleton");

const ORG = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const call = (body: unknown) =>
  POST(
    new NextRequest("https://x.test/api/meetings", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
const doc = {
  docId: "doc1",
  notesTabId: "t.0",
  transcriptTabId: "t.1",
  headerRange: "ss-x-header",
  headerRendered: "LIVE · uppdaterad –",
  sectionRanges: { attendees: "a", decision: "b", action: "c", now: "d" },
  place: "own_folder",
  shared: ["b@x.se"],
  shareFailed: [],
};

beforeEach(() => {
  Object.assign(m, { user: { id: "u1", email: "Starter@x.se" }, active: [], killSwitch: false });
  m.getOrg.mockReset().mockResolvedValue({ id: ORG, name: "Styrelsen", share_transcript: true });
  m.myRole.mockReset().mockResolvedValue("member");
  m.memberEmails.mockReset().mockResolvedValue([
    { userId: "u1", email: "starter@x.se", role: "admin" },
    { userId: "u2", email: "b@x.se", role: "member" },
  ]);
  m.recordDocShares.mockReset().mockResolvedValue(undefined);
  m.trashDoc.mockReset().mockResolvedValue(undefined);
  m.getGoogleAuth.mockReset().mockResolvedValue({});
  m.createMeetingDoc.mockReset().mockResolvedValue(doc);
  m.insert.mockReset().mockResolvedValue({ error: null });
  m.logEvent.mockReset().mockResolvedValue(undefined);
  m.del.mockReset();
  m.liveRows = () => [];
  m.recentRows = () => [];
  m.guard.mockReset().mockResolvedValue({ data: "ok", error: null });
  m.createFormatDoc.mockReset().mockResolvedValue({ docId: "fdoc", tabId: "t.f", transcriptTabId: "t.ft", place: "meeting_folder", shared: [], shareFailed: [] });
  m.addTranscriptTab.mockReset().mockResolvedValue("t.tr");
  m.checkAgendaDoc.mockReset().mockResolvedValue({ ok: true, name: "Mötesprotokoll v48" });
  m.anchorAgenda.mockReset().mockImplementation(async (_auth: unknown, input: { meetingId: string; tabId?: string }) =>
    anchored(input.meetingId, input.tabId ?? "t.0"),
  );
  m.cleanupLosingAnchor.mockReset().mockResolvedValue(3);
  m.readNotesTab.mockReset().mockResolvedValue({ revisionId: "r3" });
  m.renderItems.mockReset().mockImplementation(async (_a: unknown, meeting: { id: string }, rows: Record<string, unknown>[]) => ({
    status: "ok",
    headerRendered: null,
    rows: rows.map((r, i) => ({ ...r, range_name: r.range_name ?? `ss-${meeting.id}-${r.id}`, last_rendered_text: r.last_rendered_text ?? `line ${r.id}`, position: 10 + i })),
  }));
  m.noteInsert.mockReset();
  m.meetingUpdate.mockReset();
  m.noteUpdate.mockReset();
  m.profileInsert.mockReset().mockReturnValue("std1");
  Object.assign(m, { docMeetings: [], prevMeetings: [], profiles: [], people: [], noteRows: [], queries: [], prepared: [] });
});

/** What anchorAgenda returns for a fictional six-item Veckomöte agenda Doc. */
function anchored(meetingId: string, tabId: string, roles: Record<string, string> = AGENDA_ROLES) {
  const items = Object.keys(roles);
  return {
    tabId,
    revisionId: "r2",
    sectionRanges: {
      ...Object.fromEntries(items.map((k) => [k, `ss-${meetingId}-${k}`])),
      tasks: `ss-${meetingId}-sec-tasks`,
      notes: `ss-${meetingId}-sec-notes`,
    },
    headerRange: `ss-${meetingId}-header`,
    headerRendered: "Simon Says antecknar live · uppdaterad –",
    agendaRoles: roles,
    rows: [
      {
        meeting_id: meetingId,
        id: "info-tid",
        section: "note",
        text: "18:05",
        owner: null,
        due: null,
        locked: false,
        deleted_by_human: false,
        last_rendered_text: "18:05",
        range_name: `ss-${meetingId}-info-tid`,
        position: 0,
        kind: "note",
        anchor: "info.tid",
        done: false,
        copy_of: null,
      },
    ],
    scan: { items: [] },
    appended: ["Anteckningar"],
  };
}
const AGENDA_ROLES = {
  "ag-1": "procedural",
  "ag-2": "checkin",
  "ag-3": "followup",
  "ag-4": "topic",
  "ag-5": "topic",
  "ag-6": "other",
};
const AGENDA_DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
const PROFILE_ID = "11111111-2222-3333-4444-555555555555";
const insertedRow = () => m.insert.mock.calls[0][0];
const eventsOf = (kind: string) => m.logEvent.mock.calls.filter((c) => c[1] === kind);
/** Nothing was written anywhere: no meeting row, no note rows, no format row, no Doc writes, no events. */
function expectNoWrites() {
  expect(m.insert).not.toHaveBeenCalled();
  expect(m.noteInsert).not.toHaveBeenCalled();
  expect(m.profileInsert).not.toHaveBeenCalled();
  expect(m.anchorAgenda).not.toHaveBeenCalled();
  expect(m.addTranscriptTab).not.toHaveBeenCalled();
  expect(m.createMeetingDoc).not.toHaveBeenCalled();
  expect(m.createFormatDoc).not.toHaveBeenCalled();
  expect(m.logEvent).not.toHaveBeenCalled();
}

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

describe("POST /api/meetings", () => {
  it("creates the Doc and the meeting row, and returns meetingId + docUrl", async () => {
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.docUrl).toBe("https://docs.google.com/document/d/doc1/edit");
    expect(json.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}\.\d{2} Mötesprotokoll – Styrelsen$/); // every format
    expect(json.docPlace).toBe("own_folder");
    expect(json.shareFailed).toBe(0); // C10: the page warns when members didn't get access
    const input = m.createMeetingDoc.mock.calls[0][1];
    expect(input).toMatchObject({ orgName: "Styrelsen", shareTranscript: true, meetingId: json.meetingId });
    expect(input.memberEmails).toEqual(["b@x.se"]); // the starter is not shared with
    expect(input.title).toBe(json.title);
    expect(input.meetingFolderId).toBeNull();
    expect(m.recordDocShares).toHaveBeenCalledWith(json.meetingId, ["u2"]);
    const row = m.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      id: json.meetingId,
      org_id: ORG,
      started_by: "u1",
      doc_id: "doc1",
      notes_tab_id: "t.0",
      transcript_tab_id: "t.1",
      header_range: "ss-x-header",
      header_rendered: "LIVE · uppdaterad –",
      section_ranges: doc.sectionRanges,
      status: "live",
    });
    expect(typeof row.consent_confirmed_at).toBe("string");
    expect(m.logEvent).toHaveBeenCalledWith(json.meetingId, "started", expect.any(Object));
  });

  it("401 without a session, 400 without consent or with a bad org id", async () => {
    m.user = null;
    expect((await call({ orgId: ORG, consent: true })).status).toBe(401);
    m.user = { id: "u1", email: "s@x.se" };
    expect((await call({ orgId: ORG })).status).toBe(400);
    expect((await call({ orgId: ORG, consent: "true" })).status).toBe(400);
    expect((await call({ orgId: "nope", consent: true })).status).toBe(400);
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
  });

  it("404 for an org the user cannot see, 403 for a non-member", async () => {
    m.getOrg.mockResolvedValue(null);
    expect((await call({ orgId: ORG, consent: true })).status).toBe(404);
    m.getOrg.mockResolvedValue({ id: ORG, name: "S", share_transcript: true });
    m.myRole.mockResolvedValue(null);
    expect((await call({ orgId: ORG, consent: true })).status).toBe(403);
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
  });

  it("409 when the org already has a live meeting, and creates nothing", async () => {
    m.active = [{ id: "live1" }];
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_live");
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
  });

  it("asks the user to sign in again when the Google grant is gone", async () => {
    m.getGoogleAuth.mockRejectedValue(new GoogleAuthLostError("u1", "invalid_grant"));
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("google_auth_lost");
    expect(json.message).toMatch(/Logga ut och in/);
    expect(m.insert).not.toHaveBeenCalled();
  });

  it("leaves no meeting row behind when the Doc cannot be created", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.createMeetingDoc.mockRejectedValue(new Error("drive down"));
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/mötesdokumentet/);
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.logEvent).not.toHaveBeenCalled();
  });

  it("503 when the kill switch is on", async () => {
    m.killSwitch = true;
    expect((await call({ orgId: ORG, consent: true })).status).toBe(503);
  });

  it("still succeeds when only the event log write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.logEvent.mockRejectedValue(new Error("x"));
    expect((await call({ orgId: ORG, consent: true })).status).toBe(200);
  });

  it("409 starter_busy when the user already has a live meeting in any org (Ruling 39), before creating a Doc", async () => {
    m.liveRows = () => [{ id: "other", started_at: ago(600) }];
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("starter_busy");
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
  });

  it("429 start_rate at 6 starts in the last hour", async () => {
    m.recentRows = () => Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, started_at: ago(3000 - i) }));
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("start_rate");
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
    m.recentRows = () => Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, started_at: ago(3000 - i) }));
    expect((await call({ orgId: ORG, consent: true })).status).toBe(200);
  });

  it("a start that loses the atomic re-check (guard_meeting_start_v2, 0027) is refused; the guard removed its row", async () => {
    m.guard.mockResolvedValue({ data: "starter_busy", error: null });
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("starter_busy");
    expect(m.guard).toHaveBeenCalledWith("guard_meeting_start_v2", { p_meeting_id: m.insert.mock.calls[0][0].id, p_max_per_hour: 6 });
    expect(m.logEvent).not.toHaveBeenCalled();
    m.guard.mockResolvedValue({ data: "start_rate", error: null });
    expect((await call({ orgId: ORG, consent: true })).status).toBe(429);
    // Another member's start in the org, or any meeting on the same Doc, won the race (R2-I1).
    m.guard.mockResolvedValue({ data: "org_busy", error: null });
    let res2 = await call({ orgId: ORG, consent: true });
    expect([res2.status, (await res2.json()).error]).toEqual([409, "already_live"]);
    m.guard.mockResolvedValue({ data: "doc_busy", error: null });
    res2 = await call({ orgId: ORG, consent: true });
    expect([res2.status, (await res2.json()).error]).toEqual([409, "agenda_used"]);
    expect(m.logEvent).not.toHaveBeenCalled();
  });

  it("a refused start trashes its new Doc (never an orphan in the förening's folder); an agenda Doc is never trashed", async () => {
    m.guard.mockResolvedValue({ data: "org_busy", error: null });
    expect((await call({ orgId: ORG, consent: true })).status).toBe(409);
    expect(m.trashDoc).toHaveBeenCalledWith({}, "doc1");
    m.trashDoc.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.guard.mockResolvedValue({ data: "ok", error: null });
    m.insert.mockResolvedValue({ error: { message: "db down" } });
    expect((await call({ orgId: ORG, consent: true })).status).toBe(500);
    expect(m.trashDoc).toHaveBeenCalledWith({}, "doc1");
  });

  it("creates the Doc in the förening's meeting folder, named after the format, and says where it went", async () => {
    m.getOrg.mockResolvedValue({ id: ORG, name: "Styrelsen", share_transcript: true, meeting_folder_id: "meetFolder123" });
    m.profiles = [{ id: "pdef", org_id: ORG, kind: "veckomote", profile: VECKOMOTE, is_default: true }];
    const res = await call({ orgId: ORG, consent: true });
    const json = await res.json();
    const input = m.createFormatDoc.mock.calls[0][1];
    expect(input.meetingFolderId).toBe("meetFolder123");
    expect(input.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}\.\d{2} Mötesprotokoll – Styrelsen$/);
    expect(json).toMatchObject({ docPlace: "meeting_folder", title: input.title });
    expect(eventsOf("started")[0][2]).toMatchObject({ docPlace: "meeting_folder" });
    m.profiles = [];
  });

  it("marks whether Simon Says created the Doc (only those are ever shared later); works without 0030", async () => {
    await call({ orgId: ORG, consent: true });
    expect(insertedRow().app_created_doc).toBe(true);
    m.insert.mockReset().mockResolvedValueOnce({ error: { code: "PGRST204", message: "no column" } }).mockResolvedValue({ error: null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await call({ orgId: ORG, consent: true })).status).toBe(200);
    expect(m.insert.mock.calls[1][0]).not.toHaveProperty("app_created_doc");
  });

  it("a database without 0027: falls back to the 0021 guard", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    m.guard
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } } as never)
      .mockResolvedValueOnce({ data: "ok", error: null });
    expect((await call({ orgId: ORG, consent: true })).status).toBe(200);
    expect(m.guard.mock.calls.map((c) => c[0])).toEqual(["guard_meeting_start_v2", "guard_meeting_start"]);
  });
});

describe("POST /api/meetings: agenda mode and format Docs (A10)", () => {
  const agendaCall = (extra: Record<string, unknown> = {}) => call({ orgId: ORG, consent: true, agendaDocId: AGENDA_DOC, ...extra });

  it("agenda mode anchors the förening's own Doc and writes a format row (no sharing, no transcript tab)", async () => {
    const res = await agendaCall();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ agenda: true, appended: ["Anteckningar"], carried: 0, shareFailed: 0 });
    expect(json.docUrl).toBe(`https://docs.google.com/document/d/${AGENDA_DOC}/edit`);
    expect(m.checkAgendaDoc).toHaveBeenCalledWith({}, AGENDA_DOC);
    expect(m.anchorAgenda.mock.calls[0][1]).toMatchObject({ meetingId: json.meetingId, orgId: ORG, docId: AGENDA_DOC });
    expect(m.anchorAgenda.mock.calls[0][1].roles).toBeUndefined(); // the human Doc's roles are matched
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
    expect(m.createFormatDoc).not.toHaveBeenCalled();
    expect(m.memberEmails).not.toHaveBeenCalled();
    expect(m.addTranscriptTab).not.toHaveBeenCalled();
    const row = insertedRow();
    expect(row).toMatchObject({
      id: json.meetingId,
      doc_id: AGENDA_DOC,
      app_created_doc: false, // the förening's own Doc: never shared by Simon Says
      notes_tab_id: "t.0",
      layout: "format",
      agenda_doc: true,
      transcript_tab_id: null,
      header_range: `ss-${json.meetingId}-header`,
      header_rendered: "Simon Says antecknar live · uppdaterad –",
      // Må-runda hiding is off by default: the matched Må-runda is an ordinary item, no window.
      agenda_roles: { ...AGENDA_ROLES, "ag-2": "procedural" },
      is_test: false,
      format_profile_id: null,
      checkin_window: null,
    });
    expect(Object.keys(row.section_ranges).sort()).toEqual(["ag-1", "ag-2", "ag-3", "ag-4", "ag-5", "ag-6", "notes", "tasks"]);
    // info-tid from anchoring is saved with its range, so the final pass can write "18:05–19:10".
    expect(m.noteInsert).toHaveBeenCalledTimes(1);
    expect(m.noteInsert.mock.calls[0][0]).toEqual([
      expect.objectContaining({ meeting_id: json.meetingId, id: "info-tid", range_name: `ss-${json.meetingId}-info-tid`, last_rendered_text: "18:05" }),
    ]);
    expect(m.renderItems).not.toHaveBeenCalled(); // nothing to render: no previous meeting
    // Counts and role names only: never Doc text.
    expect(eventsOf("agenda_anchored")[0][2]).toEqual({ items: 6, appended: 1, roles: ["checkin", "followup", "other", "procedural", "topic"] });
    expect(eventsOf("started")[0][2]).toMatchObject({ agenda: true, layout: "format" });
    expect(eventsOf("followup_prefilled")).toEqual([]);
  });

  it("transcriptInDoc: true adds a Transkript tab to the agenda Doc", async () => {
    const res = await agendaCall({ transcriptInDoc: true });
    expect(res.status).toBe(200);
    expect(m.addTranscriptTab).toHaveBeenCalledWith({}, AGENDA_DOC);
    // Added after the guard, then saved with a plain update.
    expect(insertedRow().transcript_tab_id).toBeNull();
    expect(m.meetingUpdate).toHaveBeenCalledWith({ transcript_tab_id: "t.tr" }, insertedRow().id);
    expect(eventsOf("started")[0][2]).toMatchObject({ transcriptTab: true });
  });

  it("the Transkript tab is added only after the guard: a refused start never touches it", async () => {
    m.guard.mockResolvedValue({ data: "starter_busy", error: null });
    expect((await agendaCall({ transcriptInDoc: true })).status).toBe(409);
    expect(m.addTranscriptTab).not.toHaveBeenCalled();
    expect(m.meetingUpdate).not.toHaveBeenCalled();
  });

  it("a failing Transkript tab never fails the start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.addTranscriptTab.mockRejectedValue(new Error("docs down"));
    expect((await agendaCall({ transcriptInDoc: true })).status).toBe(200);
    expect(m.meetingUpdate).not.toHaveBeenCalled();
    expect(eventsOf("started")[0][2]).toMatchObject({ transcriptTab: false });
  });

  it("no Transkript tab in the agenda Doc when the org does not share transcripts, even if asked", async () => {
    m.getOrg.mockResolvedValue({ id: ORG, name: "Styrelsen", share_transcript: false });
    expect((await agendaCall({ transcriptInDoc: true })).status).toBe(200);
    expect(m.addTranscriptTab).not.toHaveBeenCalled();
    expect(insertedRow().transcript_tab_id).toBeNull();
    expect(m.meetingUpdate).not.toHaveBeenCalled();
  });

  it("null options are the same as absent", async () => {
    const res = await call({ orgId: ORG, consent: true, agendaDocId: null, formatProfileId: null, formatKind: null, transcriptInDoc: null });
    expect(res.status).toBe(200);
    expect(m.createMeetingDoc).toHaveBeenCalled();
    expect(m.checkAgendaDoc).not.toHaveBeenCalled();
  });

  it("403 agenda_no_edit when the starter cannot edit the Doc; nothing written", async () => {
    m.checkAgendaDoc.mockResolvedValue({ ok: false, error: "no_edit" });
    const res = await agendaCall();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "agenda_no_edit",
      message:
        "Ditt Google-konto kan inte redigera dokumentet. Be den som äger det att dela det med dig, eller skapa ett nytt dokument.",
    });
    expectNoWrites();
  });

  it("404 agenda_not_found for an unseen or trashed Doc, 400 agenda_not_doc for a PDF", async () => {
    for (const error of ["not_found", "trashed"]) {
      m.checkAgendaDoc.mockResolvedValue({ ok: false, error });
      const res = await agendaCall();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "agenda_not_found",
        message: "Simon Says kommer inte åt dokumentet. Välj det i Google-väljaren igen.",
      });
    }
    m.checkAgendaDoc.mockResolvedValue({ ok: false, error: "not_doc" });
    const res = await agendaCall();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "agenda_not_doc", message: "Det du valde är inte ett Google-dokument." });
    expectNoWrites();
  });

  it("409 agenda_used when the Doc belongs to a live or ending meeting; an abandoned one is allowed", async () => {
    for (const status of ["live", "ending"]) {
      m.docMeetings = [{ id: "old", doc_id: AGENDA_DOC, status }];
      const res = await agendaCall();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "agenda_used",
        message: "Dokumentet används redan av ett annat möte. Välj ett annat eller skapa ett nytt.",
      });
    }
    expectNoWrites();
    m.docMeetings = [{ id: "old", doc_id: AGENDA_DOC, status: "abandoned" }];
    const res = await agendaCall();
    expect(res.status).toBe(200);
    const { meetingId } = await res.json();
    expect(meetingId).not.toBe("old");
    expect(m.anchorAgenda.mock.calls[0][1].meetingId).toBe(meetingId); // its own ss-<newId>-… ranges
  });

  it("422 agenda_no_items when the Doc has no agenda; nothing written to the DB or the Doc", async () => {
    m.anchorAgenda.mockRejectedValue(new AgendaShapeError("no_items"));
    m.profiles = [{ id: "pv", org_id: ORG, kind: "veckomote", profile: VECKOMOTE, is_default: false }];
    const res = await agendaCall({ formatKind: "styrelseprotokoll" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "agenda_no_items",
      message: "Vi hittade ingen dagordning i dokumentet (en lista under ”Agenda” eller ”Dagordning”). Skapa ett nytt dokument i stället?",
    });
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.profileInsert).not.toHaveBeenCalled(); // ensureStandardRow only after every check
    expect(m.addTranscriptTab).not.toHaveBeenCalled();
    expect(m.logEvent).not.toHaveBeenCalled();
  });

  it("the agenda checks run after already_live and the start limits (F14)", async () => {
    m.active = [{ id: "live1" }];
    expect((await agendaCall()).status).toBe(409);
    m.active = [];
    m.liveRows = () => [{ id: "other", started_at: ago(60) }];
    expect((await agendaCall()).status).toBe(409);
    expect(m.checkAgendaDoc).not.toHaveBeenCalled();
    expect(m.anchorAgenda).not.toHaveBeenCalled();
  });

  it("an agenda without a Må-runda item gets no check-in window", async () => {
    m.anchorAgenda.mockImplementation(async (_a: unknown, input: { meetingId: string }) =>
      anchored(input.meetingId, "t.0", { "ag-1": "procedural", "ag-2": "topic" }),
    );
    expect((await agendaCall()).status).toBe(200);
    expect(insertedRow().checkin_window).toBeNull();
  });

  it("a format with Må-runda hiding on (opt-in) keeps the checkin role and opens the detector window", async () => {
    m.profiles = [{ id: "pdef", org_id: ORG, kind: "learned", profile: { ...VECKOMOTE, kind: "learned", hideCheckin: true }, is_default: true }];
    expect((await agendaCall()).status).toBe(200);
    expect(insertedRow()).toMatchObject({
      agenda_roles: AGENDA_ROLES,
      checkin_window: { startMs: null, endMs: null, closed: false, failures: 0 },
    });
  });

  it("the org default Veckomöte (stored without the flag): Må-runda hiding is off", async () => {
    m.profiles = [{ id: "pdef", org_id: ORG, kind: "veckomote", profile: VECKOMOTE, is_default: true }];
    expect((await agendaCall()).status).toBe(200);
    expect(Object.values(insertedRow().agenda_roles)).not.toContain("checkin");
    expect(insertedRow().checkin_window).toBeNull();
  });

  it("fallback with the org default Veckomöte: a new format Doc, anchored with the skeleton's roles", async () => {
    m.profiles = [{ id: "pdef", org_id: ORG, kind: "veckomote", profile: VECKOMOTE, is_default: true }];
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ agenda: false, carried: 0 });
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
    expect(m.createFormatDoc.mock.calls[0][1]).toMatchObject({
      meetingId: json.meetingId,
      orgName: "Styrelsen",
      memberEmails: ["b@x.se"],
      shareTranscript: true,
      profile: VECKOMOTE,
    });
    expect(m.anchorAgenda.mock.calls[0][1]).toMatchObject({ docId: "fdoc", tabId: "t.f", roles: rolesFromSkeleton(VECKOMOTE) });
    expect(m.checkAgendaDoc).not.toHaveBeenCalled();
    expect(insertedRow()).toMatchObject({
      doc_id: "fdoc",
      notes_tab_id: "t.f",
      transcript_tab_id: "t.ft",
      layout: "format",
      agenda_doc: false,
      format_profile_id: "pdef",
    });
  });

  it("fallback for an org without a format: today's v1 Doc", async () => {
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agenda: false, appended: [], carried: 0 });
    expect(m.createMeetingDoc).toHaveBeenCalled();
    expect(m.createFormatDoc).not.toHaveBeenCalled();
    expect(m.anchorAgenda).not.toHaveBeenCalled();
    expect(insertedRow()).toMatchObject({ layout: "v1", agenda_doc: false, format_profile_id: null, checkin_window: null });
    expect(m.noteInsert).not.toHaveBeenCalled();
    expect(eventsOf("agenda_anchored")).toEqual([]);
  });

  it("formatProfileId of another org → 400 bad_format; of this org → used", async () => {
    m.profiles = [{ id: PROFILE_ID, org_id: "ffffffff-ffff-ffff-ffff-ffffffffffff", kind: "veckomote", profile: VECKOMOTE, is_default: true }];
    const res = await call({ orgId: ORG, consent: true, formatProfileId: PROFILE_ID });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_format");
    expectNoWrites();
    m.profiles = [{ id: PROFILE_ID, org_id: ORG, kind: "styrelseprotokoll", profile: STYRELSEPROTOKOLL, is_default: false }];
    expect((await call({ orgId: ORG, consent: true, formatProfileId: PROFILE_ID })).status).toBe(200);
    expect(m.createFormatDoc.mock.calls[0][1].profile).toEqual(STYRELSEPROTOKOLL);
    expect(insertedRow().format_profile_id).toBe(PROFILE_ID);
  });

  it("formatKind uses (or creates) a non-default standard row, without changing the org default", async () => {
    const res = await call({ orgId: ORG, consent: true, formatKind: "veckomote" });
    expect(res.status).toBe(200);
    expect(m.profileInsert).toHaveBeenCalledWith({ org_id: ORG, kind: "veckomote", profile: VECKOMOTE, is_default: false });
    // Inserted without it, set after the guard.
    expect(insertedRow().format_profile_id).toBeNull();
    expect(m.meetingUpdate).toHaveBeenCalledWith({ format_profile_id: "std1" }, insertedRow().id);
    // A matching row exists: reused, nothing inserted.
    m.insert.mockClear();
    m.profileInsert.mockClear();
    m.meetingUpdate.mockClear();
    m.profiles = [{ id: "stdOld", org_id: ORG, kind: "veckomote", profile: JSON.parse(JSON.stringify(VECKOMOTE)), is_default: false }];
    expect((await call({ orgId: ORG, consent: true, formatKind: "veckomote" })).status).toBe(200);
    expect(m.profileInsert).not.toHaveBeenCalled();
    expect(m.meetingUpdate).toHaveBeenCalledWith({ format_profile_id: "stdOld" }, insertedRow().id);
  });

  it("formatKind: a refused start creates no format row; a failing one undoes the start", async () => {
    m.guard.mockResolvedValue({ data: "start_rate", error: null });
    expect((await call({ orgId: ORG, consent: true, formatKind: "veckomote" })).status).toBe(429);
    expect(m.profileInsert).not.toHaveBeenCalled();
    m.guard.mockResolvedValue({ data: "ok", error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.profileInsert.mockImplementation(() => {
      throw new Error("db down");
    });
    m.del.mockClear();
    const res = await call({ orgId: ORG, consent: true, formatKind: "veckomote" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("save_failed");
    expect(m.del).toHaveBeenCalledWith(m.insert.mock.calls.at(-1)![0].id);
  });

  it("pre-fills Från förra veckan with the previous done meeting's open tasks (c1, c2)", async () => {
    m.prevMeetings = [
      { id: "prev0", org_id: ORG, is_test: false, status: "done", started_at: ago(30 * 86400) },
      { id: "prev1", org_id: ORG, is_test: false, status: "done", started_at: ago(7 * 86400) },
      { id: "test1", org_id: ORG, is_test: true, status: "done", started_at: ago(86400) },
    ];
    const task = (id: string, o: Record<string, unknown> = {}) => ({
      meeting_id: "prev1",
      id,
      section: "action",
      kind: "task",
      text: `Uppgift ${id}`,
      owner: null,
      due: null,
      locked: false,
      deleted_by_human: false,
      done: false,
      copy_of: null,
      last_rendered_text: "x",
      range_name: "r",
      position: 0,
      ...o,
    });
    m.noteRows = [
      task("n1", { owner: "Kalle Fiktiv" }),
      task("n2", { owner: "Lisa Påhittad" }),
      task("n3", { done: true }),
      task("n1-t", { copy_of: "n1", anchor: "tasks" }),
      task("n9", { meeting_id: "test1" }),
    ];
    m.people = [
      { id: "pk", name: "Kalle Fiktiv", role: "Kassör", org_id: ORG },
      { id: "pl", name: "Lisa Påhittad", role: "Ordförande", org_id: ORG },
    ];
    m.profiles = [{ id: "pdef", org_id: ORG, kind: "veckomote", profile: VECKOMOTE, is_default: true }];
    const res = await agendaCall();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.carried).toBe(2);
    const inserted = m.noteInsert.mock.calls[0][0] as Record<string, unknown>[];
    const carried = inserted.filter((r) => r.carried_from_meeting === "prev1");
    // Grouped by role label: Kassör before Ordförande.
    expect(carried.map((r) => [r.id, r.carried_from_id, r.anchor, r.meeting_id, r.range_name])).toEqual([
      ["c1", "n1", "ag-3", json.meetingId, null],
      ["c2", "n2", "ag-3", json.meetingId, null],
    ]);
    expect(inserted.map((r) => r.id)).toContain("info-tid");
    // Rendered with the format planner, at a fresh revision, then the rendered fields saved.
    expect(m.readNotesTab).toHaveBeenCalledWith({}, AGENDA_DOC, "t.0");
    const [, meeting, rows, desired, revision, header, format] = m.renderItems.mock.calls[0];
    expect(meeting).toMatchObject({ id: json.meetingId, layout: "format", doc_id: AGENDA_DOC, notes_tab_id: "t.0" });
    expect(meeting.section_ranges["ag-3"]).toBe(`ss-${json.meetingId}-ag-3`);
    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual(["c1", "c2", "info-tid"]);
    expect(desired.map((d: { id: string }) => d.id).sort()).toEqual(["c1", "c2", "info-tid"]);
    expect(revision).toBe("r3");
    expect(header).toBeUndefined();
    expect(format.plan).toBe(planFormatRender);
    expect(format.profile).toBeDefined();
    expect(format.ownerLabel("Kalle Fiktiv")).toBe("Kassör");
    const updates = m.noteUpdate.mock.calls.map((c) => c[1]).sort();
    expect(updates).toEqual(["c1", "c2"]);
    expect(m.noteUpdate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ range_name: expect.stringMatching(/^ss-/), last_rendered_text: expect.any(String), position: expect.any(Number) }),
    );
    expect(eventsOf("followup_prefilled")[0][2]).toEqual({ count: 2, adopted: 0, rendered: true });
  });

  it("a render conflict is retried; a failing pre-fill never fails the start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.prevMeetings = [{ id: "prev1", org_id: ORG, is_test: false, status: "done", started_at: ago(86400) }];
    m.noteRows = [{ meeting_id: "prev1", id: "n1", section: "action", kind: "task", text: "Boka hall", owner: null, due: null, locked: false, deleted_by_human: false, done: false, position: 0 }];
    m.renderItems.mockResolvedValueOnce({ status: "conflict" });
    expect((await agendaCall()).status).toBe(200);
    expect(m.renderItems).toHaveBeenCalledTimes(2);
    expect(m.noteUpdate).toHaveBeenCalledTimes(1);

    m.renderItems.mockReset().mockRejectedValue(new Error("docs down"));
    m.insert.mockClear();
    const res = await agendaCall();
    expect(res.status).toBe(200);
    expect(m.insert).toHaveBeenCalledTimes(1);
    expect(eventsOf("followup_prefilled").at(-1)![2]).toEqual({ count: 1, adopted: 0, rendered: false });
  });

  it("after a false start on the same Doc, its carried lines are taken over, never written twice (R1/R2)", async () => {
    // Week 1 (prev1, another Doc) left "Boka hall" open; false start A on this Doc carried it as c1
    // (still in the Doc) and was abandoned; the real start B must neither re-carry nor re-render it.
    m.prevMeetings = [{ id: "prev1", org_id: ORG, is_test: false, status: "done", started_at: ago(7 * 86400) }];
    m.docMeetings = [{ id: "A", doc_id: AGENDA_DOC, status: "abandoned", started_at: ago(600) } as never];
    const base = { section: "action", kind: "task", owner: null, due: null, locked: false, deleted_by_human: false, done: false, copy_of: null, position: 0 };
    m.noteRows = [
      { ...base, meeting_id: "prev1", id: "n1", text: "Boka hall", last_rendered_text: "Boka hall.", range_name: "ss-prev1-n1" },
      { ...base, meeting_id: "prev1", id: "n2", text: "Köp bollar", last_rendered_text: "Köp bollar.", range_name: "ss-prev1-n2" },
      { ...base, meeting_id: "A", id: "c1", anchor: "ag-3", text: "Boka hall", last_rendered_text: "– Boka hall.", range_name: "ss-A-c1", carried_from_meeting: "prev1", carried_from_id: "n1" },
      // A carried line a human removed from the Doc: carried again, as a fresh line.
      { ...base, meeting_id: "A", id: "c2", anchor: "ag-3", text: "Köp bollar", last_rendered_text: "– Köp bollar.", range_name: "ss-A-c2", carried_from_meeting: "prev1", carried_from_id: "n2" },
    ];
    m.readNotesTab.mockResolvedValue({
      revisionId: "r3",
      tabId: "t.0",
      paragraphs: [{ start: 1, end: 14, text: "– Boka hall.\n", suggested: false }],
      ranges: new Map([["ss-A-c1", [[{ start: 1, end: 13 }]]]]),
    });
    const res = await agendaCall();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.carried).toBe(2);
    const inserted = m.noteInsert.mock.calls[0][0] as Record<string, unknown>[];
    expect(inserted.filter((r) => String(r.id).startsWith("c")).map((r) => [r.id, r.range_name, r.carried_from_meeting, r.carried_from_id, r.meeting_id === json.meetingId])).toEqual([
      ["c1", "ss-A-c1", "prev1", "n1", true],
      ["c2", null, "prev1", "n2", true],
    ]);
    // Only the fresh line is rendered.
    const [, , , desired] = m.renderItems.mock.calls[0];
    expect(desired.map((d: { id: string }) => d.id).sort()).toEqual(["c1", "c2", "info-tid"]);
    expect(m.noteUpdate.mock.calls.map((c) => c[1])).toEqual(["c2"]);
    expect(eventsOf("followup_prefilled")[0][2]).toEqual({ count: 2, adopted: 1, rendered: true });
  });

  it("a prepared agenda (Förbered möte): its format, ours to share, its carried lines adopted; dropped and deleted tasks stay off", async () => {
    m.profiles = [{ id: "pv", org_id: ORG, kind: "veckomote", profile: VECKOMOTE, is_default: false }];
    // The previous Veckomöte; a later Styrelsemöte is not "the same kind".
    m.prevMeetings = [
      { id: "prev1", org_id: ORG, is_test: false, status: "done", started_at: ago(7 * 86400), format_profile_id: "pv" } as never,
      { id: "styr", org_id: ORG, is_test: false, status: "done", started_at: ago(3 * 86400), format_profile_id: "ps" } as never,
    ];
    m.profiles.push({ id: "ps", org_id: ORG, kind: "styrelseprotokoll", profile: STYRELSEPROTOKOLL, is_default: false });
    const base = { section: "action", kind: "task", owner: null, due: null, locked: false, deleted_by_human: false, done: false, copy_of: null, position: 0 };
    m.noteRows = [
      { ...base, meeting_id: "prev1", id: "n1", text: "Boka hall" },
      { ...base, meeting_id: "prev1", id: "n2", text: "Köp bollar" },
      { ...base, meeting_id: "prev1", id: "n3", text: "Ring kommunen" },
      { ...base, meeting_id: "styr", id: "n1", text: "Styrelsens uppgift" },
    ];
    const line = (id: string, from: string) => ({ ...base, meeting_id: "prep-p1", id, anchor: "ag-3", text: from, carried_from_meeting: "prev1", carried_from_id: from === "Boka hall" ? "n1" : "n2", range_name: `ss-prep-p1-${id}`, last_rendered_text: `– ${from}.` });
    m.prepared = [
      {
        id: "p1",
        org_id: ORG,
        doc_id: AGENDA_DOC,
        kind: "veckomote",
        format_profile_id: "pv",
        carried: [line("c1", "Boka hall"), line("c2", "Köp bollar")],
        dropped: ["prev1:n3"],
        shared_with: ["u2"],
      },
    ];
    // The Köp bollar line was deleted in the Doc by a human.
    m.readNotesTab.mockResolvedValue({
      revisionId: "r3",
      tabId: "t.0",
      paragraphs: [{ start: 1, end: 14, text: "– Boka hall.\n", suggested: false }],
      ranges: new Map([["ss-prep-p1-c1", [[{ start: 1, end: 13 }]]]]),
    });
    const res = await agendaCall();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(insertedRow()).toMatchObject({ format_profile_id: "pv", app_created_doc: true, agenda_doc: true });
    expect(m.recordDocShares).toHaveBeenCalledWith(json.meetingId, ["u2"]);
    const inserted = m.noteInsert.mock.calls[0][0] as Record<string, unknown>[];
    expect(inserted.filter((r) => String(r.id).startsWith("c")).map((r) => [r.id, r.range_name, r.carried_from_meeting, r.carried_from_id, r.meeting_id === json.meetingId])).toEqual([
      ["c1", "ss-prep-p1-c1", "prev1", "n1", true],
    ]);
    expect(json.carried).toBe(1);
    expect(m.renderItems).not.toHaveBeenCalled();
  });

  it("a prepared agenda restarted after a false start keeps the ordförande's dropped tasks off", async () => {
    m.profiles = [{ id: "pv", org_id: ORG, kind: "veckomote", profile: VECKOMOTE, is_default: false }];
    m.prevMeetings = [{ id: "prev1", org_id: ORG, is_test: false, status: "done", started_at: ago(7 * 86400), format_profile_id: "pv" } as never];
    m.docMeetings = [{ id: "A", doc_id: AGENDA_DOC, status: "abandoned", started_at: ago(600) } as never];
    const base = { section: "action", kind: "task", owner: null, due: null, locked: false, deleted_by_human: false, done: false, copy_of: null, position: 0 };
    m.noteRows = [
      { ...base, meeting_id: "prev1", id: "n1", text: "Boka hall" },
      { ...base, meeting_id: "prev1", id: "n3", text: "Ring kommunen" },
    ];
    m.prepared = [{ id: "p1", org_id: ORG, doc_id: AGENDA_DOC, kind: "veckomote", format_profile_id: "pv", carried: [], dropped: ["prev1:n3"], shared_with: [] }];
    const res = await agendaCall();
    expect(res.status).toBe(200);
    const inserted = m.noteInsert.mock.calls[0][0] as Record<string, unknown>[];
    expect(inserted.filter((r) => String(r.id).startsWith("c")).map((r) => r.carried_from_id)).toEqual(["n1"]);
  });

  it("a prepared Doc without carried lines is still ours to share", async () => {
    m.prepared = [{ id: "p1", org_id: ORG, doc_id: AGENDA_DOC, kind: "veckomote", format_profile_id: null, carried: [], dropped: [], shared_with: [] }];
    expect((await agendaCall()).status).toBe(200);
    expect(insertedRow()).toMatchObject({ app_created_doc: true });
  });

  it("a start the guard refuses writes no note rows", async () => {
    m.prevMeetings = [{ id: "prev1", org_id: ORG, is_test: false, status: "done", started_at: ago(86400) }];
    m.guard.mockResolvedValue({ data: "starter_busy", error: null });
    expect((await agendaCall()).status).toBe(409);
    expect(m.noteInsert).not.toHaveBeenCalled();
    expect(m.renderItems).not.toHaveBeenCalled();
  });

  it("a losing start on an agenda Doc removes its own anchoring (parked N5); best effort, the refusal stands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const guard of ["doc_busy", "org_busy", "starter_busy", "start_rate"]) {
      m.cleanupLosingAnchor.mockClear();
      m.guard.mockResolvedValue({ data: guard, error: null });
      expect((await agendaCall()).status).toBeGreaterThanOrEqual(409);
      const id = m.insert.mock.calls.at(-1)![0].id;
      expect(m.cleanupLosingAnchor).toHaveBeenCalledTimes(1);
      expect(m.cleanupLosingAnchor.mock.calls[0][1]).toMatchObject({ docId: AGENDA_DOC, tabId: "t.0", meetingId: id });
    }
    m.cleanupLosingAnchor.mockRejectedValueOnce(new Error("Google down"));
    m.guard.mockResolvedValue({ data: "doc_busy", error: null });
    const res = await agendaCall();
    expect([res.status, (await res.json()).error]).toEqual([409, "agenda_used"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("anchoring cleanup failed"));
    // A won start, and a refused start on a new Doc of ours (no agenda Doc), clean nothing.
    m.cleanupLosingAnchor.mockClear();
    m.guard.mockResolvedValue({ data: "ok", error: null });
    expect((await agendaCall()).status).toBe(200);
    m.guard.mockResolvedValue({ data: "doc_busy", error: null });
    await call({ orgId: ORG, consent: true });
    expect(m.cleanupLosingAnchor).not.toHaveBeenCalled();
  });

  it("400 bad_request for a malformed agendaDocId, formatProfileId, formatKind or transcriptInDoc", async () => {
    for (const extra of [
      { agendaDocId: "short" },
      { agendaDocId: "../../etc/passwd/xxxxxxx" },
      { formatProfileId: "not-a-uuid" },
      { formatKind: "learned" },
      { transcriptInDoc: "yes" },
    ]) {
      expect((await call({ orgId: ORG, consent: true, ...extra })).status).toBe(400);
    }
    expectNoWrites();
  });
});

describe("startMeeting options", () => {
  it("isTest → is_test true (Testmöte pulls only from Testmöten)", async () => {
    const { startMeeting } = await import("@/lib/meetings/start");
    m.prevMeetings = [{ id: "real1", org_id: ORG, is_test: false, status: "done", started_at: ago(86400) }];
    const supabase = (await (await import("@/lib/supabase/server")).createSupabaseServerClient()) as never;
    const r = await startMeeting(supabase, { id: "u1", email: "s@x.se" }, ORG, "test_started", {
      agendaDocId: AGENDA_DOC,
      isTest: true,
    });
    expect(r.ok).toBe(true);
    expect(insertedRow().is_test).toBe(true);
    expect(m.noteInsert.mock.calls[0][0].map((x: { id: string }) => x.id)).toEqual(["info-tid"]); // the real meeting is not carried
    expect(eventsOf("test_started")).toHaveLength(1);
  });

  it("test_started without isTest defaults to is_test true; started to false", async () => {
    const { startMeeting } = await import("@/lib/meetings/start");
    const supabase = (await (await import("@/lib/supabase/server")).createSupabaseServerClient()) as never;
    await startMeeting(supabase, { id: "u1", email: "s@x.se" }, ORG, "test_started");
    expect(insertedRow().is_test).toBe(true);
  });

  it("an agenda Testmöte (A13) carries only from agenda Testmöten, with the fixture's people: no people rows read, no owner ids", async () => {
    const { startMeeting } = await import("@/lib/meetings/start");
    m.prevMeetings = [
      { id: "agendaTest", org_id: ORG, is_test: true, status: "done", started_at: ago(2 * 86400), agenda_doc: true },
      // Newer, but an old-style Testmöte (its fictional board meeting): never carried into the agenda run.
      { id: "oldTest", org_id: ORG, is_test: true, status: "done", started_at: ago(86400), agenda_doc: false },
    ];
    const task = (id: string, owner: string, meeting = "agendaTest") => ({
      meeting_id: meeting, id, section: "action", kind: "task", text: `Uppgift ${id}`, owner, due: null,
      locked: false, deleted_by_human: false, done: false, copy_of: null, position: 0,
    });
    m.noteRows = [task("n1", "Oskar Berglund"), task("n2", "Fatima"), task("n9", "Karin Ek", "oldTest")];
    // A real person of the test förening with a clashing name must never be used.
    m.people = [{ id: "real-oskar", name: "Oskar Berglund", role: "Ordförande", org_id: ORG }];
    const supabase = (await (await import("@/lib/supabase/server")).createSupabaseServerClient()) as never;
    const r = await startMeeting(supabase, { id: "u1", email: "s@x.se" }, ORG, "test_started", {
      agendaDocId: AGENDA_DOC,
      formatKind: "veckomote",
      transcriptInDoc: false,
      isTest: true,
    });
    expect(r).toMatchObject({ ok: true, carried: 2 });
    expect(m.queries.some((q) => q.table === "people")).toBe(false);
    const carried = (m.noteInsert.mock.calls[0][0] as Record<string, unknown>[]).filter((x) => x.carried_from_meeting);
    // Grouped by the fixture roles: Eventansvarig (Fatima) before Kassör (Oskar).
    expect(carried.map((x) => [x.id, x.carried_from_meeting, x.carried_from_id, x.owner_person_id])).toEqual([
      ["c1", "agendaTest", "n2", null],
      ["c2", "agendaTest", "n1", null],
    ]);
    const format = m.renderItems.mock.calls[0][6];
    expect(format.ownerLabel("Oskar Berglund")).toBe("Kassör");
    expect(format.ownerLabel("Kassören")).toBe("Kassör");
  });

  it("a real agenda meeting still reads the förening's people and ignores agenda_doc when picking the previous meeting", async () => {
    m.prevMeetings = [{ id: "prev1", org_id: ORG, is_test: false, status: "done", started_at: ago(86400), agenda_doc: false }];
    m.noteRows = [{ meeting_id: "prev1", id: "n1", section: "action", kind: "task", text: "Boka hall", owner: "Kalle Fiktiv", due: null, locked: false, deleted_by_human: false, done: false, position: 0 }];
    m.people = [{ id: "pk", name: "Kalle Fiktiv", role: "Kassör", org_id: ORG }];
    const res = await call({ orgId: ORG, consent: true, agendaDocId: AGENDA_DOC });
    expect((await res.json()).carried).toBe(1);
    expect(m.queries.some((q) => q.table === "meetings" && has(q, "eq", "agenda_doc"))).toBe(false);
    expect(m.queries.some((q) => q.table === "people")).toBe(true);
    expect((m.noteInsert.mock.calls[0][0] as Record<string, unknown>[]).find((x) => x.id === "c1")?.owner_person_id).toBe("pk");
  });
});

describe("POST /api/meetings: required items (stadgar, C2)", () => {
  const LABELS = ["Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Ekonomi", "Övrigt"];
  const withScan = (labels: string[]) =>
    m.anchorAgenda.mockImplementation(async (_a: unknown, input: { meetingId: string; tabId?: string }) => ({
      ...anchored(input.meetingId, input.tabId ?? "t.0"),
      scan: { items: labels.map((label, i) => ({ key: `ag-${i + 1}`, label })) },
    }));
  const requiring = (requiredItems: string[], base = VECKOMOTE) => {
    m.profiles = [{ id: PROFILE_ID, org_id: ORG, kind: base.kind, profile: { ...base, requiredItems }, is_default: true }];
  };

  it("agenda mode: a required item the agenda Doc lacks is a warning; nothing is added to the Doc", async () => {
    requiring(["Val av justerare"]);
    withScan(LABELS);
    const res = await call({ orgId: ORG, consent: true, agendaDocId: AGENDA_DOC, formatProfileId: PROFILE_ID });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.warnings).toEqual(["Val av justerare"]);
    // The Doc is only anchored (ranges over what is there): no new Doc, no agenda item written.
    expect(m.anchorAgenda).toHaveBeenCalledTimes(1);
    expect(m.anchorAgenda.mock.calls[0][1].roles).toBeUndefined();
    expect(m.createFormatDoc).not.toHaveBeenCalled();
    expect(m.createMeetingDoc).not.toHaveBeenCalled();
    expect(m.renderItems).not.toHaveBeenCalled();
    const saved = (m.noteInsert.mock.calls[0]?.[0] ?? []) as Record<string, unknown>[];
    expect(saved.map((r) => r.id)).toEqual(["info-tid"]);
    expect(Object.keys(insertedRow().section_ranges).filter((k) => k.startsWith("ag-"))).toHaveLength(LABELS.length);
    // The warning is the profile's label, never logged with Doc text.
    expect(JSON.stringify(m.logEvent.mock.calls)).not.toContain("Val av justerare");
  });

  it("no warning when the agenda names the required item; none without required items", async () => {
    requiring(["Val av justerare"]);
    withScan([...LABELS.slice(0, 1), "§2 Val av justerare:", ...LABELS.slice(1)]);
    expect((await (await call({ orgId: ORG, consent: true, agendaDocId: AGENDA_DOC })).json()).warnings).toEqual([]);
    m.profiles = [];
    m.insert.mockClear();
    withScan(LABELS);
    expect((await (await call({ orgId: ORG, consent: true, agendaDocId: AGENDA_DOC })).json()).warnings).toEqual([]);
  });

  it("fallback Styrelseprotokoll: the new Doc carries the required item (§6), anchored with the merged roles; no warning", async () => {
    requiring(["Val av justerare", "Fråga om mötets behöriga utlysande"], STYRELSEPROTOKOLL);
    const res = await call({ orgId: ORG, consent: true });
    expect(res.status).toBe(200);
    expect((await res.json()).warnings).toEqual([]);
    const profile = m.createFormatDoc.mock.calls[0][1].profile;
    expect(profile.requiredItems).toEqual(["Val av justerare", "Fråga om mötets behöriga utlysande"]);
    const roles = m.anchorAgenda.mock.calls[0][1].roles;
    expect(roles).toEqual(rolesFromSkeleton(profile));
    expect(Object.keys(roles)).toHaveLength(10);
    expect(roles["ag-7"]).toBe("other");
  });
});
