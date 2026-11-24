import "server-only";
import { getEnv } from "@/lib/env";
import { MAX_MINTS_PER_MEETING, MEETING_SECONDS, MIN_MINT_INTERVAL_SECONDS, ORG_MONTH_SECONDS } from "@/lib/limits";
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
 * Close an ElevenLabs session and book its seconds (server times, capped at its window end
 * started_at + max_seconds + 900 s) and their cost at ELEVENLABS_USD_PER_HOUR in usage_daily,
 * atomically. Idempotent: returns 0 if it was already closed.
 */
export async function closeElSession(sessionId: string): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("close_el_session", {
    p_session_id: sessionId,
    p_usd_per_hour: getEnv().ELEVENLABS_USD_PER_HOUR,
  });
  if (error) throw new Error(`closeElSession: ${error.message}`);
  return Number(data ?? 0);
}

export type ClaimStatus =
  | "ok"
  | "busy"
  | "not_live"
  | "not_found"
  | "no_consent"
  | "reconnect_limit"
  | "global_usd"
  | "meeting_length"
  | "org_month"
  | "global_day";

/**
 * The token lock (claim_el_session, migration 0005): under the global and org advisory locks
 * and the meeting row lock, check that a new session may start, apply the mint rate limit,
 * close the previous current session, and size the new one from what every cap has left after
 * used time and open sessions' reservations. `maxSeconds` is set only when status is "ok".
 */
export async function claimElSession(
  meetingId: string,
  sessionId: string,
  closingSessionId: string | null,
): Promise<{ status: ClaimStatus; maxSeconds: number | null }> {
  const env = getEnv();
  const { data, error } = await supabaseAdmin().rpc("claim_el_session", {
    p_meeting_id: meetingId,
    p_new_session_id: sessionId,
    p_closing_session_id: closingSessionId,
    p_meeting_cap_secs: MEETING_SECONDS,
    p_org_month_cap_secs: ORG_MONTH_SECONDS,
    p_global_day_cap_secs: Math.floor(env.GLOBAL_DAILY_HOURS * 3600),
    p_global_usd_cap: env.GLOBAL_DAILY_USD,
    p_usd_per_hour: env.ELEVENLABS_USD_PER_HOUR,
    p_max_mints: MAX_MINTS_PER_MEETING,
    p_min_mint_interval_secs: MIN_MINT_INTERVAL_SECONDS,
  });
  if (error) throw new Error(`claimElSession: ${error.message}`);
  const row = (data as { status: ClaimStatus; max_seconds: number | null }[] | null)?.[0];
  if (!row) throw new Error("claimElSession: no result row");
  return { status: row.status, maxSeconds: row.max_seconds };
}
