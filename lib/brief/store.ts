import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stockholmDateTime } from "@/lib/calendar/events";
import { userCalendarApi } from "@/lib/calendar/load";
import { orgMemberList } from "@/lib/db/members";
import { checkEmailGate, sendUserMailDetailed } from "@/lib/email/prefs";
import { emailPrefsUrl, listUnsubscribeHeaders } from "@/lib/email/token";
import { ownDomains } from "@/lib/foretag/customers";
import type { HomeMeeting, HomeNoteRow, HomePerson } from "@/lib/home/tasks";
import { isLocale } from "@/lib/i18n/config";
import { defaultMailer, type Mailer } from "@/lib/mail";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { docUrl } from "@/lib/ui/meetings";
import { agendaLabels, BRIEF_MEETINGS, pickAgenda } from "./content";
import { claudePicker, type PickFn } from "./pick";
import { briefsForUser, type BriefDeps, type BriefHistory, type BriefScope, type BriefSpace, type BriefUser } from "./run";

// Inför möten (0059) against the real services: the database (service role, so every read is
// narrowed to the recipient by hand: their memberships, and visible_meeting_ids (0054), the
// RLS predicate), the user's own calendar grant, Claude (pick only) and the mail gate.

/** Earlier meeting ids read per scope before the visibility filter. */
const READ_MEETINGS = 500;
/** A claim's lease: longer than the cron's maxDuration, so only a dead run's claim runs out. */
export const CLAIM_LEASE_SECONDS = 120;
/** Sent-log rows older than this are deleted. */
export const SENDS_KEEP_DAYS = 30;

function must<T>(what: string, r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(`brief: ${what}: ${r.error.message}`);
  return r.data;
}

