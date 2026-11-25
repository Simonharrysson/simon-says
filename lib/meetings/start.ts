import "server-only";
import { randomUUID } from "node:crypto";
import type { OAuth2Client } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAgendaDoc } from "@/lib/agenda/access";
import { AgendaShapeError, anchorAgenda, type AnchorResult } from "@/lib/agenda/anchor";
import { carriedItems, openTasks, previousMeeting } from "@/lib/agenda/followup";
import { addTranscriptTab, createFormatDoc, createMeetingDoc, meetingTitle } from "@/lib/docs/create";
import { planFormatRender } from "@/lib/docs/format-render";
import { readNotesTab, renderItems, toNotesItem } from "@/lib/docs/notes";
import { logEvent } from "@/lib/db/events";
import { memberEmails } from "@/lib/db/members";
import { getOrg, myRole } from "@/lib/db/orgs";
import type { CheckinWindow, ItemRole, MeetingEventKind, MeetingRow, NoteItemRow } from "@/lib/db/types";
import { parseProfile, type FormatProfile } from "@/lib/formats/schema";
import { rolesFromSkeleton } from "@/lib/formats/skeleton";
import { STANDARD } from "@/lib/formats/standard";
import { ensureStandardRow, orgDefaultFormat } from "@/lib/formats/store";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { retryDelayMs, sleep } from "@/lib/google/docs";
import { MAX_STARTS_PER_HOUR } from "@/lib/limits";
import { ownerLabel, resolveOwner, type RolePerson } from "@/lib/people/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { docUrl } from "@/lib/ui/meetings";

export type StandardKind = "veckomote" | "styrelseprotokoll" | "enkel";

export interface StartOptions {
  /** Agenda mode: the förening's own agenda Doc (picked by the starter). Absent: a new Doc (fallback). */
  agendaDocId?: string | null;
  /** A format_profiles row of this org (the start screen's override). */
  formatProfileId?: string | null;
  /** A standard format by kind (Testmöte, override): a non-default row equal to the constant. */
  formatKind?: StandardKind;
  /** Agenda mode only: add a "Transkript" tab to the agenda Doc (answer 8: default no; never when the org doesn't share transcripts). */
  transcriptInDoc?: boolean;
  /** Default: eventKind === "test_started". */
  isTest?: boolean;
}

export type StartResult =
  | {
      ok: true;
      meetingId: string;
      docUrl: string;
      orgName: string;
      title: string;
      shareFailed: number;
      /** Started in the förening's own agenda Doc. */
      agenda: boolean;
      /** Section headings Simon Says appended to the Doc (labels of the format, in Doc order). */
      appended: string[];
      /** Open tasks of the previous meeting pre-filled under "Från förra veckan". */
      carried: number;
    }
  | { ok: false; error: string; status: number; message: string };

type Failure = Extract<StartResult, { ok: false }>;
const failed = (error: string, status: number, message: string): Failure => ({ ok: false, error, status, message });

