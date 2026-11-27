import "server-only";
import { randomUUID } from "node:crypto";
import type { OAuth2Client } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAgendaDoc } from "@/lib/agenda/access";
import { AgendaShapeError, anchorAgenda, cleanupLosingAnchor, type AnchorResult } from "@/lib/agenda/anchor";
import { carriedForMeeting, previousMeeting, previousMeetingOfKinds, previousOnDoc } from "@/lib/agenda/followup";
import { preparedSkipsMeetings } from "@/lib/prepare/carry-source";
import { missingRequired } from "@/lib/agenda/scan";
import { addTranscriptTab, createFormatDoc, createMeetingDoc, meetingTitle, trashDoc, type DocPlace } from "@/lib/docs/create";
import { planFormatRender } from "@/lib/docs/format-render";
import { itemSpan, readNotesTab, renderItems, toNotesItem } from "@/lib/docs/notes";
import { logEvent } from "@/lib/db/events";
import { orgMemberList, type OrgMember } from "@/lib/db/members";
import { recordDocShares, type ShareDetail } from "@/lib/docs/access";
import { getOrg, myRole } from "@/lib/db/orgs";
import type { CheckinWindow, ItemRole, MeetingEventKind, MeetingRow, NoteItemRow } from "@/lib/db/types";
import { meetingRoles, parseProfile, type FormatProfile } from "@/lib/formats/schema";
import { rolesFromSkeleton } from "@/lib/formats/skeleton";
import { STANDARD } from "@/lib/formats/standard";
import { ensureStandardRow, orgDefaultFormat } from "@/lib/formats/store";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { retryDelayMs, sleep } from "@/lib/google/docs";
import { MAX_STARTS_PER_HOUR } from "@/lib/limits";
import { ownerLabel, resolveOwner, type RolePerson } from "@/lib/people/roles";
import { saveAgendaLabels } from "@/lib/dashboard/labels";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { testPeople, usesTestPeople } from "@/lib/testmeeting/fixture";
import { docUrl } from "@/lib/ui/meetings";
import { kindsOfType } from "@/lib/prepare/draft";
import { withGoalItems } from "@/lib/prepare/goals";
import { goalTitles } from "@/lib/prepare/goals-load";
import { preparedForDoc, type PreparedAgenda } from "@/lib/prepare/store";
import type { MeetingCalendarEvent } from "@/lib/calendar/events";
import { calendarSnapshotForStart } from "@/lib/calendar/load";
import { isUuid } from "@/lib/db/ids";
import { privatTitle } from "@/lib/privat/format";
import { isPrivat } from "@/lib/privat/space";
import { planForetagStart, saveAttendees, type ForetagStart } from "@/lib/foretag/start";

export type { StandardKind } from "@/lib/formats/standard";
import type { StandardKind } from "@/lib/formats/standard";

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
  /** Agenda mode: Simon Says created the agenda Doc (the Testmöte agenda), so it may share it. */
  agendaCreatedByApp?: boolean;
  /**
   * A new Doc in a format (not agenda mode, not Enkel): the förening's goals ticked under "Mål att
   * ta upp" (org_goals ids, at most two; todo #12), added as topic items. Titles are re-read here.
   */
  goalIds?: string[];
  /**
   * The calendar event picked on the förening page ("Starta", todo #14). Re-read with the
   * starter's own grant; without it, the förening calendar's event happening now is used.
   */
  calendarEventId?: string;
  /**
   * A Privat space only (0045): the context the recording belongs to (required there), and
   * whether to also write a Google Doc ("Skriv även i ett Google-dokument"). Without a Doc the
   * notes live in note_items only and no Google call is made.
   */
  contextId?: string | null;
  withDoc?: boolean;
  /**
   * A Företag only (0050): the group the meeting is for (null = Hela företaget) and "Privat möte"
   * (only attendees and admins see it). Always a new Enkel Doc, shared with exactly the viewers.
   */
  groupId?: string | null;
  private?: boolean;
  /** A Företag only: colleagues the starter ticked as attending the confirmed calendar event (`calendarEventId`). */
  attendeeIds?: string[];
}

