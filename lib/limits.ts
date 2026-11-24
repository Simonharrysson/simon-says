import "server-only";
import { getEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { dayUsd, globalDaySeconds, meetingSeconds, orgMonthSeconds } from "@/lib/db/usage";

// Usage caps. All usage comes from server times (el_sessions / usage_daily), never from the
// client.

export const ORG_MONTH_SECONDS = 20 * 3600;
export const MEETING_SECONDS = 4 * 3600;
/** Warn this long before any cap stops the meeting (meeting: at 3 h 45). */
export const WARN_BEFORE_SECONDS = 15 * 60;
/** Mint rate limit per meeting (Ruling 15). */
export const MAX_MINTS_PER_MEETING = 30;
export const MIN_MINT_INTERVAL_SECONDS = 5;

export type LimitReason =
  | "org_month"
  | "meeting_length"
  | "global_day"
  | "global_usd"
  | "kill_switch"
  | "no_consent"
  | "reconnect_limit";

export interface LimitResult {
  ok: boolean;
  warn: boolean;
  stop: boolean;
  reason?: LimitReason;
  /** Seconds left before the first cap is reached (whole seconds, ≥ 0). */
  remainingSeconds: number;
}

export interface LimitInput {
  killSwitch: boolean;
  consentConfirmed: boolean;
  orgMonthSeconds: number;
  meetingSeconds: number;
  globalDaySeconds: number;
  dayUsd: number;
  globalDailyHours: number;
  globalDailyUsd: number;
}

/** Pure decision from current usage. First matching stop reason wins, in this order. */
export function decideLimits(i: LimitInput): LimitResult {
  // Whole seconds: a cap less than a second away counts as reached (max_seconds must be ≥ 1).
  const remaining = {
    meeting_length: Math.floor(MEETING_SECONDS - i.meetingSeconds),
    org_month: Math.floor(ORG_MONTH_SECONDS - i.orgMonthSeconds),
    global_day: Math.floor(i.globalDailyHours * 3600 - i.globalDaySeconds),
  };
  const remainingSeconds = Math.max(0, Math.min(...Object.values(remaining)));

  let reason: LimitReason | undefined;
  if (i.killSwitch) reason = "kill_switch";
  else if (!i.consentConfirmed) reason = "no_consent";
  else if (i.dayUsd >= i.globalDailyUsd) reason = "global_usd";
  else if (remaining.meeting_length <= 0) reason = "meeting_length";
  else if (remaining.org_month <= 0) reason = "org_month";
  else if (remaining.global_day <= 0) reason = "global_day";

  const stop = reason !== undefined;
  return {
    ok: !stop,
    warn: !stop && remainingSeconds <= WARN_BEFORE_SECONDS,
    stop,
    ...(reason ? { reason } : {}),
    remainingSeconds: stop ? 0 : remainingSeconds,
  };
}

/**
 * Current limits for a meeting, from used time (open sessions by elapsed time): for the
 * heartbeat's warn/stop. The token endpoint does NOT use this to size a session; it decides
 * under a lock in claim_el_session, which also counts what other open sessions may still use.
 */
export async function checkLimits(orgId: string, meetingId: string): Promise<LimitResult> {
  const env = getEnv();
  if (env.KILL_SWITCH) {
    return decideLimits({
      killSwitch: true,
      consentConfirmed: false,
      orgMonthSeconds: 0,
      meetingSeconds: 0,
      globalDaySeconds: 0,
      dayUsd: 0,
      globalDailyHours: env.GLOBAL_DAILY_HOURS,
      globalDailyUsd: env.GLOBAL_DAILY_USD,
    });
  }
  const meeting = supabaseAdmin()
    .from("meetings")
    .select("consent_confirmed_at")
    .eq("id", meetingId)
    .eq("org_id", orgId)
    .maybeSingle();
  const [m, org, mtg, day, usd] = await Promise.all([
    meeting,
    orgMonthSeconds(orgId),
    meetingSeconds(meetingId),
    globalDaySeconds(),
    dayUsd(),
  ]);
  if (m.error) throw new Error(`checkLimits: ${m.error.message}`);
  return decideLimits({
    killSwitch: false,
    consentConfirmed: Boolean(m.data?.consent_confirmed_at),
    orgMonthSeconds: org,
    meetingSeconds: mtg,
    globalDaySeconds: day,
    dayUsd: usd,
    globalDailyHours: env.GLOBAL_DAILY_HOURS,
    globalDailyUsd: env.GLOBAL_DAILY_USD,
  });
}