const authLost = () => failed("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
const googleDown = () => failed("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
const agendaNotFound = () =>
  failed("agenda_not_found", 404, "Simon Says kommer inte åt dokumentet. Välj det i Google-väljaren igen.");
const AGENDA_ERRORS = {
  not_found: agendaNotFound,
  trashed: agendaNotFound,
  not_doc: () => failed("agenda_not_doc", 400, "Det du valde är inte ett Google-dokument."),
  no_edit: () =>
    failed(
      "agenda_no_edit",
      403,
      "Ditt Google-konto kan inte redigera dokumentet. Be den som äger det att dela det med dig, eller skapa ett nytt dokument.",
    ),
} as const;
const agendaUsed = () => failed("agenda_used", 409, "Dokumentet används redan av ett annat möte. Välj ett annat eller skapa ett nytt.");
const agendaNoItems = () =>
  failed(
    "agenda_no_items",
    422,
    "Vi hittade ingen dagordning i dokumentet (en lista under ”Agenda” eller ”Dagordning”). Skapa ett nytt dokument i stället?",
  );
const docFailed = () =>
  failed("doc_failed", 502, "Vi kunde inte skapa mötesdokumentet i din Google Drive. Försök igen om en liten stund.");

/** Revision conflicts the pre-fill render retries (as anchorAgenda and the tick's CONFLICT_RETRIES). */
const PREFILL_RETRIES = 4;

/** The Doc side of a start: what the meetings row records about the Doc. */
interface DocSetup {
  docId: string;
  notesTabId: string;
  transcriptTabId: string | null;
  headerRange: string;
  headerRendered: string;
  sectionRanges: Record<string, string>;
  shareFailed: number;
  title: string;
  /** Format layout: the anchoring result. Null for a v1 Doc. */
  anchor: AnchorResult | null;
}

/**
 * The shared start logic of "Starta möte" and "Testmöte" (consent and the kill switch are
 * checked by the caller). Logs `eventKind` ('started', or 'test_started' for Testmöte).
 *
 * - agenda mode (`agendaDocId`): the starter's own grant must see and edit the Doc, and no live
 *   or ending meeting may use it; the Doc is anchored (`anchorAgenda`) and never shared by us;
 *   layout 'format'.
 * - fallback: Enkel → today's v1 Doc; any other format → a new Doc in the format
 *   (`createFormatDoc`), anchored with the skeleton's roles; layout 'format'.
 *
 * Every refusal (org, limits, format, agenda checks, an agenda without items) comes before
 * anything is written to the DB or a Doc. After the atomic start guard, a format meeting's
 * server rows (`info-tid`) and the previous meeting's open tasks ("Från förra veckan") are saved
 * and rendered; a failure there is logged and the first tick renders what is left.
 */
export async function startMeeting(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null },
  orgId: string,
  eventKind: Extract<MeetingEventKind, "started" | "test_started"> = "started",
  opts: StartOptions = {},
): Promise<StartResult> {
  // As the user: RLS hides other people's orgs (404).
  const org = await getOrg(supabase, orgId);
  if (!org) return failed("not_found", 404, "Föreningen finns inte.");
  if ((await myRole(supabase, orgId)) === null) {
    return failed("not_member", 403, "Du är inte medlem i föreningen.");
  }

  // F14: the org's live meeting and the starter's limits are checked before any Doc is touched.
  const { data: active, error: activeError } = await supabase
    .from("meetings")
    .select("id")
    .eq("org_id", orgId)
    .in("status", ["live", "ending"])
    .limit(1);
  if (activeError) throw new Error(`meetings: active check: ${activeError.message}`);
  if ((active ?? []).length > 0) {
    return failed("already_live", 409, "Ett möte pågår redan i föreningen. Avsluta det först.");
  }

  const limited = await startLimit(user.id);
  if (limited) return limited;

  const format = await resolveFormat(orgId, opts);
  if (!format) return failed("bad_format", 400, "Mötesformatet finns inte i föreningen. Ladda om sidan och försök igen.");

  let auth: OAuth2Client;
  try {
    auth = await getGoogleAuth(user.id);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return failed(
        "google_auth_lost",
        401,
        "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen, så kan du starta mötet.",
      );
    }
    console.error(`meetings: google auth: ${(err as Error).message}`);
    return googleDown();
  }

  const meetingId = randomUUID();
  const startedAt = new Date();
  const isTest = opts.isTest ?? eventKind === "test_started";
  const agendaMode = Boolean(opts.agendaDocId);
  const ctx: SetupCtx = { auth, meetingId, startedAt, orgId, orgName: org.name, user };

  const setup = agendaMode
    ? // The tab only when the org shares transcripts at all AND the starter said yes (answer 8: default no).
      await agendaSetup(ctx, opts.agendaDocId!, format.profile, org.share_transcript && opts.transcriptInDoc === true)
    : format.profile.kind === "enkel"
      ? await v1Setup(ctx, org.share_transcript)
      : await formatSetup(ctx, format.profile, org.share_transcript);
  if ("ok" in setup) return setup;

  // Every check passed: only now may the standard format row be created (override, Testmöte).
  let formatProfileId = format.id;
  if (format.ensureKind) {
    try {
      formatProfileId = await ensureStandardRow(orgId, format.ensureKind);
    } catch (err) {
      console.error(`meetings: format row failed (Doc ${setup.docId} left in Drive): ${(err as Error).message}`);
      return failed("save_failed", 500, "Mötet kunde inte sparas. Försök igen om en liten stund.");
    }
  }

  const anchor = setup.anchor;
  const agendaRoles: Record<string, ItemRole> = anchor?.agendaRoles ?? {};
  const checkinWindow: CheckinWindow | null = Object.values(agendaRoles).includes("checkin")
    ? { startMs: null, endMs: null, closed: false, failures: 0 }
    : null;
  const layout = anchor ? "format" : "v1";

  const { error: insertError } = await supabaseAdmin()
    .from("meetings")
    .insert({
      id: meetingId,
      org_id: orgId,
      started_by: user.id,
      doc_id: setup.docId,
      notes_tab_id: setup.notesTabId,
      transcript_tab_id: setup.transcriptTabId,
      header_range: setup.headerRange,
      header_rendered: setup.headerRendered,
      section_ranges: setup.sectionRanges,
      status: "live",
      consent_confirmed_at: startedAt.toISOString(),
      started_at: startedAt.toISOString(),
      agenda_doc: agendaMode,
      layout,
      format_profile_id: formatProfileId,
      is_test: isTest,
      agenda_roles: agendaRoles,
      checkin_window: checkinWindow,
    });
  if (insertError) {
    console.error(`meetings: insert failed (Doc ${setup.docId} left in Drive): ${insertError.message}`);
    return failed("save_failed", 500, "Mötet kunde inte sparas. Försök igen om en liten stund.");
  }

  // Re-check after the insert, atomically (0021): of concurrent starts exactly one survives; the
  // guard deletes a losing row itself (its Doc stays in Drive; an agenda Doc keeps its anchoring,
  // the rare race F14 accepts: docs/learnings.md "Meeting formats A10").
  const { data: guard, error: guardError } = await supabaseAdmin().rpc("guard_meeting_start", {
    p_meeting_id: meetingId,
    p_max_per_hour: MAX_STARTS_PER_HOUR,
  });
  if (guardError) throw new Error(`meetings: start guard: ${guardError.message}`);
  if (guard === "starter_busy") return startBusy();
  if (guard === "start_rate") return startRate();

  const log = (kind: MeetingEventKind, detail: Record<string, unknown>) =>
    logEvent(meetingId, kind, detail).catch((e: Error) => console.error(`meetings: logEvent: ${e.message}`));
  await log(eventKind, {
    by: user.id,
    shareFailed: setup.shareFailed,
    transcriptTab: setup.transcriptTabId !== null,
    agenda: agendaMode,
    layout,
  });

  let carried = 0;
  if (anchor) {
    // Counts and role names only: never the Doc's text (privacy).
    await log("agenda_anchored", {
      items: Object.keys(anchor.sectionRanges).filter((k) => k.startsWith("ag-")).length,
      appended: anchor.appended.length,
      roles: [...new Set(Object.values(anchor.agendaRoles))].sort(),
    });
    try {
      carried = await prefill({
        auth,
        meeting: {
          id: meetingId,
          org_id: orgId,
          started_by: user.id,
          doc_id: setup.docId,
          notes_tab_id: setup.notesTabId,
          header_range: setup.headerRange,
          header_rendered: setup.headerRendered,
          section_ranges: setup.sectionRanges,
          layout: "format",
          agenda_roles: agendaRoles,
        },
        anchorRows: anchor.rows,
        profile: format.profile,
        isTest,
        startedAt,
        log,
      });
    } catch (err) {
      console.error(`meetings ${meetingId}: pre-fill failed (the first tick renders what was saved): ${(err as Error).message}`);
    }
  }

  return {
    ok: true,
    meetingId,
    docUrl: docUrl(setup.docId),
    orgName: org.name,
    title: setup.title,
    shareFailed: setup.shareFailed,
    agenda: agendaMode,
    appended: anchor?.appended ?? [],
    carried,
  };
}