export type StartResult =
  | {
      ok: true;
      meetingId: string;
      docUrl: string;
      orgName: string;
      title: string;
      shareFailed: number;
      /**
       * Where the Doc is: the förening's meeting folder, the starter's own folder (no meeting
       * folder, or this starter's Google account hasn't opened it), or the förening's agenda Doc.
       */
      docPlace: DocPlace | "agenda";
      /** The förening has a meeting folder, but the new Doc is in the starter's own folder (their grant can't add to it). */
      missedMeetingFolder: boolean;
      /** Started in the förening's own agenda Doc. */
      agenda: boolean;
      /** Section headings Simon Says appended to the Doc (labels of the format, in Doc order). */
      appended: string[];
      /** Open tasks of the previous meeting pre-filled under "Från förra veckan". */
      carried: number;
      /**
       * Agenda mode: the format's required items (stadgar) the agenda Doc lacks, in the profile's
       * spelling. Only shown to the starter; never written into their Doc. Empty otherwise (a new
       * Doc carries every required item in its skeleton).
       */
      warnings: string[];
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
const agendaSeveral = () =>
  failed(
    "agenda_several",
    422,
    "Dokumentet har flera dagordningar (flera möten i samma dokument). Välj ett dokument med bara det här mötet, eller skapa ett nytt dokument.",
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
  /** Members (user ids) the new Doc was shared with. */
  sharedWith: string[];
  /** Per shared member: the Drive permission Simon Says created (0053). */
  shareDetails?: Record<string, ShareDetail>;
  place: DocPlace | "agenda";
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
  // Privat (0045): a context of this space is required; a new Doc only when asked for (Enkel), else none.
  const privat = isPrivat(org) ? await privatContext(orgId, opts.contextId) : null;
  if (isPrivat(org) && !privat) return failed("bad_context", 400, "Välj vad inspelningen gäller och försök igen.");
  if (privat) opts = { formatKind: "enkel", isTest: opts.isTest, contextId: privat.id, withDoc: opts.withDoc === true };
  const docless = privat !== null && !opts.withDoc;
  // Företag (0050): the group, Privat möte, attendees, customer and the Doc's share list.
  let foretag: ForetagStart | null = null;
  if (org.kind === "foretag") {
    const planned = await planForetagStart({
      orgId,
      user,
      groupId: opts.groupId,
      private: opts.private,
      calendarEventId: opts.calendarEventId ?? null,
      attendeeIds: opts.attendeeIds ?? [],
      readCalendar: eventKind === "started",
    });
    if (!planned.ok) return failed("bad_group", 400, "Gruppen finns inte längre. Ladda om sidan och välj igen.");
    foretag = planned.plan;
    opts = { formatKind: "enkel", isTest: opts.isTest };
  }

  // F14: the org's live meeting and the starter's limits are checked before any Doc is touched.
  // A Företag runs several meetings at once (0050): only the starter's own limit applies there.
  const { data: active, error: activeError } = foretag
    ? { data: [], error: null }
    : await supabase
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

  // The calendar event this meeting is (todo #14), looked up alongside the checks below: its title
  // names the Doc, its guests are expected attendance. Never a Testmöte or a Privat space; best effort (null).
  const calendarP: Promise<MeetingCalendarEvent | null> =
    eventKind === "started" && org.calendar_id && !isPrivat(org)
      ? calendarSnapshotForStart({ userId: user.id, org, eventId: opts.calendarEventId ?? null })
      : Promise.resolve(null);

  // Förbered möte (0033): a Doc Simon Says prepared for this förening. Looked up here, never taken
  // from the request: the Doc is ours (shareable), it runs in the prepared format unless the
  // starter chose another, and its "Från förra veckan" lines are adopted. Not for Testmöten.
  const prepared = opts.agendaDocId && eventKind === "started" ? await preparedForDoc(orgId, opts.agendaDocId) : null;
  if (prepared && !opts.formatProfileId && !opts.formatKind && prepared.format_profile_id) {
    opts = { ...opts, formatProfileId: prepared.format_profile_id };
  }

  const format = docless ? { id: null, profile: STANDARD.enkel, ensureKind: null } : await resolveFormat(orgId, opts);
  if (!format) return failed("bad_format", 400, "Mötesformatet finns inte i föreningen. Ladda om sidan och försök igen.");

  let auth: OAuth2Client = null!;
  try {
    // A Doc-less Privat recording never talks to Google.
    if (!docless) auth = await getGoogleAuth(user.id);
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

  const calendarEvent = await calendarP;
  const meetingId = randomUUID();
  const startedAt = new Date();
  const isTest = opts.isTest ?? eventKind === "test_started";
  const agendaMode = Boolean(opts.agendaDocId);
  const ctx: SetupCtx = {
    auth,
    meetingId,
    startedAt,
    orgId,
    // Privat: the Doc and its folder are named after the context ("Simon Says – TDDE15").
    orgName: privat ? privat.name : org.name,
    // Företag: the starter's own folder, never a shared one (it would bypass who may see the meeting).
    meetingFolderId: foretag ? null : (org.meeting_folder_id ?? null),
    isTest,
    user,
    eventTitle: (foretag ? foretag.eventTitle : calendarEvent?.title) || null,
    shareTo: foretag ? foretag.viewers : null,
  };

  const setup = docless
    ? doclessSetup(privat!.name, startedAt)
    : agendaMode
    ? await agendaSetup(ctx, opts.agendaDocId!, format.profile)
    : format.profile.kind === "enkel"
      ? await v1Setup(ctx, format.profile, org.share_transcript)
      : await formatSetup(ctx, withGoalItems(format.profile, await goalTitles(orgId, opts.goalIds ?? [])), org.share_transcript);
  if ("ok" in setup) return setup;

  const anchor = setup.anchor;
  // The Må-runda is hidden only when the format opts in (meetingRoles); else it is an ordinary item.
  const agendaRoles: Record<string, ItemRole> = meetingRoles(anchor?.agendaRoles ?? {}, format.profile);
  const checkinWindow: CheckinWindow | null = Object.values(agendaRoles).includes("checkin")
    ? { startMs: null, endMs: null, closed: false, failures: 0 }
    : null;
  const layout = anchor ? "format" : "v1";

  const row = {
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
      // A standard row for `formatKind` is ensured after the guard (no write for a refused start).
      format_profile_id: format.id,
      is_test: isTest,
      agenda_roles: agendaRoles,
      checkin_window: checkinWindow,
      ...(privat ? { context_id: privat.id } : {}),
      ...(foretag ? { group_id: foretag.groupId, private: foretag.private, context_id: foretag.customerId } : {}),
  };
  // 0030: Simon Says only ever shares a Doc it created.
  const appCreated = !agendaMode || opts.agendaCreatedByApp === true || prepared !== null;
  let { error: insertError } = await supabaseAdmin().from("meetings").insert({ ...row, app_created_doc: appCreated });
  // A database without 0030 (deploy order): the row without the column.
  if (insertError && (insertError.code === "PGRST204" || insertError.code === "42703")) {
    console.warn("meetings: app_created_doc missing (0030 not applied)");
    ({ error: insertError } = await supabaseAdmin().from("meetings").insert(row));
  }
  // A refused start never leaves a new, empty Doc in the förening's folder (an agenda Doc is theirs).
  const discardNewDoc = async () => {
    if (agendaMode || docless) return;
    await trashDoc(auth, setup.docId).catch((e: Error) => console.error(`meetings ${meetingId}: trash unused Doc: ${e.message}`));
  };
  if (insertError) {
    console.error(`meetings: insert failed (Doc ${setup.docId} trashed): ${insertError.message}`);
    await discardNewDoc();
    return failed("save_failed", 500, "Mötet kunde inte sparas. Försök igen om en liten stund.");
  }

  // Re-check after the insert, atomically (0027: per starter, per org and per Doc): of concurrent
  // starts exactly one survives; the guard deletes a losing row itself (a new Doc stays in Drive).
  // A losing start on an agenda Doc then removes its own anchoring from the Doc (parked N5).
  const guardArgs = { p_meeting_id: meetingId, p_max_per_hour: MAX_STARTS_PER_HOUR };
  let { data: guard, error: guardError } = await supabaseAdmin().rpc("guard_meeting_start_v2", guardArgs);
  // A database without 0027 yet (deploy order): the 0021 guard, so a start never fails on it.
  if (guardError && (guardError.code === "PGRST202" || guardError.code === "42883")) {
    console.warn("meetings: guard_meeting_start_v2 missing; using guard_meeting_start (0021)");
    ({ data: guard, error: guardError } = await supabaseAdmin().rpc("guard_meeting_start", guardArgs));
  }
  if (guardError) throw new Error(`meetings: start guard: ${guardError.message}`);
  const refused = guard === "starter_busy" || guard === "start_rate" || guard === "org_busy" || guard === "doc_busy";
  if (refused && agendaMode && setup.anchor) await undoLosingAnchor(auth, setup.docId, meetingId, setup.anchor);
  if (refused) await discardNewDoc();
  if (guard === "starter_busy") return startBusy();
  if (guard === "start_rate") return startRate();
  if (guard === "org_busy") return failed("already_live", 409, "Ett möte pågår redan i föreningen. Avsluta det först.");
  if (guard === "doc_busy") return agendaUsed();
  if (guard !== "ok") throw new Error(`meetings: start guard: ${String(guard)}`);

  // The start stands. Only now the remaining writes: the standard format row and the Transkript tab.
  const admin = supabaseAdmin();
  if (format.ensureKind) {
    try {
      const formatProfileId = await ensureStandardRow(orgId, format.ensureKind);
      const { error } = await admin.from("meetings").update({ format_profile_id: formatProfileId }).eq("id", meetingId);
      if (error) throw new Error(error.message);
    } catch (err) {
      // Never run a meeting under the wrong format (profileFor would read Enkel): undo the start.
      console.error(`meetings: format row failed (Doc ${setup.docId} trashed): ${(err as Error).message}`);
      await discardNewDoc();
      const { error } = await admin.from("meetings").delete().eq("id", meetingId);
      if (error) {
        // The row stays: never leave it live (it would block the org and the Doc). Abandoned instead.
        console.error(`meetings ${meetingId}: undo after format row failure: ${error.message}`);
        const { error: e2 } = await admin
          .from("meetings")
          .update({ status: "abandoned", end_status: "abandoned", ended_at: new Date().toISOString() })
          .eq("id", meetingId);
        if (e2) console.error(`meetings ${meetingId}: marking abandoned failed: ${e2.message}`);
      }
      return failed("save_failed", 500, "Mötet kunde inte sparas. Försök igen om en liten stund.");
    }
  }
  let transcriptTabId = setup.transcriptTabId;
  // Agenda mode: the tab only when the org shares transcripts at all AND the starter said yes
  // (answer 8: default no). Soft: the transcript is kept in our DB either way.
  if (agendaMode && org.share_transcript && opts.transcriptInDoc === true) {
    try {
      const tabId = await addTranscriptTab(auth, setup.docId);
      const { error } = await admin.from("meetings").update({ transcript_tab_id: tabId }).eq("id", meetingId);
      if (error) throw new Error(`save tab id: ${error.message}`);
      transcriptTabId = tabId;
    } catch (err) {
      console.error(`meetings ${meetingId}: transcript tab failed: ${(err as Error).message}`);
    }
  }

  if (calendarEvent) await saveCalendarEvent(meetingId, calendarEvent);
  if (foretag) await saveAttendees(meetingId, foretag.attendees);

  const missedMeetingFolder = setup.place === "own_folder" && Boolean(org.meeting_folder_id);
  // Who got the Doc (the org page shows "Dokument" only to them and the starter). Best effort.
  // A prepared agenda was shared with the members when it was made (through the preparer's grant).
  await recordDocShares(meetingId, [...new Set([...setup.sharedWith, ...(prepared?.shared_with ?? [])])], setup.shareDetails ?? {});

  const log = (kind: MeetingEventKind, detail: Record<string, unknown>) =>
    logEvent(meetingId, kind, detail).catch((e: Error) => console.error(`meetings: logEvent: ${e.message}`));
  await log(eventKind, {
    by: user.id,
    shareFailed: setup.shareFailed,
    docPlace: setup.place,
    missedMeetingFolder,
    transcriptTab: transcriptTabId !== null,
    agenda: agendaMode,
    layout,
    // Counts only: never the event's title or guests.
    ...(calendarEvent ? { calendar: { expected: calendarEvent.expected.length, declined: calendarEvent.declined.length } } : {}),
  });

  let carried = 0;
  if (anchor) {
    // Counts and role names only: never the Doc's text (privacy).
    await log("agenda_anchored", {
      items: Object.keys(anchor.sectionRanges).filter((k) => k.startsWith("ag-")).length,
      appended: anchor.appended.length,
      roles: [...new Set(Object.values(anchor.agendaRoles))].sort(),
    });
    // The org dashboard's agenda labels (0028): safe labels only, best effort, never a Testmöte.
    if (!isTest) await saveAgendaLabels(meetingId, orgId, anchor.scan.items.filter((i) => i.key in anchor.sectionRanges));
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
        agendaDoc: agendaMode,
        startedAt,
        prepared,
        log,
      });
    } catch (err) {
      console.error(`meetings ${meetingId}: pre-fill failed (the first tick renders what was saved): ${(err as Error).message}`);
    }
  }

  // Privat: the picker suggests this context next time.
  if (privat) {
    const { error } = await admin.from("contexts").update({ last_used_at: startedAt.toISOString() }).eq("id", privat.id);
    if (error) console.error(`meetings ${meetingId}: context last used: ${error.message}`);
  }

  return {
    ok: true,
    meetingId,
    // "" = no Doc (a Doc-less Privat recording).
    docUrl: setup.docId ? docUrl(setup.docId) : "",
    orgName: org.name,
    title: setup.title,
    shareFailed: setup.shareFailed,
    docPlace: setup.place,
    missedMeetingFolder,
    agenda: agendaMode,
    appended: anchor?.appended ?? [],
    carried,
    warnings: agendaMode && anchor ? missingRequired(anchor.scan, format.profile) : [],
  };
}

