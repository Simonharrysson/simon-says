import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseMeetingEvent } from "@/lib/calendar/events";
import { logEvent } from "@/lib/db/events";
import { orgMemberList } from "@/lib/db/members";
import type { ItemRole, SummaryMode } from "@/lib/db/types";
import { e2eMode } from "@/lib/e2e/guard";
import { checkEmailGate, sendUserMailDetailed } from "@/lib/email/prefs";
import { emailPrefsUrl, listUnsubscribeHeaders } from "@/lib/email/token";
import { localeForEmail } from "@/lib/i18n/user-locale";
import type { Mailer } from "@/lib/mail";
import { meetingTitle } from "@/lib/meetings/title";
import { stockholmDay, taskMode } from "@/lib/notes/tasks";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { summaryContent, type SummaryItem } from "@/lib/summaries/content";
import { sendSummaryFallbacks } from "@/lib/summaries/fallback";
import type { SummaryMember, SummaryPerson, SummarySpeaker } from "@/lib/summaries/recipients";
import { inviteFromName, renderInviteEmail } from "./email";
import { REMINDER_AFTER_MS, REMINDER_UNTIL_MS, addressPaused, inviteRecipients, namedPeople, reminderHour } from "./recipients";
import { inviteToken } from "./token";

// The growth loop's sender (0067). Two steps, so the summary flow stays the one place that decides
// who gets what after a meeting:
// 1. queueMeetingInvites(): from sendMeetingSummaries, once it knows the meeting has notes and the
//    förening mails at all. The invite list is computed and written as `queued` ledger rows (one
//    per meeting and address) BEFORE anything is sent; the summary list is then reduced by every
//    invited address (inviteAddresses), on every run, so nobody gets both.
// 2. sendQueuedInvites(): right after the summaries (trySendMeetingSummaries) and from the cron.
//    Each row is claimed (`queued` → `sending`) before the mailer is called, with a Resend
//    Idempotency-Key, so a resumed or second run never mails anyone twice.
// Plus the one reminder (sendInviteReminders, the cron) and retention (cleanup_growth_loop).
// Logs and events hold counts only: no addresses, names or note text.

export interface InviteDeps {
  mailer: Mailer;
  now(): Date;
  sleep?(ms: number): Promise<void>;
}

/** Between two e-mails (Resend's rate limit), as the summaries. */
const SEND_GAP_MS = 600;
/** Queued rows older than this are not sent any more (a meeting from long ago). */
const QUEUE_WINDOW_MS = 48 * 3600_000;

function must<T>(what: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`invites: ${what}: ${res.error.message}`);
  return res.data;
}

const lower = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/** Lower-cased addresses of these that belong to an account. */
async function accountEmails(db: SupabaseClient, emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const rows = must("accounts", await db.rpc("emails_with_account", { p_emails: emails.map(lower) })) as unknown;
  return new Set(((rows as (string | { emails_with_account: string })[]) ?? []).map((r) => (typeof r === "string" ? r : r.emails_with_account)));
}

export interface QueueInput {
  meeting: { id: string; org_id: string; started_by: string | null; private?: boolean | null; is_test: boolean | null };
  org: { kind?: string; groups_enabled?: boolean | null };
  mode: SummaryMode;
  people: SummaryPerson[];
  speakers: SummarySpeaker[];
  expected: string[];
  members: SummaryMember[];
}

/**
 * Write the invite list as `queued` rows. Best effort and idempotent (unique per meeting and
 * address); never throws: without it the summary flow runs as before.
 */
