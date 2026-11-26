import "server-only";
import { logEvent } from "@/lib/db/events";
import { orgMemberList } from "@/lib/db/members";
import type { ItemRole, SummaryMode, SummaryState } from "@/lib/db/types";
import { getEnv } from "@/lib/env";
import type { Mailer } from "@/lib/mail";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { docUrl } from "@/lib/ui/meetings";
import { isEmptySummary, summaryContent, type SummaryItem } from "./content";
import { renderSummaryEmail } from "./email";
import { presentPeople, summaryRecipients, type Recipient, type SummaryPerson, type SummarySpeaker } from "./recipients";
import { issueUnsubscribeToken } from "./token";

// Sends a finished meeting's summary e-mails (migration 0037). Called after the end sets the
// meeting `done` (lib/meetings/tick.ts finishMeeting) and by the 5-minute cron for whatever that
// missed (a Doc that was paused at the end gets its final pass later; a crashed send).
//
// Never twice: the meeting is claimed first (summary_state null → its outcome, atomically), and
// every recipient gets a ledger row (meeting_summary_sends) BEFORE the mailer is called, so a
// retry never mails anyone again. A send that failed is not retried (at most once, by design: the
// mailer also reports a timeout as a failure, and the mail may have gone out).
// Logs and the meeting event hold counts only: no addresses, names or note text.

export interface SummaryDeps {
  mailer: Mailer;
  now(): Date;
}

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
export async function sendMeetingSummaries(meetingId: string, deps: SummaryDeps): Promise<SummaryResult | null> {
  const db = supabaseAdmin();
  const m = must(
    "summary: meeting",
    await db
      .from("meetings")
      .select("id, org_id, status, is_test, doc_id, doc_paused_at, started_at, started_by, agenda_roles, summary_state")
      .eq("id", meetingId)
      .maybeSingle(),
  ) as MeetingForSummary | null;
  if (!m || m.status !== "done" || m.summary_state !== null || m.doc_paused_at) return null;

  let state: SummaryState;
  let recipients: Recipient[] = [];
  let mode: SummaryMode = "missed";
  let orgName = "";
  let people: SummaryPerson[] = [];
  let items: SummaryItem[] = [];
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
    else if (isEmptySummary(summaryContent(items, { agendaRoles: m.agenda_roles }))) state = "no_notes";
    else {
      const [peopleRows, speakers, members] = await Promise.all([
        db.from("people").select("id, name, role, email, member_user_id, summary_selected, summary_unsubscribed_at").eq("org_id", m.org_id),
        db.from("speaker_map").select("el_session_id, speaker_label, person_id, display_name, merged_into_label").eq("meeting_id", m.id),
        orgMemberList(m.org_id),
      ]);
      people = must("summary: people", peopleRows) as SummaryPerson[];
      const present = presentPeople({
        people,
        speakers: must("summary: speakers", speakers) as SummarySpeaker[],
        attendeeNames: items.filter((r) => r.section === "attendees" && !r.deleted_by_human).map((r) => r.text),
        startedBy: m.started_by,
      });
      recipients = summaryRecipients({ mode, people, members, present });
      state = recipients.length ? "sent" : "none";
    }
  }

  // Claim: only one sender ever handles a meeting.
  const claimed = must(
    "summary: claim",
    await db
      .from("meetings")
      .update({ summary_state: state, summary_at: deps.now().toISOString() })
      .eq("id", m.id)
      .eq("status", "done")
      .is("summary_state", null)
      .select("id"),
  ) as unknown[];
  if (!claimed.length) return null;

  let sent = 0;
  let failed = 0;
  if (state === "sent") {
    const shared = new Set(
      (must("summary: shares", await db.from("meeting_doc_shares").select("user_id").eq("meeting_id", m.id)) as { user_id: string }[]).map(
        (s) => s.user_id,
      ),
    );
    const origin = appOrigin();
    const key = getEnv().TOKEN_ENC_KEY;
    const starterName = people.find((p) => m.started_by && p.member_user_id === m.started_by)?.name ?? null;
    for (const r of recipients) {
      // The ledger row first: a second sender (or a retry) never mails this person again.
      const ledger = must(
        "summary: ledger",
        await db
          .from("meeting_summary_sends")
          .upsert({ meeting_id: m.id, person_id: r.person.id }, { onConflict: "meeting_id,person_id", ignoreDuplicates: true })
          .select("person_id"),
      ) as unknown[];
      if (!ledger.length) continue;
      const token = issueUnsubscribeToken(key, r.person.id);
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
        unsubscribeHref: `${origin}/sammanfattning/avsluta?t=${encodeURIComponent(token)}`,
      });
      let ok = false;
      try {
        ok = await deps.mailer.send({
          to: r.email,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: {
            "List-Unsubscribe": `<${origin}/api/summaries/unsubscribe?t=${encodeURIComponent(token)}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
      } catch {
        ok = false;
      }
      if (ok) sent++;
      else failed++;
      await db.from("meeting_summary_sends").update({ sent: ok }).eq("meeting_id", m.id).eq("person_id", r.person.id);
    }
  }
  await logEvent(m.id, "summary", { state, mode, recipients: recipients.length, sent, failed });
  return { state, sent, failed };
}

/** Best effort: never throws (the meeting's end must not depend on e-mail). */
export async function trySendMeetingSummaries(meetingId: string, deps: SummaryDeps): Promise<SummaryResult | null> {
  try {
    return await sendMeetingSummaries(meetingId, deps);
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
  opts: { orgId?: string; left?: () => boolean } = {},
): Promise<number> {
  const since = new Date(deps.now().getTime() - SUMMARY_SWEEP_WINDOW_MS).toISOString();
  let query = supabaseAdmin()
    .from("meetings")
    .select("id")
    .eq("status", "done")
    .is("summary_state", null)
    .is("doc_paused_at", null)
    .gte("ended_at", since)
    .order("ended_at")
    .limit(50);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  const rows = must("summary: pending", await query) as { id: string }[];
  let handled = 0;
  for (const r of rows) {
    if (opts.left && !opts.left()) break;
    if (await trySendMeetingSummaries(r.id, deps)) handled++;
  }
  return handled;
}