/** The accounts with a calendar grant (the only ones a brief can be for). */
export async function calendarUserIds(db: SupabaseClient = supabaseAdmin()): Promise<string[]> {
  const rows = must("calendar users", await db.from("google_calendar_tokens").select("user_id").order("created_at")) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/** One user's spaces, language, opt-in, address and name. Null when the account is gone. */
export async function loadBriefUser(userId: string, db: SupabaseClient = supabaseAdmin()): Promise<BriefUser | null> {
  const { data: auth } = await db.auth.admin.getUserById(userId);
  const u = auth?.user;
  if (!u) return null;
  const [members, settings, listed] = await Promise.all([
    db.from("org_members").select("org_id").eq("user_id", userId),
    db.from("user_settings").select("*").eq("user_id", userId).maybeSingle(),
    db.from("people").select("email").eq("member_user_id", userId),
  ]);
  const orgIds = (must("members", members) as { org_id: string }[]).map((m) => m.org_id);
  const orgs = orgIds.length
    ? (must("orgs", await db.from("orgs").select("id, name, kind, calendar_id, calendar_filter").in("id", orgIds)) as {
        id: string;
        name: string;
        kind: string | null;
        calendar_id: string | null;
        calendar_filter: string | null;
      }[])
    : [];
  const s = (settings.data ?? {}) as { locale?: unknown; brief_foreningar?: unknown };
  const meta = (u.user_metadata ?? {}) as { full_name?: unknown; name?: unknown };
  const name = typeof meta.full_name === "string" ? meta.full_name : typeof meta.name === "string" ? meta.name : null;
  return {
    id: userId,
    email: u.email_confirmed_at && u.email ? u.email : null,
    emails: [...new Set(((listed.data ?? []) as { email: string | null }[]).flatMap((p) => (p.email?.includes("@") ? [p.email.trim().toLowerCase()] : [])))],
    name,
    locale: isLocale(s.locale) ? s.locale : "sv",
    briefForeningar: s.brief_foreningar === true,
    spaces: orgs
      .map(
        (o): BriefSpace => ({
          id: o.id,
          name: o.name,
          kind: o.kind === "foretag" ? "foretag" : o.kind === "privat" ? "privat" : "forening",
          calendarId: o.calendar_id,
          calendarFilter: o.calendar_filter,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "sv") || a.id.localeCompare(b.id)),
  };
}

/**
 * What the user may know about a scope: its finished real meetings the USER can see (the RLS
 * predicate, visible_meeting_ids), their decision and task rows, the org's people, and (a
 * group's meeting) the agenda prepared for that day. A Företag's own calendar covers its internal
 * meetings; a customer covers the meetings with that customer.
 */
export async function loadBriefHistory(user: BriefUser, scope: BriefScope, startsAt: string, db: SupabaseClient = supabaseAdmin()): Promise<BriefHistory> {
  const orgId = scope.org.id;
  // Ids first (many), then the visibility filter, then the newest visible rows in full: a member
  // deep in a busy company still finds their own meetings among the company's.
  let q = db.from("meetings").select("id").eq("org_id", orgId).eq("status", "done").eq("is_test", false);
  if (scope.kind === "customer") q = q.eq("context_id", scope.customer.id);
  else if (scope.org.kind === "foretag") q = q.is("context_id", null);
  const candidates = (must("meetings", await q.order("started_at", { ascending: false }).limit(READ_MEETINGS)) as { id: string }[]).map((m) => m.id);
  const visibleIds = candidates.length
    ? new Set(must("visible", await db.rpc("visible_meeting_ids", { p_user: user.id, p_ids: candidates })) as string[])
    : new Set<string>();
  const keep = candidates.filter((id) => visibleIds.has(id)).slice(0, BRIEF_MEETINGS);
  const meetings = keep.length
    ? (must("visible meetings", await db.from("meetings").select("*").in("id", keep)) as HomeMeeting[]).sort((a, b) => b.started_at.localeCompare(a.started_at))
    : [];
  const ids = meetings.map((m) => m.id);
  const [rows, people, agenda] = await Promise.all([
    ids.length
      ? db.from("note_items").select("*").in("meeting_id", ids).in("section", ["action", "decision"])
      : Promise.resolve({ data: [], error: null }),
    db.from("people").select("id, org_id, name, role, member_user_id").eq("org_id", orgId),
    scope.kind === "org"
      ? db.from("prepared_agendas").select("doc_id, items, meeting_time").eq("org_id", orgId).eq("meeting_date", stockholmDateTime(startsAt).date)
      : Promise.resolve({ data: [], error: null }),
  ]);
  // 0068: the meetings whose transcript the recipient may read (their decisions show "▶ 41:52").
  const transcriptMeetings = ids.length ? ((must("transcripts", await db.rpc("transcript_visible_ids", { p_user: user.id, p_ids: ids })) ?? []) as string[]) : [];
  const a = pickAgenda((must("agenda", agenda) ?? []) as { doc_id: string; items: unknown; meeting_time: string | null }[], stockholmDateTime(startsAt).time);
  const labels = a ? agendaLabels(a.items) : [];
  return {
    meetings,
    rows: must("rows", rows) as HomeNoteRow[],
    people: must("people", people) as HomePerson[],
    agenda: a && labels.length ? { labels, href: docUrl(a.doc_id) } : null,
    transcriptMeetings,
  };
}

export function briefDeps(opts: { now?: () => Date; mailer?: Mailer; pick?: PickFn; db?: SupabaseClient } = {}): BriefDeps {
  const db = opts.db ?? supabaseAdmin();
  const mailer = opts.mailer ?? defaultMailer();
  const origin = appOrigin();
  const domains = new Map<string, Promise<string[]>>();
  return {
    now: opts.now ?? (() => new Date()),
    gate: (user) => checkEmailGate({ userId: user.id, email: user.email }, "meeting_brief", db),
    calendar: (userId) => userCalendarApi(userId, 4000),
    ownDomains: (orgId) => {
      if (!domains.has(orgId)) domains.set(orgId, orgMemberList(orgId).then((ms) => ownDomains(ms.map((m) => m.email))));
      return domains.get(orgId)!;
    },
    async customerByDomain(orgId, domain) {
      const row = must("customer", await db.from("contexts").select("id, name").eq("org_id", orgId).eq("domain", domain).maybeSingle()) as { id: string; name: string } | null;
      return row;
    },
    async sentKeys(userId, keys) {
      const rows = must(
        "sent",
        await db.from("meeting_brief_sends").select("event_key, state, lease_until, attempts").eq("user_id", userId).in("event_key", keys),
      ) as { event_key: string; state: string; lease_until: string | null; attempts: number }[];
      // A claim whose lease ran out (its run died) is open again, up to 3 attempts.
      const nowMs = Date.now();
      const open = (r: (typeof rows)[number]) => r.state === "claimed" && r.attempts < 3 && (!r.lease_until || Date.parse(r.lease_until) < nowMs);
      return new Set(rows.filter((r) => !open(r)).map((r) => r.event_key));
    },
    async claim(userId, key, startsAt, scope) {
      const { data, error } = await db.rpc("claim_meeting_brief", {
        p_user: userId,
        p_key: key,
        p_start: startsAt,
        p_scope: scope,
        p_lease_seconds: CLAIM_LEASE_SECONDS,
      });
      if (error) throw new Error(`brief: claim: ${error.message}`);
      return data === true;
    },
    async finish(userId, key, state, picked) {
      const { error } = await db.from("meeting_brief_sends").update({ state, picked, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("event_key", key);
      if (error) console.error(`brief: finish: ${error.message}`.slice(0, 200));
    },
    history: (user, scope, startsAt) => loadBriefHistory(user, scope, startsAt, db),
    pick: opts.pick ?? claudePicker(),
    deliver: (user, mail) =>
      sendUserMailDetailed(
        mailer,
        { userId: user.id, email: user.email },
        "meeting_brief",
        { subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: mail.idempotencyKey, headers: listUnsubscribeHeaders(user.email, "meeting_brief", origin) },
        db,
      ),
    origin,
    unsubscribeHref: (email) => emailPrefsUrl(email, "meeting_brief", origin),
  };
}

/** The accounts with a calendar grant, the one the cron looked at longest ago (or never) first. */
export async function usersByLastCheck(db: SupabaseClient = supabaseAdmin()): Promise<string[]> {
  const ids = await calendarUserIds(db);
  if (!ids.length) return [];
  const checks = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = must("checks", await db.from("meeting_brief_checks").select("user_id, checked_at").in("user_id", ids.slice(i, i + 200))) as { user_id: string; checked_at: string }[];
    for (const r of rows) checks.set(r.user_id, r.checked_at);
  }
  // Never checked (""): first. Then oldest check. Stable on ties (the tokens' order).
  return ids.map((id, i) => ({ id, i, at: checks.get(id) ?? "" })).sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i).map((x) => x.id);
}

export interface BriefRunResult {
  users: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Users not reached before the time budget ran out (next run). */
  left: number;
}

/** The cron's run: every user with a calendar grant, within `budgetMs`. Counts only. */
export async function runBriefs(opts: { budgetMs?: number; deps?: BriefDeps; db?: SupabaseClient } = {}): Promise<BriefRunResult> {
  const db = opts.db ?? supabaseAdmin();
  const deps = opts.deps ?? briefDeps({ db });
  const started = Date.now();
  const out: BriefRunResult = { users: 0, sent: 0, skipped: 0, failed: 0, left: 0 };
  // Longest-waiting first (meeting_brief_checks), so a list longer than one run's budget never
  // starves anyone: whoever was left out goes first next time.
  const ids = await usersByLastCheck(db);
  for (let i = 0; i < ids.length; i++) {
    if (Date.now() - started > (opts.budgetMs ?? 25_000)) {
      out.left = ids.length - i;
      break;
    }
    out.users++;
    // Marked before the work: a user whose brief keeps failing never blocks the queue's front.
    const { error: checkError } = await db.from("meeting_brief_checks").upsert({ user_id: ids[i], checked_at: new Date().toISOString() });
    if (checkError) console.error(`brief: check: ${checkError.message}`.slice(0, 200));
    try {
      const user = await loadBriefUser(ids[i], db);
      if (!user) continue;
      const r = await briefsForUser(user, deps);
      out.sent += r.sent;
      out.skipped += r.skipped;
      out.failed += r.failed;
    } catch (err) {
      out.failed++;
      console.error(`brief: user failed: ${(err as Error).message}`.slice(0, 200));
    }
  }
  const cutoff = new Date(Date.now() - SENDS_KEEP_DAYS * 86_400_000).toISOString();
  const { error } = await db.from("meeting_brief_sends").delete().lt("created_at", cutoff);
  if (error) console.error(`brief: cleanup: ${error.message}`.slice(0, 200));
  return out;
}