export async function queueMeetingInvites(input: QueueInput): Promise<void> {
  const { meeting: m } = input;
  // Företag: no invites in v1 (the DPA gate). Never a Privat space, a Testmöte, a private meeting,
  // or a förening that mails nobody after meetings.
  if (input.org.kind !== "forening" || m.is_test || m.private || input.mode === "off") return;
  const db = supabaseAdmin();
  try {
    const [orgRow, meetingRow, guestRows] = await Promise.all([
      db.from("orgs").select("invite_attendees").eq("id", m.org_id).maybeSingle(),
      db.from("meetings").select("invite_attendees").eq("id", m.id).maybeSingle(),
      db.from("meeting_calendar_guests").select("email, name, response").eq("meeting_id", m.id),
    ]);
    const orgOn = (must("org", orgRow) as { invite_attendees?: boolean } | null)?.invite_attendees !== false;
    const meetingOn = (must("meeting", meetingRow) as { invite_attendees?: boolean } | null)?.invite_attendees !== false;
    if (!orgOn || !meetingOn) {
      await logEvent(m.id, "invites", { state: "off", queued: 0 });
      return;
    }
    const guests = must("guests", guestRows) as { email: string; name: string | null; response: string | null }[];
    const named = namedPeople(input.speakers);
    const candidates = new Set([...input.expected, ...named]);
    const candidateEmails = [
      ...input.people.filter((p) => candidates.has(p.id) && p.email).map((p) => p.email!),
      ...guests.map((g) => g.email),
    ];
    const accounts = await accountEmails(db, candidateEmails);
    // A förening with groups: only people who will see this meeting once linked (the tree rule).
    let allowed: Set<string> | null = null;
    if (input.org.groups_enabled) {
      allowed = new Set();
      for (const p of input.people) {
        if (!candidates.has(p.id) || p.member_user_id || !p.email) continue;
        const ok = must("tree", await db.rpc("person_may_see_meeting", { p_person_id: p.id, p_meeting_id: m.id })) as unknown;
        if (ok === true) allowed.add(p.id);
      }
    }
    const starterEmail = input.members.find((x) => x.userId === m.started_by)?.email ?? null;
    const plan = inviteRecipients({
      people: input.people,
      expected: input.expected,
      guests,
      named,
      accountEmails: accounts,
      starterEmail,
      startedBy: m.started_by,
      allowed,
    });
    if (plan.invites.length) {
      must(
        "queue",
        await db.from("meeting_invites").upsert(
          plan.invites.map((r) => ({ meeting_id: m.id, org_id: m.org_id, person_id: r.personId, email: r.email, name: r.name, source: r.source, status: "queued" })),
          { onConflict: "meeting_id,email", ignoreDuplicates: true },
        ),
      );
      // Decided now, before the summary list is reduced: an address that said no to these mails,
      // or that a cap holds back, is `skipped` at once and keeps its summary as before.
      const queued = must("queued", await db.from("meeting_invites").select("id, org_id, email").eq("meeting_id", m.id).eq("status", "queued")) as {
        id: string;
        org_id: string;
        email: string | null;
      }[];
      for (const row of queued) {
        const reason = await heldBack(db, row, new Date());
        if (reason) must("skip", await db.from("meeting_invites").update({ status: "skipped", skip_reason: reason }).eq("id", row.id).eq("status", "queued"));
      }
    }
    await logEvent(m.id, "invites", {
      state: "queued",
      queued: plan.invites.length,
      ...(plan.withoutEmail ? { withoutEmail: plan.withoutEmail } : {}),
      ...(plan.withAccount ? { withAccount: plan.withAccount } : {}),
      ...(plan.notAllowed ? { notAllowed: plan.notAllowed } : {}),
      ...(plan.capped ? { capped: plan.capped } : {}),
    });
  } catch (e) {
    console.error(`invites ${m.id}: queue failed: ${(e as Error).message}`.slice(0, 300));
  }
}

/** Invites that are, or may be, on their way: these addresses get the invite, not the summary. */
export const ACTIVE_INVITE = ["queued", "sending", "sent", "uncertain"] as const;

/**
 * Why an invite to this address won't go out (the gate said no, or a cap), or null. "unknown" from
 * the gate is not a no: the send re-checks.
 */
async function heldBack(db: SupabaseClient, row: { id: string; org_id: string; email: string | null }, now: Date): Promise<string | null> {
  if (!row.email) return "no_email";
  const gate = await checkEmailGate({ userId: null, email: row.email }, "meeting_invite", db);
  if (gate === "opted_out" || gate === "invalid") return gate;
  const earlier = must(
    "earlier",
    await db.from("meeting_invites").select("sent_at, clicked_at, clicked_human_at, claimed_at").eq("org_id", row.org_id).eq("email", row.email).neq("id", row.id).not("sent_at", "is", null).order("sent_at", { ascending: false }).limit(5),
  ) as { sent_at: string | null; clicked_at: string | null; clicked_human_at: string | null; claimed_at: string | null }[];
  return addressPaused(earlier, now);
}

/**
 * Every address this meeting invites and hasn't given up on: never also in its summary list. A
 * skipped (opted out, capped) or failed invite leaves the person's summary as it was.
 */
export async function inviteAddresses(meetingId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin().from("meeting_invites").select("email").eq("meeting_id", meetingId).in("status", [...ACTIVE_INVITE]);
  if (error) {
    console.error(`invites ${meetingId}: addresses: ${error.message}`);
    return new Set();
  }
  return new Set(((data ?? []) as { email: string | null }[]).map((r) => lower(r.email)).filter(Boolean));
}

// ---------------------------------------------------------------------------------------------
// Sending