/**
 * The matched calendar event on the meeting (0046), for the tick's header and the summary's
 * attendance. Best effort: a database without 0046, or any failure, only logs.
 */
async function saveCalendarEvent(meetingId: string, event: MeetingCalendarEvent): Promise<void> {
  const { error } = await supabaseAdmin().from("meetings").update({ calendar_event: event }).eq("id", meetingId);
  if (error) console.warn(`meetings ${meetingId}: calendar event not saved (${error.code ?? ""}): ${error.message}`);
}

// ---------------------------------------------------------------------------------------------
// Privat (0045)

/** The context a Privat start asked for, only when it is this space's. */
async function privatContext(orgId: string, contextId: unknown): Promise<{ id: string; name: string } | null> {
  if (typeof contextId !== "string" || !isUuid(contextId)) return null;
  const { data, error } = await supabaseAdmin().from("contexts").select("id, name").eq("id", contextId).eq("org_id", orgId).maybeSingle();
  if (error) throw new Error(`meetings: context: ${error.message}`);
  return (data as { id: string; name: string } | null) ?? null;
}

/** A Privat recording without a Doc: nothing in Google; the row's Doc fields stay empty. */
function doclessSetup(contextName: string, startedAt: Date): DocSetup {
  return {
    docId: null!,
    notesTabId: null!,
    transcriptTabId: null,
    headerRange: null!,
    headerRendered: null!,
    sectionRanges: {},
    shareFailed: 0,
    sharedWith: [],
    place: "own_folder",
    title: privatTitle(contextName, startedAt),
    anchor: null,
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
  meetingFolderId: string | null;
  isTest: boolean;
  user: { id: string; email?: string | null };
  /** The matched calendar event's title (todo #14), for the Doc's name. */
  eventTitle?: string | null;
  /** Företag (0050): share the new Doc only with these accounts (the meeting's viewers). Null: every member. */
  shareTo?: Set<string> | null;
}

/** The org's other members with an email (the starter owns the Doc). */
async function otherMembers(ctx: SetupCtx): Promise<OrgMember[]> {
  const me = (ctx.user.email ?? "").toLowerCase();
  return (await orgMemberList(ctx.orgId)).filter(
    (m) => m.userId !== ctx.user.id && m.email && m.email.toLowerCase() !== me && (!ctx.shareTo || ctx.shareTo.has(m.userId)),
  );
}

/** The user ids of `members` whose email is in `shared`. */
const sharedIds = (members: OrgMember[], shared: string[]) => {
  const ok = new Set(shared.map((e) => e.toLowerCase()));
  return members.filter((m) => ok.has(m.email.toLowerCase())).map((m) => m.userId);
};

/** Per member the new Doc was shared with: the permission we created (a new Doc: never preexisting). */
const shareDetails = (members: OrgMember[], grants: Record<string, string> | undefined): Record<string, ShareDetail> =>
  Object.fromEntries(
    members.flatMap((m) => {
      const id = grants?.[m.email.toLowerCase()];
      return id ? [[m.userId, { email: m.email, permissionId: id, preexisting: false }] as const] : [];
    }),
  );

/** The new Doc's file name: date and time, "Mötesprotokoll", the förening; a Testmöte marked. */
const docTitle = (ctx: SetupCtx) => meetingTitle(ctx.orgName, ctx.startedAt, { test: ctx.isTest, eventTitle: ctx.eventTitle });

/** Agenda mode: the checks (no writes), then the anchoring (the only Doc write before the guard, F14). Their Doc: never shared by us. */
/**
 * A start the guard refused after anchoring the förening's Doc (parked N5): remove its ranges and
 * its status line (handing back a status line it took over), revision-guarded. Best effort: a
 * failure is logged (ids and counts only, never the Doc's text) and the refusal stands.
 */
async function undoLosingAnchor(auth: OAuth2Client, docId: string, meetingId: string, anchor: AnchorResult): Promise<void> {
  try {
    const n = await cleanupLosingAnchor(auth, { docId, tabId: anchor.tabId, meetingId, replaced: anchor.replacedStatus });
    console.warn(`meetings ${meetingId}: start refused; anchoring removed from Doc ${docId} (${n} requests)`);
  } catch (err) {
    console.error(`meetings ${meetingId}: start refused; anchoring cleanup failed: ${(err as Error).message}`);
  }
}

async function agendaSetup(ctx: SetupCtx, docId: string, profile: FormatProfile): Promise<DocSetup | Failure> {
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
    const ownInfo = await earlierInfo(docId);
    anchor = await anchorAgenda(ctx.auth, { meetingId: ctx.meetingId, orgId: ctx.orgId, docId, profile, startedAt: ctx.startedAt, ownInfo });
  } catch (err) {
    if (err instanceof AgendaShapeError) return err.code === "several_agendas" ? agendaSeveral() : agendaNoItems();
    if (err instanceof GoogleAuthLostError) return authLost();
    console.error(`meetings: anchoring failed: ${(err as Error).message}`);
    return failed("doc_failed", 502, "Vi kunde inte förbereda dokumentet. Försök igen om en liten stund.");
  }

  return {
    docId,
    notesTabId: anchor.tabId,
    // A Transkript tab, if wanted, is added after the start guard.
    transcriptTabId: null,
    headerRange: anchor.headerRange,
    headerRendered: anchor.headerRendered,
    sectionRanges: anchor.sectionRanges,
    shareFailed: 0,
    sharedWith: [],
    place: "agenda",
    title: access.name || docTitle(ctx),
    anchor,
  };
}

