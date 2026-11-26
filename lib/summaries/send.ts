import "server-only";
import { logEvent } from "@/lib/db/events";
import { orgMemberList } from "@/lib/db/members";
import type { ItemRole, SummaryMode, SummaryState } from "@/lib/db/types";
import type { Mailer } from "@/lib/mail";
import { checkEmailGate, sendUserMail } from "@/lib/email/prefs";
import { emailPrefsUrl, listUnsubscribeHeaders } from "@/lib/email/token";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { docUrl } from "@/lib/ui/meetings";
import { hasOwnNotes, summaryContent, type SummaryItem } from "./content";
import { renderSummaryEmail } from "./email";
import { sendPrivatSummary } from "@/lib/privat/send";
import type { SummarizeFn } from "@/lib/privat/summary";
import { presentPeople, summaryRecipients, type Recipient, type SummaryPerson, type SummarySpeaker } from "./recipients";

// Sends a finished meeting's summary e-mails (migration 0037). Called after the end sets the
// meeting `done` (lib/meetings/tick.ts finishMeeting) and by the 5-minute cron for whatever that
// missed (a Doc that was paused at the end gets its final pass later; a crashed send).
//
// Never twice: the meeting is claimed first (summary_state null → `sending`, or straight to its
// outcome when there is nobody to mail), and every recipient gets a ledger row
// (meeting_summary_sends) BEFORE the mailer is called, so a resumed run never mails anyone again.
// The loop stops cleanly before the caller's deadline and leaves the meeting `sending`; the cron
// resumes it (also one whose function was killed mid-loop) and only then marks it `sent`. A send
// that failed is not retried (at most once, by design: the mailer also reports a timeout as a
// failure, and the mail may have gone out).
// Logs and the meeting event hold counts only: no addresses, names or note text.

export interface SummaryDeps {
  mailer: Mailer;
  now(): Date;
  /** Between two e-mails (Resend allows a few requests per second per team). Default: a real wait. */
  sleep?(ms: number): Promise<void>;
  /** A Privat recording's Claude summary (tests replace it); default: the real call. */
  summarize?: SummarizeFn;
}

/** Pause between two e-mails of one meeting: stays under Resend's default rate limit. */
export const SEND_GAP_MS = 600;
/** Don't start another e-mail with less time than this before the caller's deadline. */
export const SUMMARY_MIN_LEFT_MS = 15_000;

export interface SummaryResult {
  state: SummaryState;
  sent: number;
  failed: number;
}

/** How long after its end a meeting is still picked up by the sweep. */
export const SUMMARY_SWEEP_WINDOW_MS = 48 * 3600 * 1000;