interface InviteRow {
  id: string;
  meeting_id: string;
  org_id: string;
  person_id: string | null;
  email: string | null;
  name: string | null;
  source: "calendar" | "name_round" | "both";
  status: string;
  sent_at: string | null;
}

interface MeetingContext {
  ok: boolean;
  orgName: string;
  starterName: string;
  title: string | null;
  startedAt: string;
  items: SummaryItem[];
  agendaRoles: Record<string, ItemRole> | null;
  people: { id: string; name: string; role?: string | null }[];
  requireFields: boolean;
}

async function meetingContext(db: SupabaseClient, meetingId: string): Promise<MeetingContext | null> {
  const m = must(
    "meeting",
    await db.from("meetings").select("id, org_id, status, started_at, started_by, private, is_test, invite_attendees, title, calendar_event, agenda_labels, agenda_roles").eq("id", meetingId).maybeSingle(),
  ) as {
    id: string;
    org_id: string;
    status: string;
    started_at: string;
    started_by: string | null;
    private: boolean | null;
    is_test: boolean | null;
    invite_attendees: boolean | null;
    title: string | null;
    calendar_event: unknown;
    agenda_labels: Record<string, string> | null;
    agenda_roles: Record<string, ItemRole> | null;
  } | null;
  if (!m) return null;
  const org = must("org", await db.from("orgs").select("*").eq("id", m.org_id).maybeSingle()) as {
    name: string;
    kind?: string;
    invite_attendees?: boolean;
    summary_mode?: SummaryMode | null;
    require_task_fields?: boolean;
  } | null;
  const ok = Boolean(org && org.kind === "forening" && !m.private && !m.is_test && m.invite_attendees !== false && org.invite_attendees !== false && org.summary_mode !== "off");
  const [items, people, members] = await Promise.all([
    db
      .from("note_items")
      .select("meeting_id, id, section, kind, text, owner, due, position, done, deleted_by_human, copy_of, anchor, owner_person_id, carried_from_meeting, carried_from_id, done_when, due_date, locked")
      .eq("meeting_id", m.id),
    db.from("people").select("id, name, role, member_user_id").eq("org_id", m.org_id),
    orgMemberList(m.org_id),
  ]);
  const peopleRows = must("people", people) as { id: string; name: string; role: string | null; member_user_id: string | null }[];
  const starterEmail = members.find((x) => x.userId === m.started_by)?.email ?? "";
  const starterName = peopleRows.find((p) => m.started_by && p.member_user_id === m.started_by)?.name ?? (starterEmail.split("@")[0] || "Simon Says");
  const event = parseMeetingEvent(m.calendar_event);
  return {
    ok,
    orgName: org?.name ?? "",
    starterName,
    // The calendar's title first (the förening named it), else the notes' title; null: "Mötet 24 november".
    title: event?.title || meetingTitle(m, "och"),
    startedAt: m.started_at,
    items: must("items", items) as SummaryItem[],
    agendaRoles: m.agenda_roles,
    people: peopleRows,
    requireFields: taskMode(org) === "require",
  };
}

/** The mail for one row (the invite, or the reminder). */
function compose(row: InviteRow, ctx: MeetingContext, now: Date, locale: Parameters<typeof renderInviteEmail>[0]["locale"], reminder: boolean) {
  const origin = appOrigin();
  const email = row.email!;
  const token = inviteToken(row.id, email);
  // A calendar guest outside the list may still own a task by name: a stand-in person for the match.
  const me = row.person_id ? { id: row.person_id } : { id: `guest:${row.id}` };
  const people = row.person_id || !row.name ? ctx.people : [...ctx.people, { id: me.id, name: row.name }];
  const content = summaryContent(ctx.items, { agendaRoles: ctx.agendaRoles, people, forPerson: me, today: stockholmDay(now), requireFields: ctx.requireFields });
  const all = summaryContent(ctx.items, { agendaRoles: ctx.agendaRoles, people, today: stockholmDay(now) });
  return renderInviteEmail({
    locale,
    orgName: ctx.orgName,
    starterName: ctx.starterName,
    title: ctx.title,
    startedAt: ctx.startedAt,
    recipientName: row.name,
    mine: content.tasks.filter((x) => x.mine),
    decisions: all.decisions,
    counts: { decisions: all.decisions.length + all.more.decisions, tasks: all.tasks.length + all.more.tasks },
    named: row.source !== "calendar",
    reason: row.source === "calendar" ? "guest" : "attended",
    claimHref: `${origin}/r/${token}`,
    upsellHref: `${origin}/r/${token}?till=eget`,
    unsubscribeHref: emailPrefsUrl(email, "meeting_invite", origin),
    reminder,
  });
}