// ---------------------------------------------------------------------------------------------
// Format

/**
 * The meeting's format, read only: `formatProfileId` (must be this org's) → `formatKind` (the
 * constant; its row is ensured only once every check has passed) → the org default (Enkel when
 * none). Null: the id is not a readable profile of this org.
 */
async function resolveFormat(
  orgId: string,
  opts: StartOptions,
): Promise<{ id: string | null; profile: FormatProfile; ensureKind: StandardKind | null } | null> {
  const db = supabaseAdmin();
  if (opts.formatProfileId) {
    // Explicitly this org's: RLS alone would let a member of two orgs use the other org's profile.
    const { data, error } = await db
      .from("format_profiles")
      .select("id, org_id, profile")
      .eq("id", opts.formatProfileId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw new Error(`meetings: format: ${error.message}`);
    const profile = data && data.org_id === orgId ? parseProfile(data.profile) : null;
    return profile ? { id: data!.id as string, profile, ensureKind: null } : null;
  }
  if (opts.formatKind) return { id: null, profile: STANDARD[opts.formatKind], ensureKind: opts.formatKind };
  const def = await orgDefaultFormat(db, orgId);
  return { id: def.id, profile: def.profile, ensureKind: null };
}

// ---------------------------------------------------------------------------------------------
// The Doc per mode: a Failure, or what the meetings row needs

interface SetupCtx {
  auth: OAuth2Client;
  meetingId: string;
  startedAt: Date;
  orgId: string;
  orgName: string;
  user: { id: string; email?: string | null };
}

async function otherMembers(ctx: SetupCtx): Promise<string[]> {
  return (await memberEmails(ctx.orgId)).filter((e) => e.toLowerCase() !== (ctx.user.email ?? "").toLowerCase());
}

/** Agenda mode: the checks (no writes), then the anchoring. Their Doc: never shared by us. */
async function agendaSetup(
  ctx: SetupCtx,
  docId: string,
  profile: FormatProfile,
  transcriptInDoc: boolean,
): Promise<DocSetup | Failure> {
  let access;
  try {
    access = await checkAgendaDoc(ctx.auth, docId);
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return authLost();
    console.error(`meetings: agenda check failed: ${(err as Error).message}`);
    return googleDown();
  }
  if (!access.ok) return AGENDA_ERRORS[access.error]();

  // Any org's meeting (service role): one Doc, one running meeting. A done or abandoned meeting on
  // the Doc (a false start) is fine: the new meeting anchors with its own ss-<newId>-… ranges.
  const { data: used, error: usedError } = await supabaseAdmin()
    .from("meetings")
    .select("id")
    .eq("doc_id", docId)
    .in("status", ["live", "ending"])
    .limit(1);
  if (usedError) throw new Error(`meetings: agenda used check: ${usedError.message}`);
  if ((used ?? []).length > 0) return agendaUsed();

  let anchor: AnchorResult;
  try {
    // Throws AgendaShapeError before writing anything when the Doc has no agenda items.
    anchor = await anchorAgenda(ctx.auth, { meetingId: ctx.meetingId, orgId: ctx.orgId, docId, profile, startedAt: ctx.startedAt });
  } catch (err) {
    if (err instanceof AgendaShapeError) return agendaNoItems();
    if (err instanceof GoogleAuthLostError) return authLost();
    console.error(`meetings: anchoring failed: ${(err as Error).message}`);
    return failed("doc_failed", 502, "Vi kunde inte förbereda dokumentet. Försök igen om en liten stund.");
  }

  let transcriptTabId: string | null = null;
  if (transcriptInDoc) {
    try {
      transcriptTabId = await addTranscriptTab(ctx.auth, docId);
    } catch (err) {
      // The transcript is kept in our DB either way: the meeting goes on without the tab.
      console.error(`meetings: transcript tab failed: ${(err as Error).message}`);
    }
  }

  return {
    docId,
    notesTabId: anchor.tabId,
    transcriptTabId,
    headerRange: anchor.headerRange,
    headerRendered: anchor.headerRendered,
    sectionRanges: anchor.sectionRanges,
    shareFailed: 0,
    title: access.name || meetingTitle(ctx.orgName, ctx.startedAt),
    anchor,
  };
}

/** Fallback, Enkel: today's v1 Doc. */
async function v1Setup(ctx: SetupCtx, shareTranscript: boolean): Promise<DocSetup | Failure> {
  try {
    const doc = await createMeetingDoc(ctx.auth, {
      meetingId: ctx.meetingId,
      orgName: ctx.orgName,
      startedAt: ctx.startedAt,
      memberEmails: await otherMembers(ctx),
      shareTranscript,
    });
    return {
      docId: doc.docId,
      notesTabId: doc.notesTabId,
      transcriptTabId: doc.transcriptTabId,
      headerRange: doc.headerRange,
      headerRendered: doc.headerRendered,
      sectionRanges: doc.sectionRanges,
      shareFailed: doc.shareFailed.length,
      title: meetingTitle(ctx.orgName, ctx.startedAt),
      anchor: null,
    };
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return authLost();
    console.error(`meetings: create doc failed: ${(err as Error).message}`);
    return docFailed();
  }
}

/** Fallback in a format: a new Doc with the format's skeleton, anchored like an agenda Doc. */
async function formatSetup(ctx: SetupCtx, profile: FormatProfile, shareTranscript: boolean): Promise<DocSetup | Failure> {
  try {
    const doc = await createFormatDoc(ctx.auth, {
      meetingId: ctx.meetingId,
      orgName: ctx.orgName,
      startedAt: ctx.startedAt,
      memberEmails: await otherMembers(ctx),
      shareTranscript,
      profile,
    });
    // The skeleton's own roles: no Claude call.
    const anchor = await anchorAgenda(ctx.auth, {
      meetingId: ctx.meetingId,
      orgId: ctx.orgId,
      docId: doc.docId,
      tabId: doc.tabId,
      profile,
      startedAt: ctx.startedAt,
      roles: rolesFromSkeleton(profile),
    });
    return {
      docId: doc.docId,
      notesTabId: anchor.tabId,
      transcriptTabId: doc.transcriptTabId,
      headerRange: anchor.headerRange,
      headerRendered: anchor.headerRendered,
      sectionRanges: anchor.sectionRanges,
      shareFailed: doc.shareFailed.length,
      title: meetingTitle(ctx.orgName, ctx.startedAt),
      anchor,
    };
  } catch (err) {
    if (err instanceof GoogleAuthLostError) return authLost();
    console.error(`meetings: create format doc failed: ${(err as Error).message}`);
    return docFailed();
  }
}

// ---------------------------------------------------------------------------------------------
// Från förra veckan

type PrefillMeeting = Pick<
  MeetingRow,
  | "id"
  | "org_id"
  | "started_by"
  | "doc_id"
  | "notes_tab_id"
  | "header_range"
  | "header_rendered"
  | "section_ranges"
  | "layout"
  | "agenda_roles"
>;

/**
 * Save the anchoring's server rows (info-tid, already in the Doc with its range) and the previous
 * meeting's open tasks as fresh rows under the follow-up item (answer 3: at start, before the
 * first tick), then render the carried rows and store their rendered fields. No tick lease exists
 * yet, so plain service-role writes, not save_note_rows. Returns the number of carried rows saved.
 */
async function prefill(input: {
  auth: OAuth2Client;
  meeting: PrefillMeeting;
  anchorRows: NoteItemRow[];
  profile: FormatProfile;
  isTest: boolean;
  startedAt: Date;
  log: (kind: MeetingEventKind, detail: Record<string, unknown>) => Promise<unknown>;
}): Promise<number> {
  const { auth, meeting, profile } = input;
  const db = supabaseAdmin();
  const groupBy = profile.tasksSection?.groupBy ?? "role";
  const ranges = meeting.section_ranges as Record<string, string>;
  const followup = Object.entries(meeting.agenda_roles ?? {}).find(([key, role]) => role === "followup" && ranges[key])?.[0];

  let carried: NoteItemRow[] = [];
  let people: RolePerson[] = [];
  if (followup) {
    // Testmöten pull only from Testmöten, real meetings only from real ones (answer 7).
    const prev = await previousMeeting(meeting.org_id, input.isTest, input.startedAt, db);
    if (prev) {
      const [prevRows, ppl] = await Promise.all([
        db.from("note_items").select("*").eq("meeting_id", prev.id),
        db.from("people").select("id, name, role").eq("org_id", meeting.org_id),
      ]);
      if (prevRows.error) throw new Error(`prefill: previous rows: ${prevRows.error.message}`);
      if (ppl.error) throw new Error(`prefill: people: ${ppl.error.message}`);
      people = (ppl.data ?? []) as RolePerson[];
      const open = openTasks((prevRows.data ?? []) as NoteItemRow[]);
      carried = carriedItems(prev.id, open, followup, people, groupBy).map((r) => ({ ...r, meeting_id: meeting.id }));
    }
  }

  const rows = [...input.anchorRows.map((r) => ({ ...r, meeting_id: meeting.id })), ...carried];
  if (!rows.length) return 0;
  const { error: insertError } = await db.from("note_items").insert(rows);
  if (insertError) throw new Error(`prefill: insert: ${insertError.message}`);
  if (!carried.length) return 0;

  try {
    await renderCarried(auth, meeting as MeetingRow, rows, carried, profile, people, groupBy);
  } catch (err) {
    // Saved but unrendered (range_name null): the first tick renders them like any new item.
    console.error(`meetings ${meeting.id}: pre-fill render failed: ${(err as Error).message}`);
  }
  await input.log("followup_prefilled", { count: carried.length });
  return carried.length;
}

async function renderCarried(
  auth: OAuth2Client,
  meeting: MeetingRow,
  rows: NoteItemRow[],
  carried: NoteItemRow[],
  profile: FormatProfile,
  people: RolePerson[],
  groupBy: "role" | "person",
): Promise<void> {
  const carriedIds = new Set(carried.map((r) => r.id));
  const format = {
    plan: planFormatRender,
    profile,
    ownerLabel: (owner: string) => ownerLabel(resolveOwner(owner, people), owner, groupBy),
  };
  for (let attempt = 0; attempt <= PREFILL_RETRIES; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs());
    // A fresh revision: the anchoring (and a transcript tab) moved the Doc on.
    const tab = await readNotesTab(auth, meeting.doc_id, meeting.notes_tab_id);
    const res = await renderItems(auth, meeting, rows, rows.map(toNotesItem), tab.revisionId, undefined, format);
    if (res.status === "conflict") continue;
    if (res.status !== "ok") return;
    const db = supabaseAdmin();
    for (const r of res.rows) {
      if (!carriedIds.has(r.id) || !r.range_name) continue;
      const { error } = await db
        .from("note_items")
        .update({ range_name: r.range_name, last_rendered_text: r.last_rendered_text, position: r.position })
        .eq("meeting_id", meeting.id)
        .eq("id", r.id);
      if (error) throw new Error(`prefill: update ${r.id}: ${error.message}`);
    }
    return;
  }
  console.warn(`meetings ${meeting.id}: pre-fill render kept conflicting; the first tick renders it`);
}

