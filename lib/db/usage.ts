import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Seconds the org has used this calendar month (UTC): closed sessions' seconds from
 * usage_daily plus the elapsed time of open sessions. The single source for caps.
 */
export async function orgMonthSeconds(orgId: string): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("org_month_seconds", { p_org_id: orgId });
  if (error) throw new Error(`orgMonthSeconds: ${error.message}`);
  return Number(data ?? 0);
}

/** Today's (UTC) recorded spend in USD across all orgs. */
export async function dayUsd(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin().from("usage_daily").select("usd").eq("day", today);
  if (error) throw new Error(`dayUsd: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number(row.usd), 0);
}

/** Seconds one meeting has used: all its ElevenLabs sessions, closed or open (server times). */
export async function meetingSeconds(meetingId: string): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("meeting_seconds", { p_meeting_id: meetingId });
  if (error) throw new Error(`meetingSeconds: ${error.message}`);
  return Number(data ?? 0);
}

/** Seconds used today (UTC) across all orgs: closed sessions plus open sessions' elapsed time. */
export async function globalDaySeconds(): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("global_day_seconds");
  if (error) throw new Error(`globalDaySeconds: ${error.message}`);
  return Number(data ?? 0);
}

/**
 * Close an ElevenLabs session and book its seconds (server times, capped at max_seconds) in
 * usage_daily, atomically. Idempotent: returns 0 if it was already closed.
 */
export async function closeElSession(sessionId: string): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("close_el_session", { p_session_id: sessionId });
  if (error) throw new Error(`closeElSession: ${error.message}`);
  return Number(data ?? 0);
}

export type BeginSessionResult = "ok" | "busy" | "not_live" | "not_found";

/**
 * The token lock: under a row lock on the meeting, check that a new session may start, close
 * the previous current session (booking its seconds) and make `sessionId` current. See
 * begin_el_session in migration 0004 for the exact rule.
 */
export async function beginElSession(
  meetingId: string,
  sessionId: string,
  maxSeconds: number,
  closingSessionId: string | null,
): Promise<BeginSessionResult> {
  const { data, error } = await supabaseAdmin().rpc("begin_el_session", {
    p_meeting_id: meetingId,
    p_new_session_id: sessionId,
    p_max_seconds: maxSeconds,
    p_closing_session_id: closingSessionId,
  });
  if (error) throw new Error(`beginElSession: ${error.message}`);
  return data as BeginSessionResult;
}