type Outcome = "sent" | "failed" | "uncertain" | "skipped";

/** Gate, account and caps re-checked; then the send. */
async function deliver(
  db: SupabaseClient,
  row: InviteRow,
  ctx: MeetingContext,
  deps: InviteDeps,
  reminder: boolean,
): Promise<{ outcome: Outcome; reason?: string }> {
  const email = row.email;
  if (!email || !ctx.ok) return { outcome: "skipped", reason: !email ? "no_email" : "off" };
  if ((await accountEmails(db, [email])).has(email)) return { outcome: "skipped", reason: "account" };
  if (!reminder) {
    const paused = await heldBack(db, row, deps.now());
    if (paused) return { outcome: "skipped", reason: paused };
  }
  const locale = await localeForEmail(email, db);
  const mail = compose(row, ctx, deps.now(), locale, reminder);
  const origin = appOrigin();
  const result = await sendUserMailDetailed(
    deps.mailer,
    { userId: null, email },
    "meeting_invite",
    {
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: listUnsubscribeHeaders(email, "meeting_invite", origin),
      idempotencyKey: reminder ? `inv-${row.id}-r` : `inv-${row.id}`,
      fromName: inviteFromName({ starterName: ctx.starterName, locale }),
    },
    db,
  );
  if (result === "opted_out" || result === "invalid") return { outcome: "skipped", reason: result };
  return { outcome: result === "sent" ? "sent" : result === "uncertain" ? "uncertain" : "failed" };
}

/**
 * Send the `queued` invites (one meeting, or every meeting's from the last 48 h). Returns how many
 * went out. Never throws per row: a failure is recorded on the row and not retried (at most once).
 */
export async function sendQueuedInvites(deps: InviteDeps, opts: { meetingId?: string; orgId?: string; left?: () => boolean } = {}): Promise<number> {
  const db = supabaseAdmin();
  const since = new Date(deps.now().getTime() - QUEUE_WINDOW_MS).toISOString();
  let query = db.from("meeting_invites").select("id, meeting_id, org_id, person_id, email, name, source, status, sent_at").eq("status", "queued").gte("created_at", since).order("created_at").limit(100);
  if (opts.meetingId) query = query.eq("meeting_id", opts.meetingId);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  const rows = must("queued", await query) as InviteRow[];
  const contexts = new Map<string, MeetingContext | null>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const counts = new Map<string, Record<string, number>>();
  let sent = 0;
  let mailed = false;
  for (const row of rows) {
    if (opts.left && !opts.left()) break;
    // The claim: only one sender mails this row.
    const claimed = must("claim", await db.from("meeting_invites").update({ status: "sending" }).eq("id", row.id).eq("status", "queued").select("id")) as unknown[];
    if (!claimed.length) continue;
    let outcome: { outcome: Outcome; reason?: string };
    try {
      if (!contexts.has(row.meeting_id)) contexts.set(row.meeting_id, await meetingContext(db, row.meeting_id));
      const ctx = contexts.get(row.meeting_id);
      if (!ctx) outcome = { outcome: "skipped", reason: "gone" };
      else {
        if (mailed) await sleep(SEND_GAP_MS);
        outcome = await deliver(db, row, ctx, deps, false);
        if (outcome.outcome !== "skipped") mailed = true;
      }
    } catch (e) {
      console.error(`invites ${row.meeting_id}: send failed: ${(e as Error).message}`.slice(0, 300));
      outcome = { outcome: "failed" };
    }
    const now = deps.now().toISOString();
    must(
      "record",
      await db
        .from("meeting_invites")
        .update(
          outcome.outcome === "skipped"
            ? { status: "skipped", skip_reason: outcome.reason ?? null }
            : { status: outcome.outcome, ...(outcome.outcome === "sent" || outcome.outcome === "uncertain" ? { sent_at: now } : {}) },
        )
        .eq("id", row.id),
    );
    if (outcome.outcome === "sent") sent++;
    const c = counts.get(row.meeting_id) ?? {};
    const key = outcome.outcome === "skipped" ? `skipped_${outcome.reason ?? "other"}` : outcome.outcome;
    c[key] = (c[key] ?? 0) + 1;
    counts.set(row.meeting_id, c);
  }
  for (const [meetingId, c] of counts) await logEvent(meetingId, "invites", { state: "sent", ...c }).catch(() => {});
  return sent;
}

/**
 * The one reminder: invites sent 48–96 h ago that nobody clicked (a browser on our landing) or
 * claimed, between 08 and 20 Stockholm time (any time in the e2e mode, whose clock is the CI's).
 */