/**
 * Datum / Tid rows earlier meetings wrote into this Doc and no human edited (unlocked, not
 * deleted): range name → last rendered text. anchorAgenda rewrites a cell only while it still
 * holds exactly that text (final review R1-I3). Service role: a Doc may have served another org.
 * A failed read gives {} (no cell rewritten).
 */
async function earlierInfo(docId: string): Promise<Record<string, string>> {
  const db = supabaseAdmin();
  const { data: meetings, error } = await db
    .from("meetings")
    .select("id")
    .eq("doc_id", docId)
    .in("status", ["done", "abandoned"])
    .order("started_at", { ascending: false })
    .limit(20);
  // Unreadable: nothing is proven ours, so no cell is rewritten (the safe side).
  if (error) return (console.error(`meetings: earlier info: ${error.message}`), {});
  const ids = ((meetings ?? []) as { id: string }[]).map((m) => m.id);
  if (!ids.length) return {};
  const { data: rows, error: rowsError } = await db
    .from("note_items")
    .select("range_name, last_rendered_text, locked, deleted_by_human")
    .in("meeting_id", ids)
    .in("id", ["info-tid", "info-datum"]);
  if (rowsError) return (console.error(`meetings: earlier info: ${rowsError.message}`), {});
  const out: Record<string, string> = {};
  for (const r of (rows ?? []) as Pick<NoteItemRow, "range_name" | "last_rendered_text" | "locked" | "deleted_by_human">[]) {
    if (r.range_name && r.last_rendered_text != null && !r.locked && !r.deleted_by_human) out[r.range_name] = r.last_rendered_text;
  }
  return out;
}

