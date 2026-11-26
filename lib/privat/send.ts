import "server-only";
import { logEvent } from "@/lib/db/events";
import type { NoteItemRow, SummaryState } from "@/lib/db/types";
import { sendUserMail } from "@/lib/email/prefs";
import { emailPrefsUrl, listUnsubscribeHeaders } from "@/lib/email/token";
import type { Mailer } from "@/lib/mail";
import { claudeAllowed } from "@/lib/notes/oneshot";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { renderPrivatEmail } from "./email";
import type { PrivatLocale } from "./format";
import { doneTaskIds, sinceLast, taskKeys, type OpenTask, type SinceLastItem } from "./since-last";
import { summarizePrivat, type PrivatSummaryAnswer, type SummarizeFn } from "./summary";

// After a Privat recording is done: one Claude summary, stored (private_summaries + the context's
// tasks, "Sedan sist" ticks), then one e-mail to the recorder through the e-mail gate (category
// private_summary). Called from lib/summaries/send.ts for meetings of a Privat space, so the end
// hook and the 5-minute cron reach it exactly like the förening summary.
//
// Never twice, never paying twice:
// - the meeting is claimed first (summary_state null → sending; 0037);
// - the summary row is written once (save_private_summary: a second write changes nothing), and a
//   resumed run with a stored summary never calls Claude again;
// - the Claude call is counted (summary_attempts) before it is made: at most 3, then 'failed';
//   a spend stop (KILL_SWITCH, daily cap) is not an attempt: the meeting waits for the cron;
// - the mail is claimed (mail_claimed_at) before the mailer is called.
// Logs and events hold counts only, never content or addresses.

export interface PrivatSummaryDeps {
  mailer: Mailer;
  now(): Date;
  summarize?: SummarizeFn;
}

export const MAX_SUMMARY_ATTEMPTS = 3;
/** Don't start the Claude call with less time than this before the caller's deadline. */
const MIN_CALL_MS = 40_000;
const CALL_TIMEOUT_MS = 90_000;
/** Open tasks and earlier decisions given to Claude, at most. */
const MAX_OPEN_TASKS = 30;
const RECENT_SUMMARIES = 3;

function must<T>(what: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`privat summary: ${what}: ${res.error.message}`);
  return res.data;
}

interface MeetingForPrivat {
  id: string;
  org_id: string;
  status: string;
  is_test: boolean | null;
  started_at: string;
  started_by: string | null;
  context_id: string | null;
  summary_state: SummaryState | null;
  summary_attempts: number | null;
}

/** The live notes as lines for the prompt. */
export function notesLines(rows: Pick<NoteItemRow, "section" | "text" | "owner" | "due" | "deleted_by_human">[]): string[] {
  const label: Record<string, string> = { decision: "Decision", action: "Task", note: "Note", now: "Current topic", attendees: "Present" };
  return rows
    .filter((r) => !r.deleted_by_human && r.text.trim())
    .map((r) => `${label[r.section] ?? r.section}${r.owner ? ` (${r.owner})` : ""}: ${r.text}${r.due ? ` (${r.due})` : ""}`);
}

/** The user's language for e-mail: user_settings (0043) when there, else Swedish. */
async function userLocale(userId: string): Promise<PrivatLocale> {
  const { data, error } = await supabaseAdmin().from("user_settings").select("locale").eq("user_id", userId).maybeSingle();
  if (error) return "sv"; // no table yet (before 0043) or not readable: the default
  return (data as { locale?: string } | null)?.locale === "en" ? "en" : "sv";
}

async function transcriptFor(meetingId: string): Promise<string[]> {
  // Loaded lazily: lib/meetings/tick imports the summary sender (end hook).
  const { buildTranscript } = await import("@/lib/meetings/tick");
  const db = supabaseAdmin();
  const segments: import("@/lib/meetings/tick").SegmentRead[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(
      "segments",
      await db
        .from("segments")
        .select("el_session_id, segment_index, run_index, speaker, text, start_ms, tick_no, transcript_written_at")
        .eq("meeting_id", meetingId)
        .not("tick_no", "is", null)
        .order("tick_no")
        .order("el_session_id")
        .order("segment_index")
        .order("run_index")
        .range(from, from + 999),
    ) as import("@/lib/meetings/tick").SegmentRead[];
    segments.push(...page.map((s) => ({ ...s, start_ms: Number(s.start_ms) })));
    if (page.length < 1000) break;
  }
  if (!segments.length) return [];
  const [sessions, speakers] = await Promise.all([
    db.from("el_sessions").select("id, started_at").eq("meeting_id", meetingId),
    db.from("speaker_map").select("el_session_id, speaker_label, display_name, person_id, merged_into_label").eq("meeting_id", meetingId),
  ]);
  const t = buildTranscript(segments, must("sessions", sessions) as never, must("speakers", speakers) as never);
  const names = Object.entries(t.speakerNames);
  return t.blocks
    .flatMap((b) => b.split("\n"))
    .map((l) => names.reduce((line, [label, name]) => line.replace(`] ${label}: `, `] ${name}: `), l));
}