export async function sendInviteReminders(deps: InviteDeps, opts: { orgId?: string; left?: () => boolean } = {}): Promise<number> {
  const now = deps.now();
  if (!reminderHour(now) && !e2eMode()) return 0;
  const db = supabaseAdmin();
  let query = db
    .from("meeting_invites")
    .select("id, meeting_id, org_id, person_id, email, name, source, status, sent_at")
    .eq("status", "sent")
    .is("reminder_status", null)
    .is("claimed_at", null)
    .is("clicked_human_at", null)
    .lte("sent_at", new Date(now.getTime() - REMINDER_AFTER_MS).toISOString())
    .gt("sent_at", new Date(now.getTime() - REMINDER_UNTIL_MS).toISOString())
    .order("sent_at")
    .limit(100);
  if (opts.orgId) query = query.eq("org_id", opts.orgId);
  const rows = must("reminders", await query) as InviteRow[];
  const contexts = new Map<string, MeetingContext | null>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let sent = 0;
  let mailed = false;
  for (const row of rows) {
    if (opts.left && !opts.left()) break;
    const claimed = must(
      "reminder claim",
      await db.from("meeting_invites").update({ reminder_status: "sending" }).eq("id", row.id).is("reminder_status", null).is("claimed_at", null).select("id"),
    ) as unknown[];
    if (!claimed.length) continue;
    let outcome: { outcome: Outcome; reason?: string };
    try {
      if (!contexts.has(row.meeting_id)) contexts.set(row.meeting_id, await meetingContext(db, row.meeting_id));
      const ctx = contexts.get(row.meeting_id);
      if (!ctx) outcome = { outcome: "skipped", reason: "gone" };
      else {
        if (mailed) await sleep(SEND_GAP_MS);
        outcome = await deliver(db, row, ctx, deps, true);
        if (outcome.outcome !== "skipped") mailed = true;
      }
    } catch (e) {
      console.error(`invites ${row.meeting_id}: reminder failed: ${(e as Error).message}`.slice(0, 300));
      outcome = { outcome: "failed" };
    }
    must(
      "reminder record",
      await db
        .from("meeting_invites")
        .update({ reminder_status: outcome.outcome, reminder_at: deps.now().toISOString() })
        .eq("id", row.id),
    );
    if (outcome.outcome === "sent") sent++;
  }
  return sent;
}

/** Queued invites older than the window are never sent late: `skipped` (expired), so the fallback runs. */
async function expireQueued(deps: InviteDeps, orgId?: string): Promise<void> {
  const since = new Date(deps.now().getTime() - QUEUE_WINDOW_MS).toISOString();
  let query = supabaseAdmin().from("meeting_invites").update({ status: "skipped", skip_reason: "expired" }).eq("status", "queued").lt("created_at", since);
  if (orgId) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) console.error(`invites: expire: ${error.message}`);
}

/** The cron's step: queued invites, expired ones, summary fallbacks, reminders, retention. Never throws. */
export async function sendPendingInvites(deps: InviteDeps, opts: { orgId?: string; left?: () => boolean } = {}): Promise<number> {
  let n = 0;
  try {
    n += await sendQueuedInvites(deps, opts);
  } catch (e) {
    console.error(`invites: queued: ${(e as Error).message}`.slice(0, 300));
  }
  await expireQueued(deps, opts.orgId);
  try {
    await sendSummaryFallbacks(deps, { orgId: opts.orgId });
  } catch (e) {
    console.error(`invites: fallbacks: ${(e as Error).message}`.slice(0, 300));
  }
  try {
    n += await sendInviteReminders(deps, opts);
  } catch (e) {
    console.error(`invites: reminders: ${(e as Error).message}`.slice(0, 300));
  }
  try {
    const { error } = await supabaseAdmin().rpc("cleanup_growth_loop");
    if (error) console.error(`invites: retention: ${error.message}`);
  } catch (e) {
    console.error(`invites: retention: ${(e as Error).message}`.slice(0, 300));
  }
  return n;
}

/** Right after a meeting's summaries: its queued invites. Never throws. */
export async function trySendMeetingInvites(meetingId: string, deps: InviteDeps): Promise<number> {
  let n = 0;
  try {
    n = await sendQueuedInvites(deps, { meetingId });
  } catch (e) {
    console.error(`invites ${meetingId}: ${(e as Error).message}`.slice(0, 300));
  }
  // Whoever lost their summary to an invite that didn't go out gets the summary now.
  try {
    await sendSummaryFallbacks(deps, { meetingId });
  } catch (e) {
    console.error(`invites ${meetingId}: fallbacks: ${(e as Error).message}`.slice(0, 300));
  }
  return n;
}
