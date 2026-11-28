import "server-only";
import { orgMemberList } from "@/lib/db/members";
import type { ItemRole, SummaryMode } from "@/lib/db/types";
import { checkEmailGate, sendUserMailDetailed } from "@/lib/email/prefs";
import { emailPrefsUrl, listUnsubscribeHeaders } from "@/lib/email/token";
import { defaultLocale } from "@/lib/i18n/config";
import { localeForEmail, localesForUsers } from "@/lib/i18n/user-locale";
import type { Mailer } from "@/lib/mail";
import { stockholmDay, taskMode } from "@/lib/notes/tasks";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { summaryContent, type SummaryItem } from "./content";
import { renderSummaryEmail } from "./email";
import type { SummaryPerson } from "./recipients";
import { accessFor } from "./send";

// The growth loop's safety net (0067). The summary list loses everyone who gets the invite instead
// (lib/summaries/send.ts marks those invites `summary_fallback`). If such an invite then does not go
// out (failed, skipped at send time: an account made meanwhile, the switch turned off; or aged out
// of the queue), the person gets the summary they would have had, once: the invite's
// summary_fallback_at claims it, the summary's own ledger (meeting_summary_sends) is checked as
// always, and the send carries an Idempotency-Key. `uncertain` invites may have gone out: no fallback.

export interface FallbackDeps {
  mailer: Mailer;
  now(): Date;
}

const ENDED = ["failed", "skipped"];

function must<T>(what: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`summary fallback: ${what}: ${res.error.message}`);
  return res.data;
}

/** Send the fallback summaries due (one meeting, or all). Returns how many went out. */
export async function sendSummaryFallbacks(deps: FallbackDeps, opts: { meetingId?: string; orgId?: string } = {}): Promise<number> {
  const db = supabaseAdmin();
  let query = db
    .from("meeting_invites")
    .select("id, meeting_id, person_id, summary_missed")
    .eq("summary_fallback", true)
    .is("summary_fallback_at", null)
    .in("status", ENDED)
    // A calendar guest outside the people list (person_id null) never had a summary to lose: the
    // summary flow mails people rows only (summaryRecipients), so summary_fallback is never set for
    // one. This filter only says so explicitly.
    .not("person_id", "is", null)
    .limit(100);
  if (opts.meetingId) query = query.eq("meeting_id", opts.meetingId);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  const rows = must("due", await query) as { id: string; meeting_id: string; person_id: string; summary_missed: boolean }[];
  let sent = 0;
  for (const row of rows) {
    const claimed = must("claim", await db.from("meeting_invites").update({ summary_fallback_at: deps.now().toISOString() }).eq("id", row.id).is("summary_fallback_at", null).select("id")) as unknown[];
    if (!claimed.length) continue;
    let outcome: Outcome = "retry";
    try {
      outcome = await sendOne(row.meeting_id, row.person_id, row.summary_missed, deps);
    } catch (e) {
      console.error(`summary fallback ${row.meeting_id}: ${(e as Error).message}`.slice(0, 300));
    }
    if (outcome === "sent") sent++;
    // Not answered (the opt-out check, or a crash before the mail was handed over): released, so a
    // later run tries again, as the summary flow defers.
    if (outcome === "retry") {
      const { error } = await db.from("meeting_invites").update({ summary_fallback_at: null }).eq("id", row.id);
      if (error) console.error(`summary fallback ${row.meeting_id}: release: ${error.message}`);
    }
  }
  return sent;
}

type Outcome = "sent" | "done" | "retry";