/** Close the claim with an outcome (from null or from `sending`). False: someone else did. */
async function close(m: MeetingForPrivat, state: SummaryState, now: Date): Promise<boolean> {
  const q = supabaseAdmin().from("meetings").update({ summary_state: state, summary_at: now.toISOString() }).eq("id", m.id).eq("status", "done");
  const rows = must("close", await (m.summary_state === null ? q.is("summary_state", null) : q.eq("summary_state", "sending")).select("id")) as unknown[];
  return rows.length > 0;
}

export interface PrivatSummaryResult {
  state: SummaryState;
  sent: number;
  failed: number;
}

/**
 * Handle one Privat meeting's summary. Null when there is nothing to do (not done, handled, or
 * another run claimed it). `sending`: left for the cron (spend stop, too little time, a failed
 * call under the attempt cap, a mail check that couldn't be answered).
 */
export async function sendPrivatSummary(
  meetingId: string,
  deps: PrivatSummaryDeps,
  opts: { deadlineAt?: Date } = {},
): Promise<PrivatSummaryResult | null> {
  const db = supabaseAdmin();
  const m = must(
    "meeting",
    await db
      .from("meetings")
      .select("id, org_id, status, is_test, started_at, started_by, context_id, summary_state, summary_attempts")
      .eq("id", meetingId)
      .maybeSingle(),
  ) as MeetingForPrivat | null;
  if (!m || m.status !== "done") return null;
  if (m.summary_state !== null && m.summary_state !== "sending") return null;
  const now = deps.now();
  const left = () => (opts.deadlineAt ? opts.deadlineAt.getTime() - deps.now().getTime() : Infinity);

  const finish = async (state: SummaryState, detail: Record<string, unknown> = {}): Promise<PrivatSummaryResult | null> => {
    if (!(await close(m, state, now))) return null;
    await logEvent(m.id, "summary", { state, privat: true, ...detail });
    return { state, sent: detail.sent === 1 ? 1 : 0, failed: detail.failed === 1 ? 1 : 0 };
  };
  if (m.is_test) return finish("test");
  if (!m.context_id || !m.started_by) return finish("none");

  if (m.summary_state === null) {
    const claimed = must(
      "claim",
      await db.from("meetings").update({ summary_state: "sending", summary_at: now.toISOString() }).eq("id", m.id).eq("status", "done").is("summary_state", null).select("id"),
    ) as unknown[];
    if (!claimed.length) return null;
    m.summary_state = "sending";
  }

  const stored = must("stored", await db.from("private_summaries").select("meeting_id").eq("meeting_id", m.id).maybeSingle()) as unknown;
  const locale = await userLocale(m.started_by);

  if (!stored) {
    const [contextRes, notesRes, openRes, recentRes, previousRes] = await Promise.all([
      db.from("contexts").select("name").eq("id", m.context_id).maybeSingle(),
      db.from("note_items").select("section, text, owner, due, deleted_by_human, position").eq("meeting_id", m.id).order("section").order("position"),
      db
        .from("context_tasks")
        .select("id, text, owner, created_at")
        .eq("context_id", m.context_id)
        .eq("done", false)
        .neq("meeting_id", m.id)
        .order("created_at", { ascending: false })
        .limit(MAX_OPEN_TASKS),
      db
        .from("private_summaries")
        .select("decisions, created_at")
        .eq("context_id", m.context_id)
        .neq("meeting_id", m.id)
        .order("created_at", { ascending: false })
        .limit(RECENT_SUMMARIES),
      db
        .from("meetings")
        .select("id")
        .eq("context_id", m.context_id)
        .neq("id", m.id)
        .lt("started_at", m.started_at)
        .order("started_at", { ascending: false })
        .limit(1),
    ]);
    const context = must("context", contextRes) as { name: string } | null;
    if (!context) return finish("none");
    const notes = notesLines(must("notes", notesRes) as NoteItemRow[]).filter((l) => !l.startsWith("Current topic"));
    const transcript = await transcriptFor(m.id);
    if (!notes.length && !transcript.length) return finish("no_notes");

    // Spend and time first: neither is an attempt, the cron tries again.
    if (left() < MIN_CALL_MS) return { state: "sending", sent: 0, failed: 0 };
    if (!(await claudeAllowed().catch(() => false))) {
      await logEvent(m.id, "summary", { state: "sending", privat: true, waiting: "spend" });
      return { state: "sending", sent: 0, failed: 0 };
    }
    const attempts = m.summary_attempts ?? 0;
    if (attempts >= MAX_SUMMARY_ATTEMPTS) return finish("failed", { attempts });
    const counted = must(
      "attempt",
      await db.from("meetings").update({ summary_attempts: attempts + 1 }).eq("id", m.id).eq("summary_attempts", attempts).select("id"),
    ) as unknown[];
    if (!counted.length) return null; // another run is on it

    const keyed = taskKeys(must("open tasks", openRes) as OpenTask[]);
    const recentDecisions = (must("recent", recentRes) as { decisions: string[] }[]).flatMap((r) => r.decisions);
    const previousMeetingId = (must("previous", previousRes) as { id: string }[])[0]?.id ?? null;
    const user = await db.auth.admin.getUserById(m.started_by);
    const meta = (user.data.user?.user_metadata ?? {}) as { full_name?: unknown; name?: unknown };
    const userName = typeof meta.full_name === "string" ? meta.full_name : typeof meta.name === "string" ? meta.name : null;

    const summarize = deps.summarize ?? summarizePrivat();
    const res = await summarize(
      {
        locale,
        contextName: context.name,
        userName,
        startedAt: m.started_at,
        notes,
        transcript,
        openTasks: keyed.map((k) => ({ key: k.key, text: k.task.text, owner: k.task.owner, since: k.task.created_at })),
        recentDecisions,
      },
      { orgId: m.org_id, timeoutMs: Math.min(CALL_TIMEOUT_MS, left() - 15_000) },
    );
    if (!res.ok) {
      await logEvent(m.id, "summary", { state: "sending", privat: true, attempt: attempts + 1, error: res.reason });
      if (res.reason === "spend") return { state: "sending", sent: 0, failed: 0 };
      return attempts + 1 >= MAX_SUMMARY_ATTEMPTS ? finish("failed", { attempts: attempts + 1 }) : { state: "sending", sent: 0, failed: 0 };
    }
    const since = sinceLast(keyed, res.value.previous);
    await saveSummary(m.id, res.value, since, previousMeetingId, locale);
  }

  return mailSummary(m, deps, locale, finish);
}

