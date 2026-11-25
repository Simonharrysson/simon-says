import { randomUUID } from "node:crypto";
import type { docs_v1 } from "@googleapis/docs";
import type { OAuth2Client } from "google-auth-library";
import { INITIAL_LIVE_LINE } from "@/lib/agenda/anchor";
import type { CheckinWindow, ItemRole, MeetingRow, NoteItemRow } from "@/lib/db/types";
import { planRender, renderedRows, toNotesItem, type RenderResult } from "@/lib/docs/notes";
import { parseNotesTab } from "@/lib/docs/tab";
import type { FormatProfile } from "@/lib/formats/schema";
import { VECKOMOTE } from "@/lib/formats/standard";
import type { TickDeps } from "@/lib/meetings/tick";
import { extractNames } from "@/lib/names/extract";
import { detectCheckin } from "@/lib/notes/checkin";
import { updateNotes, type NotesClient } from "@/lib/notes/engine";
import { ingestSegments } from "@/lib/segments/ingest";
import { TAB } from "./docsim";
import { anchoredDoc, applyDoc, FMT_ENDED, FMT_STARTED, fmtMeeting, renderInto, ROLES } from "./formatdoc";
import { adminClient } from "./local-supabase";

// Database side of the feature suite (tests/suite, CI only): meetings inserted as startMeeting
// leaves them, and TickDeps whose Google side is the Docs simulator and whose Claude side is the
// REAL engine code behind a scripted NotesClient (test/meeting-sim.ts scriptedClient).

type Doc = docs_v1.Schema$Document;

export interface SuiteDeps {
  deps: Partial<TickDeps>;
  headers: (string | undefined)[];
  appended: { speaker: string; atMs: number; text: string }[][];
  renders: () => number;
}

/** runTick deps: docsim Docs, the real engine / detector / name round on `client`, a fixed clock. */
export function docsimDeps(
  doc: Doc,
  client: NotesClient,
  opts: { now?: Date; beforeRender?: (attempt: number) => void } = {},
): SuiteDeps {
  const headers: (string | undefined)[] = [];
  const appended: SuiteDeps["appended"] = [];
  let renders = 0;
  const deps: Partial<TickDeps> = {
    getAuth: async () => ({}) as OAuth2Client,
    readNotes: async () => parseNotesTab(doc, TAB),
    render: async (_auth, m, rows, desired, rev, header, format): Promise<RenderResult> => {
      opts.beforeRender?.(renders);
      renders++;
      headers.push(header);
      const tab = parseNotesTab(doc, TAB);
      // writeControl.requiredRevisionId, as the Docs API checks it.
      if (tab.revisionId !== rev) return { status: "conflict" };
      if (m.layout === "format") {
        if (!format) throw new Error("format meeting rendered without its planner");
        const plan = format.plan(m, tab, rows, desired, { profile: format.profile, ownerLabel: format.ownerLabel, headerText: header, newAnchors: format.newAnchors });
        applyDoc(doc, plan.requests);
        return { status: "ok", rows: renderedRows(m.id, rows, desired, plan), headerRendered: plan.header };
      }
      const plan = planRender(m, tab, rows, desired, header);
      applyDoc(doc, plan.requests);
      return { status: "ok", rows: renderedRows(m.id, rows, desired, plan), headerRendered: plan.header };
    },
    appendTranscript: async (_a, _d, _t, lines) => void appended.push(lines),
    updateNotes: (input) => updateNotes(input, { client }),
    detectCheckin: (input, o) => detectCheckin(input, { ...o, client }),
    extractNames: (segments, known, o) => extractNames(segments, known, { ...o, client }),
    mailer: { send: async () => false },
    sleep: async () => undefined,
    random: () => 0,
    now: () => opts.now ?? new Date("2026-11-25T17:31:00Z"),
  };
  return { deps, headers, appended, renders: () => renders };
}

/**
 * A live format meeting on an anchored Doc (default: the A1 fixture, Veckomöte), as startMeeting
 * leaves it: the info rows saved, `prerender` rows (Från förra veckan) rendered and saved, one
 * ElevenLabs session whose name round already ran.
 */