function must<T>(what: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

interface MeetingForSummary {
  id: string;
  org_id: string;
  status: string;
  is_test: boolean | null;
  doc_id: string;
  doc_paused_at: string | null;
  started_at: string;
  started_by: string | null;
  agenda_roles: Record<string, ItemRole> | null;
  summary_state: SummaryState | null;
}

/** Where "Öppna protokollet" goes for this recipient, and the line under it. */
export function accessFor(
  r: Pick<Recipient, "userId">,
  m: { id: string; org_id: string; doc_id: string; started_by: string | null },
  shared: Set<string>,
  origin: string,
  starterName: string | null,
): { href: string; note: string | null } {
  if (r.userId && (r.userId === m.started_by || shared.has(r.userId))) return { href: docUrl(m.doc_id), note: null };
  if (r.userId) {
    return {
      href: `${origin}/orgs/${m.org_id}#mote-${m.id}`,
      note: "Knappen öppnar mötet på föreningens sida i Simon Says. Där får du tillgång till dokumentet.",
    };
  }
  return {
    href: docUrl(m.doc_id),
    note: `Protokollet är ett Google-dokument. Kommer du inte åt det, be ${starterName ?? "den som startade mötet"} dela det med dig.`,
  };
}

/**
 * Handle one meeting's summary. Null when there is nothing to do (not done yet, its Doc is paused,
 * already handled, or another sender claimed it first).
 */
export async function sendMeetingSummaries(
  meetingId: string,
  deps: SummaryDeps,
  opts: { deadlineAt?: Date } = {},
): Promise<SummaryResult | null> {
  const db = supabaseAdmin();
  const m = must(
    "summary: meeting",
    await db
      .from("meetings")
      .select("id, org_id, status, is_test, doc_id, doc_paused_at, started_at, started_by, agenda_roles, summary_state")
      .eq("id", meetingId)
      .maybeSingle(),
  ) as MeetingForSummary | null;
  if (!m || m.status !== "done" || m.doc_paused_at) return null;
  if (m.summary_state !== null && m.summary_state !== "sending") return null;
  // A Privat recording (0045): its own summary (one Claude call) to the recorder only.
  const space = must("summary: space", await db.from("orgs").select("*").eq("id", m.org_id).maybeSingle()) as { kind?: string } | null;
  if (space?.kind === "privat") return sendPrivatSummary(m.id, { mailer: deps.mailer, now: deps.now, summarize: deps.summarize }, opts);

  let state: SummaryState;
  let recipients: Recipient[] = [];
  let mode: SummaryMode = "missed";
  let orgName = "";
  let people: SummaryPerson[] = [];
  let items: SummaryItem[] = [];
  let unnamedVoices = 0;
  let unmatchedNames = 0;
  if (m.is_test) {
    state = "test";
  } else {
    const org = must("summary: org", await db.from("orgs").select("name, summary_mode").eq("id", m.org_id).maybeSingle()) as {
      name: string;
      summary_mode: SummaryMode | null;
    } | null;
    if (!org) return null;
    orgName = org.name;
    mode = org.summary_mode ?? "missed";
    items = must(
      "summary: items",
      await db
        .from("note_items")
        .select("meeting_id, id, section, kind, text, owner, due, position, done, deleted_by_human, copy_of, anchor, owner_person_id, carried_from_meeting, carried_from_id")
        .eq("meeting_id", m.id),
    ) as SummaryItem[];
    if (mode === "off") state = "off";
    else if (!hasOwnNotes(items, m.agenda_roles)) state = "no_notes";
    else {
      const [peopleRows, speakers, members] = await Promise.all([
        db
          .from("people")
          .select("id, name, role, email, member_user_id, summary_selected, summary_removed_at")
          .eq("org_id", m.org_id),
        db.from("speaker_map").select("el_session_id, speaker_label, person_id, display_name, merged_into_label, needs_confirm").eq("meeting_id", m.id),
        orgMemberList(m.org_id),
      ]);
      people = must("summary: people", peopleRows) as SummaryPerson[];
      const attendance = presentPeople({
        people,
        speakers: must("summary: speakers", speakers) as SummarySpeaker[],
        attendeeNames: items.filter((r) => r.section === "attendees" && !r.deleted_by_human).map((r) => r.text),
        startedBy: m.started_by,
      });
      unnamedVoices = attendance.unnamedVoices;
      unmatchedNames = attendance.unmatchedNames;
      recipients = summaryRecipients({ mode, people, members, attendance });
      state = recipients.length ? "sending" : mode === "missed" && !attendance.certain ? "uncertain" : "none";
    }
  }

  const stamp = { summary_at: deps.now().toISOString() };
  if (state !== "sending") {
    // Nothing to mail. A resumed run (`sending`) whose recipients are gone ends as sent.
    const final: SummaryState = m.summary_state === "sending" ? "sent" : state;
    const close = db.from("meetings").update({ summary_state: final, ...stamp }).eq("id", m.id).eq("status", "done");
    const closed = must(
      "summary: close",
      await (m.summary_state === null ? close.is("summary_state", null) : close.eq("summary_state", "sending")).select("id"),
    ) as unknown[];
    if (!closed.length) return null;
    await logEvent(m.id, "summary", { state: final, mode, recipients: 0, sent: 0, failed: 0, ...(unnamedVoices ? { unnamedVoices } : {}), ...(unmatchedNames ? { unmatchedNames } : {}) });
    return { state: final, sent: 0, failed: 0 };
  }

  // `sending`: claimed by this run (fresh) or resumed (a run that stopped at its deadline or died).
  if (m.summary_state === null) {
    const claimed = must(
      "summary: claim",
      await db.from("meetings").update({ summary_state: "sending", ...stamp }).eq("id", m.id).eq("status", "done").is("summary_state", null).select("id"),
    ) as unknown[];
    if (!claimed.length) return null;
  }

  let sent = 0;
  let failed = 0;
  let optedOut = 0;
  let stopped = false;
  /** Recipients whose preference check could not be answered: retried by the next sweep. */
  let deferred = 0;
  const shared = new Set(
    (must("summary: shares", await db.from("meeting_doc_shares").select("user_id").eq("meeting_id", m.id)) as { user_id: string }[]).map(
      (s) => s.user_id,
    ),
  );
  const origin = appOrigin();
  const starterName = people.find((p) => m.started_by && p.member_user_id === m.started_by)?.name ?? null;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeLeft = () => (opts.deadlineAt ? opts.deadlineAt.getTime() - deps.now().getTime() : Infinity);
  let mailed = false;
  for (const r of recipients) {
    // Stop cleanly before the deadline; the cron resumes `sending` meetings.
    if (timeLeft() < SUMMARY_MIN_LEFT_MS) {
      stopped = true;
      break;
    }
    // The gate first: if it can't answer, nothing is claimed and the next sweep tries again.
    if ((await checkEmailGate({ userId: r.userId, email: r.email }, "meeting_summary", db)) === "unknown") {
      deferred++;
      continue;
    }
    // The ledger row next: a second sender (or a resumed run) never mails this person again.
    const ledger = must(
      "summary: ledger",
      await db
        .from("meeting_summary_sends")
        .upsert({ meeting_id: m.id, person_id: r.person.id }, { onConflict: "meeting_id,person_id", ignoreDuplicates: true })
        .select("person_id"),
    ) as unknown[];
    if (!ledger.length) continue;
    if (mailed) await sleep(SEND_GAP_MS);
    mailed = true;
    const access = accessFor(r, m, shared, origin, starterName);
    const email = renderSummaryEmail({
      orgName,
      startedAt: m.started_at,
      recipientName: r.person.name,
      missed: r.missed,
      content: summaryContent(items, { agendaRoles: m.agenda_roles, people, forPerson: r.person }),
      buttonHref: access.href,
      accessNote: access.note,
      settingsHref: r.isAdmin ? `${origin}/orgs/${m.org_id}#installningar` : null,
      unsubscribeHref: emailPrefsUrl(r.email, "meeting_summary", origin),
    });
    // Through the e-mail gate (0039): an address or account that said no to meeting summaries
    // (Konto, /mejl, the one-click header) gets nothing; a check that can't be answered sends nothing.
    const result = await sendUserMail(
      deps.mailer,
      { userId: r.userId, email: r.email },
      "meeting_summary",
      { subject: email.subject, text: email.text, html: email.html, headers: listUnsubscribeHeaders(r.email, "meeting_summary", origin) },
      db,
    );
    const ok = result === "sent";
    if (ok) sent++;
    else if (result === "opted_out" || result === "invalid") optedOut++;
    else failed++;
    // Throws on a database error: the meeting stays `sending` and the next sweep resumes it.
    must("summary: record", await db.from("meeting_summary_sends").update({ sent: ok }).eq("meeting_id", m.id).eq("person_id", r.person.id));
  }
  const final: SummaryState = stopped || deferred ? "sending" : "sent";
  if (final === "sent") {
    must("summary: done", await db.from("meetings").update({ summary_state: "sent", ...stamp }).eq("id", m.id).eq("summary_state", "sending"));
  }
  await logEvent(m.id, "summary", {
    state: final,
    mode,
    recipients: recipients.length,
    sent,
    failed,
    ...(optedOut ? { optedOut } : {}),
    ...(deferred ? { deferred } : {}),
  });
  return { state: final, sent, failed };
}

/** Best effort: never throws (the meeting's end must not depend on e-mail). */
export async function trySendMeetingSummaries(
  meetingId: string,
  deps: SummaryDeps,
  opts: { deadlineAt?: Date } = {},
): Promise<SummaryResult | null> {
  try {
    return await sendMeetingSummaries(meetingId, deps, opts);
  } catch (e) {
    console.error(`summary ${meetingId}: ${(e as Error).message}`.slice(0, 300));
    return null;
  }
}

/**
 * The cron's step: done meetings that ended within SUMMARY_SWEEP_WINDOW_MS, whose summary is not
 * handled yet and whose Doc is not paused. `left()` false stops starting new ones.
 */
export async function sendPendingSummaries(
  deps: SummaryDeps,
  opts: { orgId?: string; left?: () => boolean; deadlineAt?: Date } = {},
): Promise<number> {
  const since = new Date(deps.now().getTime() - SUMMARY_SWEEP_WINDOW_MS).toISOString();
  let query = supabaseAdmin()
    .from("meetings")
    .select("id")
    .eq("status", "done")
    .or("summary_state.is.null,summary_state.eq.sending")
    .is("doc_paused_at", null)
    .gte("ended_at", since)
    .order("ended_at")
    .limit(50);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  const rows = must("summary: pending", await query) as { id: string }[];
  let handled = await closeStaleSending(deps, opts.orgId, since);
  for (const r of rows) {
    if (opts.left && !opts.left()) break;
    if (await trySendMeetingSummaries(r.id, deps, { deadlineAt: opts.deadlineAt })) handled++;
  }
  return handled;
}

/**
 * `sending` meetings that ended before the sweep window: give up on them (state `partial`) so they
 * don't stay unfinished forever; the event counts who got it and who didn't.
 */
async function closeStaleSending(deps: SummaryDeps, orgId: string | undefined, since: string): Promise<number> {
  const db = supabaseAdmin();
  let query = db.from("meetings").select("id").eq("summary_state", "sending").lt("ended_at", since).limit(50);
  if (orgId) query = query.eq("org_id", orgId);
  const stale = must("summary: stale", await query) as { id: string }[];
  let closed = 0;
  for (const { id } of stale) {
    const done = must(
      "summary: partial",
      await db.from("meetings").update({ summary_state: "partial", summary_at: deps.now().toISOString() }).eq("id", id).eq("summary_state", "sending").select("id"),
    ) as unknown[];
    if (!done.length) continue;
    const ledger = must("summary: partial ledger", await db.from("meeting_summary_sends").select("sent").eq("meeting_id", id)) as { sent: boolean | null }[];
    await logEvent(id, "summary", {
      state: "partial",
      sent: ledger.filter((l) => l.sent === true).length,
      failed: ledger.filter((l) => l.sent !== true).length,
    });
    console.warn(`summary ${id}: gave up after ${SUMMARY_SWEEP_WINDOW_MS / 3600_000} h (partial)`);
    closed++;
  }
  return closed;
}