async function sendOne(meetingId: string, personId: string, missed: boolean, deps: FallbackDeps): Promise<Outcome> {
  const db = supabaseAdmin();
  const m = must(
    "meeting",
    await db.from("meetings").select("id, org_id, status, is_test, doc_id, started_at, started_by, agenda_roles").eq("id", meetingId).maybeSingle(),
  ) as { id: string; org_id: string; status: string; is_test: boolean | null; doc_id: string; started_at: string; started_by: string | null; agenda_roles: Record<string, ItemRole> | null } | null;
  if (!m || m.status !== "done" || m.is_test) return "done";
  const org = must("org", await db.from("orgs").select("*").eq("id", m.org_id).maybeSingle()) as { name: string; summary_mode?: SummaryMode | null; require_task_fields?: boolean; kind?: string } | null;
  if (!org || org.summary_mode === "off") return "done";
  const [items, peopleRows, members, shares] = await Promise.all([
    db
      .from("note_items")
      .select("meeting_id, id, section, kind, text, owner, due, position, done, deleted_by_human, copy_of, anchor, owner_person_id, carried_from_meeting, carried_from_id, done_when, due_date, locked")
      .eq("meeting_id", m.id),
    db.from("people").select("id, name, role, email, member_user_id, summary_selected, summary_removed_at").eq("org_id", m.org_id),
    orgMemberList(m.org_id),
    db.from("meeting_doc_shares").select("user_id").eq("meeting_id", m.id),
  ]);
  const people = must("people", peopleRows) as SummaryPerson[];
  const person = people.find((p) => p.id === personId);
  if (!person) return "done";
  const member = person.member_user_id ? members.find((x) => x.userId === person.member_user_id) : undefined;
  if (!member && person.summary_removed_at) return "done";
  const email = (member?.email || person.email || "").trim();
  if (!email.includes("@")) return "done";
  const userId = member?.userId ?? null;
  // The gate first, as the summary flow: no answer → nothing claimed, retried later.
  const gate = await checkEmailGate({ userId, email }, "meeting_summary", db);
  if (gate === "unknown") return "retry";
  if (gate !== "allowed") return "done";
  // The summary's own ledger: never a second summary to this person for this meeting.
  const ledger = must(
    "ledger",
    await db.from("meeting_summary_sends").upsert({ meeting_id: m.id, person_id: person.id }, { onConflict: "meeting_id,person_id", ignoreDuplicates: true }).select("person_id"),
  ) as unknown[];
  if (!ledger.length) return "done";
  const [mt, o, who] = [m, org, person];
  try {
    return await mailOne();
  } catch (e) {
    // Nothing was handed to the provider: the ledger row goes again, so the retry can claim it.
    await db.from("meeting_summary_sends").delete().eq("meeting_id", mt.id).eq("person_id", who.id).is("sent", null);
    throw e;
  }

  async function mailOne(): Promise<Outcome> {
  const m = mt;
  const org = o;
  const person = who;
  const locale = userId ? ((await localesForUsers([userId], db)).get(userId) ?? defaultLocale) : await localeForEmail(email, db);
  const origin = appOrigin();
  const shared = new Set((must("shares", shares) as { user_id: string }[]).map((s) => s.user_id));
  const starterName = people.find((p) => m.started_by && p.member_user_id === m.started_by)?.name ?? null;
  const access = accessFor({ userId }, m, shared, origin, starterName, locale);
  const mail = renderSummaryEmail({
    locale,
    orgName: org.name,
    startedAt: m.started_at,
    recipientName: person.name,
    missed,
    content: summaryContent(must("items", items) as SummaryItem[], {
      agendaRoles: m.agenda_roles,
      people,
      forPerson: person,
      today: stockholmDay(deps.now()),
      requireFields: taskMode(org) === "require",
    }),
    buttonHref: access.href,
    accessNote: access.note,
    settingsHref: member?.role === "admin" ? `${origin}/orgs/${m.org_id}/installningar#sammanfattning` : null,
    unsubscribeHref: emailPrefsUrl(email, "meeting_summary", origin),
  });
  const result = await sendUserMailDetailed(
    deps.mailer,
    { userId, email },
    "meeting_summary",
    { subject: mail.subject, text: mail.text, html: mail.html, headers: listUnsubscribeHeaders(email, "meeting_summary", origin), idempotencyKey: `sum-${m.id}-${person.id}` },
    db,
  );
  const ok = result === "sent";
  must("record", await db.from("meeting_summary_sends").update({ sent: ok }).eq("meeting_id", m.id).eq("person_id", person.id));
  return ok ? "sent" : "done";
  }
}