export async function insertFormatMeeting(opts: {
  orgId: string;
  starterId: string;
  profileId: string;
  doc?: Doc;
  profile?: FormatProfile;
  roles?: Record<string, ItemRole>;
  isTest?: boolean;
  agendaDoc?: boolean;
  status?: "live" | "ending";
  window?: CheckinWindow | null;
  prerender?: NoteItemRow[];
  transcriptTab?: boolean;
  startedAt?: Date;
  docId?: string;
}): Promise<{ id: string; sessionId: string; doc: Doc }> {
  const admin = adminClient();
  const id = randomUUID();
  const startedAt = opts.startedAt ?? FMT_STARTED;
  const profile = opts.profile ?? VECKOMOTE;
  const { doc, plan } = anchoredDoc(id, { doc: opts.doc, profile, startedAt });
  const roles = opts.roles ?? ROLES;
  const { error } = await admin.from("meetings").insert({
    id,
    org_id: opts.orgId,
    started_by: opts.starterId,
    doc_id: opts.docId ?? `doc-${id}`,
    notes_tab_id: TAB,
    transcript_tab_id: opts.transcriptTab ? "t.transcript" : null,
    header_range: plan.headerRange,
    header_rendered: INITIAL_LIVE_LINE,
    section_ranges: plan.sectionRanges,
    status: opts.status ?? "live",
    consent_confirmed_at: startedAt.toISOString(),
    started_at: startedAt.toISOString(),
    ended_at: opts.status === "ending" ? FMT_ENDED.toISOString() : null,
    last_heartbeat_at: new Date().toISOString(),
    agenda_doc: opts.agendaDoc ?? true,
    layout: "format",
    format_profile_id: opts.profileId,
    is_test: opts.isTest ?? false,
    agenda_roles: roles,
    checkin_window: opts.window ?? null,
  });
  if (error) throw new Error(error.message);
  let rows: NoteItemRow[] = plan.rows.map((r) => ({ ...r, meeting_id: id }));
  if (opts.prerender?.length) {
    const pre = opts.prerender.map((r) => ({ ...r, meeting_id: id }));
    rows = renderInto(doc, fmtMeeting(id, plan, { agenda_roles: roles }), [...rows, ...pre], [...rows, ...pre].map(toNotesItem), { profile }).rows;
  }
  if (rows.length) {
    const { error: ie } = await admin.from("note_items").insert(rows);
    if (ie) throw new Error(ie.message);
  }
  const sessionId = `el-${randomUUID()}`;
  const { error: se } = await admin.from("el_sessions").insert({
    id: sessionId,
    meeting_id: id,
    max_seconds: 3600,
    started_at: startedAt.toISOString(),
    name_round_at: new Date().toISOString(),
  });
  if (se) throw new Error(se.message);
  return { id, sessionId, doc };
}

let segCounter = 0;
/** One transcript run of `speaker` (raw label, e.g. "speaker_0") at session time `startMs`. */
export const say = (meetingId: string, sessionId: string, speaker: string, text: string, startMs: number) =>
  ingestSegments(meetingId, [{ elSessionId: sessionId, segmentIndex: segCounter++, runIndex: 0, speaker, text, startMs, endMs: startMs + 500 }]);

export const readMeeting = async (id: string) => (await adminClient().from("meetings").select("*").eq("id", id).single()).data as MeetingRow;
export const noteRows = async (id: string) =>
  ((await adminClient().from("note_items").select("*").eq("meeting_id", id).order("position")).data ?? []) as NoteItemRow[];
export const backdate = (id: string) =>
  adminClient().from("meetings").update({ last_tick_at: new Date(Date.now() - 46_000).toISOString() }).eq("id", id);
export const events = async (id: string, kind?: string) => {
  let q = adminClient().from("meeting_events").select("kind, detail").eq("meeting_id", id);
  if (kind) q = q.eq("kind", kind);
  return ((await q.order("id")).data ?? []) as { kind: string; detail: Record<string, unknown> }[];
};
/** Mark an ended meeting finished (its final pass ran; ended_at was set when it began ending). */
export const finish = (id: string, status: "done" | "abandoned" = "done") => adminClient().from("meetings").update({ status }).eq("id", id);

/** The env mock every DB-touching suite file installs (getEnv on the local stack, overridable caps). */
export type EnvOverride = { KILL_SWITCH?: boolean; GLOBAL_DAILY_HOURS?: number; GLOBAL_DAILY_USD?: number };