async function saveSummary(meetingId: string, a: PrivatSummaryAnswer, since: SinceLastItem[], previousMeetingId: string | null, locale: PrivatLocale) {
  must(
    "save",
    await supabaseAdmin().rpc("save_private_summary", {
      p_meeting_id: meetingId,
      p_summary: {
        summary: a.summary,
        decisions: a.decisions,
        facts: a.facts,
        questions: a.questions,
        people: a.people,
        topics: a.topics,
        since_last: since,
        previous_meeting_id: previousMeetingId,
        locale,
      },
      // Due dates are kept in the task text ("(fredag)") so the list shows them.
      p_tasks: a.tasks.map((t) => ({ text: t.due ? `${t.text} (${t.due})` : t.text, owner: t.owner })),
      p_done_task_ids: doneTaskIds(since),
    }),
  );
}

async function mailSummary(
  m: MeetingForPrivat,
  deps: PrivatSummaryDeps,
  locale: PrivatLocale,
  finish: (state: SummaryState, detail?: Record<string, unknown>) => Promise<PrivatSummaryResult | null>,
): Promise<PrivatSummaryResult | null> {
  const db = supabaseAdmin();
  // The mail once: claimed before the mailer is called.
  const claimed = must(
    "mail claim",
    await db.from("private_summaries").update({ mail_claimed_at: deps.now().toISOString() }).eq("meeting_id", m.id).is("mail_claimed_at", null).select("*"),
  ) as {
    summary: string;
    decisions: string[];
    facts: string[];
    questions: string[];
    since_last: SinceLastItem[];
    locale: PrivatLocale;
  }[];
  if (!claimed.length) return finish("sent", { recipients: 1, resumed: true });
  const s = claimed[0];

  const user = await db.auth.admin.getUserById(m.started_by!);
  const email = user.data.user?.email ?? null;
  if (!email) {
    must("mail none", await db.from("private_summaries").update({ mailed: false }).eq("meeting_id", m.id));
    return finish("none");
  }
  const [contextRes, tasksRes] = await Promise.all([
    db.from("contexts").select("name").eq("id", m.context_id!).maybeSingle(),
    db.from("context_tasks").select("text, owner, position").eq("meeting_id", m.id).order("position"),
  ]);
  const context = must("mail context", contextRes) as { name: string } | null;
  const tasks = must("mail tasks", tasksRes) as { text: string; owner: string | null }[];
  const origin = appOrigin();
  const mail = renderPrivatEmail({
    locale: s.locale ?? locale,
    contextName: context?.name ?? "Privat",
    startedAt: m.started_at,
    content: {
      summary: s.summary,
      decisions: s.decisions,
      facts: s.facts,
      tasks: tasks.map((t) => ({ text: t.text, owner: t.owner, due: null })),
      questions: s.questions,
      sinceLast: s.since_last,
    },
    meetingHref: `${origin}/privat/mote/${m.id}`,
    unsubscribeHref: emailPrefsUrl(email, "private_summary", origin),
  });
  const result = await sendUserMail(
    deps.mailer,
    { userId: m.started_by, email },
    "private_summary",
    { subject: mail.subject, text: mail.text, html: mail.html, headers: listUnsubscribeHeaders(email, "private_summary", origin) },
    db,
  );
  const ok = result === "sent";
  must("mailed", await db.from("private_summaries").update({ mailed: ok }).eq("meeting_id", m.id));
  return finish("sent", { recipients: 1, sent: ok ? 1 : 0, failed: result === "failed" ? 1 : 0, ...(result === "opted_out" ? { optedOut: 1 } : {}) });
}