// ---------------------------------------------------------------------------------------------
// Limits

const startBusy = () =>
  failed("starter_busy", 409, "Du har redan ett möte igång. Öppna det och avsluta det först (under Möten i föreningen).");
const startRate = () =>
  failed("start_rate", 429, "Du har startat många möten den senaste timmen. Vänta en stund och försök igen.");

/**
 * Per-user start limits (Ruling 39), counted from meetings rows across every org: at most one
 * live meeting per starter, and MAX_STARTS_PER_HOUR starts per rolling hour. Checked before the
 * Doc is created; guard_meeting_start (0021) enforces the same atomically after the insert.
 */
async function startLimit(userId: string): Promise<StartResult | null> {
  const db = supabaseAdmin();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const [active, recent] = await Promise.all([
    db.from("meetings").select("id, started_at").eq("started_by", userId).eq("status", "live"),
    db.from("meetings").select("id, started_at").eq("started_by", userId).gte("started_at", hourAgo),
  ]);
  if (active.error) throw new Error(`meetings: start limit: ${active.error.message}`);
  if (recent.error) throw new Error(`meetings: start limit: ${recent.error.message}`);
  if ((active.data ?? []).length > 0) return startBusy();
  if ((recent.data ?? []).length >= MAX_STARTS_PER_HOUR) return startRate();
  return null;
}