/** Fallback, Enkel: today's v1 Doc. */
async function v1Setup(ctx: SetupCtx, profile: FormatProfile, shareTranscript: boolean): Promise<DocSetup | Failure> {
  try {
    const members = await otherMembers(ctx);
    const title = docTitle(ctx);
    const doc = await createMeetingDoc(ctx.auth, {
      meetingId: ctx.meetingId,
      orgName: ctx.orgName,
      startedAt: ctx.startedAt,
      title,
      meetingFolderId: ctx.meetingFolderId,
      memberEmails: members.map((m) => m.email),
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
      sharedWith: sharedIds(members, doc.shared),
      shareDetails: shareDetails(members, doc.grants),
      place: doc.place,
      title,
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
    const members = await otherMembers(ctx);
    const title = docTitle(ctx);
    const doc = await createFormatDoc(ctx.auth, {
      meetingId: ctx.meetingId,
      orgName: ctx.orgName,
      startedAt: ctx.startedAt,
      title,
      meetingFolderId: ctx.meetingFolderId,
      memberEmails: members.map((m) => m.email),
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
      sharedWith: sharedIds(members, doc.shared),
      shareDetails: shareDetails(members, doc.grants),
      place: doc.place,
      title,
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
  agendaDoc: boolean;
  startedAt: Date;
  /** The prepared agenda this Doc holds (Förbered möte): its carried lines are adopted. */
  prepared?: PreparedAgenda | null;
  log: (kind: MeetingEventKind, detail: Record<string, unknown>) => Promise<unknown>;
}): Promise<number> {
  const { auth, meeting, profile } = input;
  const db = supabaseAdmin();
  const groupBy = profile.tasksSection?.groupBy ?? "role";
  const ranges = meeting.section_ranges as Record<string, string>;
  const followup = Object.entries(meeting.agenda_roles ?? {}).find(([key, role]) => role === "followup" && ranges[key])?.[0];

  let carried: NoteItemRow[] = [];
  let people: RolePerson[] = [];
  // An agenda Testmöte: the fixture's fictional people, no people rows read or referenced (Ruling 38).
  const fictional = usesTestPeople({ is_test: input.isTest, agenda_doc: input.agendaDoc });
  if (followup) {
    // Testmöten pull only from Testmöten, real meetings only from real ones (answer 7); an agenda
    // Testmöte only from agenda Testmöten. A prepared agenda: the previous meeting of its kind,
    // as the prepare drew from.
    const prepared = input.prepared ?? null;
    // A prepared agenda that drew from an imported protocol (or found it too old to draw from):
    // no older real meeting adds its tasks now; the prepared lines are the follow-up.
    const prev = prepared
      ? preparedSkipsMeetings(prepared)
        ? null
        : await previousMeetingOfKinds(meeting.org_id, input.startedAt, kindsOfType(prepared.kind), db)
      : await previousMeeting(meeting.org_id, input.isTest, input.startedAt, db, input.agendaDoc);
    // A false start on this same Doc (done or abandoned, after `prev`): its carried lines are
    // already in the Doc, so they are taken over, never written twice (final review R1/R2).
    const onDoc = await previousOnDoc(meeting.org_id, input.isTest, meeting.doc_id, input.startedAt, db);
    const sameDoc = onDoc && (!prev || onDoc.id === prev.id || !prev.startedAt || onDoc.startedAt >= prev.startedAt) ? onDoc : null;
    // No meeting on the Doc yet: the prepared lines are the ones in it.
    const fromPrepared = !onDoc && prepared && prepared.carried.length > 0 ? prepared : null;
    if (prev || sameDoc || fromPrepared) {
      const rowsOf = async (id: string) => {
        const { data, error } = await db.from("note_items").select("*").eq("meeting_id", id);
        if (error) throw new Error(`prefill: previous rows: ${error.message}`);
        return (data ?? []) as NoteItemRow[];
      };
      const [prevRows, sameRows, ppl] = await Promise.all([
        prev ? rowsOf(prev.id) : Promise.resolve([]),
        sameDoc && sameDoc.id !== prev?.id ? rowsOf(sameDoc.id) : Promise.resolve(null),
        fictional
          ? Promise.resolve({ data: testPeople(meeting.org_id), error: null })
          : db.from("people").select("id, name, role").eq("org_id", meeting.org_id),
      ]);
      if (ppl.error) throw new Error(`prefill: people: ${ppl.error.message}`);
      people = (ppl.data ?? []) as RolePerson[];
      const docRows = sameDoc ? (sameRows ?? prevRows) : (fromPrepared?.carried ?? []);
      // Only lines still in the Doc are taken over (one read; none when nothing could be). A
      // prepared agenda's lines are read too: one a human deleted stays off the agenda.
      const tab = [...docRows, ...(prepared?.carried ?? [])].some((r) => r.carried_from_id != null && r.range_name)
        ? await readNotesTab(auth, meeting.doc_id, meeting.notes_tab_id)
        : null;
      const intact = (name: string) => Boolean(tab && itemSpan(tab, name));
      carried = carriedForMeeting({
        meetingId: meeting.id,
        prev: prev ? { id: prev.id, rows: prevRows } : null,
        sameDoc: sameDoc ? { id: sameDoc.id, rows: docRows } : fromPrepared ? { id: `prep-${fromPrepared.id}`, rows: docRows } : null,
        intact,
        excluded: prepared ? preparedExclusions(prepared, intact) : undefined,
        followup,
        people,
        groupBy,
        fictional,
      });
    }
  }

  const rows = [...input.anchorRows.map((r) => ({ ...r, meeting_id: meeting.id })), ...carried];
  if (!rows.length) return 0;
  const { error: insertError } = await db.from("note_items").insert(rows);
  if (insertError) throw new Error(`prefill: insert: ${insertError.message}`);
  if (!carried.length) return 0;
  // Taken-over rows are in the Doc already; only the fresh ones are rendered.
  const toRender = carried.filter((r) => !r.range_name);
  if (!toRender.length) {
    await input.log("followup_prefilled", { count: carried.length, adopted: carried.length, rendered: true });
    return carried.length;
  }

  let rendered = false;
  try {
    rendered = await renderCarried(auth, meeting as MeetingRow, rows, toRender, profile, people, groupBy);
  } catch (err) {
    // Saved but unrendered (range_name null): the first tick renders them like any new item.
    console.error(`meetings ${meeting.id}: pre-fill render failed: ${(err as Error).message}`);
  }
  await input.log("followup_prefilled", { count: carried.length, adopted: carried.length - toRender.length, rendered });
  return carried.length;
}

/**
 * Sources a prepared agenda keeps out of "Från förra veckan": tasks the ordförande took off the
 * agenda, and carried lines a human deleted from the Doc (human edits win).
 */
function preparedExclusions(prepared: PreparedAgenda, intact: (name: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const s of prepared.dropped ?? []) {
    const i = s.lastIndexOf(":");
    if (i > 0) out.add(`${s.slice(0, i)}\u0000${s.slice(i + 1)}`);
  }
  for (const r of prepared.carried ?? []) {
    if (!r.carried_from_meeting || r.carried_from_id == null) continue;
    if (r.deleted_by_human || !r.range_name || !intact(r.range_name)) out.add(`${r.carried_from_meeting}\u0000${r.carried_from_id}`);
  }
  return out;
}

async function renderCarried(
  auth: OAuth2Client,
  meeting: MeetingRow,
  rows: NoteItemRow[],
  carried: NoteItemRow[],
  profile: FormatProfile,
  people: RolePerson[],
  groupBy: "role" | "person",
): Promise<boolean> {
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
    if (res.status !== "ok") return false;
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
    return true;
  }
  console.warn(`meetings ${meeting.id}: pre-fill render kept conflicting; the first tick renders it`);
  return false;
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
 * Doc is created; guard_meeting_start_v2 (0027) enforces the same atomically after the insert.
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
