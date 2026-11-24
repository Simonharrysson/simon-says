import "server-only";
import { dayUsd } from "@/lib/db/usage";
import { getEnv } from "@/lib/env";
import { defaultMailer, type Mailer, type MailMessage } from "@/lib/mail";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Spend alarms (Task 12): the daily summary (cron, 06:00 UTC) and the immediate email the
// first time a UTC day passes 50 % of GLOBAL_DAILY_USD.

export const ALARM_FRACTION = 0.5;

export interface DayOrgRow {
  orgName: string;
  seconds: number;
  /** usage_daily.usd: ElevenLabs (booked on session close) + Claude. */
  usd: number;
}

export interface DaySummary {
  day: string;
  orgs: { orgName: string; hours: number }[];
  totalHours: number;
  elevenLabsUsd: number;
  claudeUsd: number;
  totalUsd: number;
  usdPerHour: number | null;
  failedTicks: number;
  exceeded: boolean;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Pure cost math. usage_daily.seconds only holds live sessions (test sessions book nothing), so
 * ElevenLabs cost = hours × rate and the rest of usage_daily.usd is Claude's.
 */
export function summarizeDay(
  day: string,
  rows: DayOrgRow[],
  opts: { elevenLabsUsdPerHour: number; dailyUsdCap: number; failedTicks: number },
): DaySummary {
  const totalSeconds = rows.reduce((s, r) => s + r.seconds, 0);
  const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
  const totalHours = totalSeconds / 3600;
  const elevenLabsUsd = totalHours * opts.elevenLabsUsdPerHour;
  return {
    day,
    orgs: rows.map((r) => ({ orgName: r.orgName, hours: r.seconds / 3600 })),
    totalHours,
    elevenLabsUsd,
    claudeUsd: Math.max(0, totalUsd - elevenLabsUsd),
    totalUsd,
    usdPerHour: totalHours > 0 ? totalUsd / totalHours : null,
    failedTicks: opts.failedTicks,
    exceeded: totalUsd > opts.dailyUsdCap * ALARM_FRACTION,
  };
}

const usd = (n: number) => `$${round(n).toFixed(2)}`;
const hours = (n: number) => `${round(n).toFixed(2)} h`;

export function summaryMail(s: DaySummary, to: string, dailyUsdCap: number): MailMessage {
  const lines = [
    `Sammanfattning för ${s.day} (UTC)`,
    "",
    "Timmar per organisation:",
    ...(s.orgs.length ? s.orgs.map((o) => `  ${o.orgName}: ${hours(o.hours)}`) : ["  (inga möten)"]),
    `Totalt: ${hours(s.totalHours)}`,
    "",
    `ElevenLabs: ${usd(s.elevenLabsUsd)}`,
    `Claude: ${usd(s.claudeUsd)}`,
    `Summa: ${usd(s.totalUsd)} av taket ${usd(dailyUsdCap)}`,
    `Kostnad per mötestimme: ${s.usdPerHour === null ? "-" : usd(s.usdPerHour)}`,
    `Misslyckade uppdateringar: ${s.failedTicks}`,
  ];
  const subject = `${s.exceeded ? "⚠️ " : ""}Simon Says: dagssammanfattning ${s.day}`;
  return { to, subject, text: lines.join("\n") };
}

/** UTC date (YYYY-MM-DD) of the day before `now`. */
export function yesterdayUtc(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export async function loadDaySummary(day: string): Promise<DaySummary> {
  const db = supabaseAdmin();
  const env = getEnv();
  const usage = await db.from("usage_daily").select("org_id, seconds, usd").eq("day", day);
  if (usage.error) throw new Error(`alarm: usage: ${usage.error.message}`);
  const ids = [...new Set((usage.data ?? []).map((r) => r.org_id as string))];
  const names = new Map<string, string>();
  if (ids.length) {
    const orgs = await db.from("orgs").select("id, name").in("id", ids);
    if (orgs.error) throw new Error(`alarm: orgs: ${orgs.error.message}`);
    for (const o of orgs.data ?? []) names.set(o.id as string, o.name as string);
  }
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
  const failed = await db
    .from("meeting_events")
    .select("id", { count: "exact", head: true })
    .eq("kind", "tick_failed")
    .gte("at", `${day}T00:00:00Z`)
    .lt("at", next);
  if (failed.error) throw new Error(`alarm: failed ticks: ${failed.error.message}`);
  const rows = (usage.data ?? [])
    .map((r) => ({
      orgName: names.get(r.org_id as string) ?? "(raderad organisation)",
      seconds: Number(r.seconds),
      usd: Number(r.usd),
    }))
    .sort((a, b) => b.seconds - a.seconds);
  return summarizeDay(day, rows, {
    elevenLabsUsdPerHour: env.ELEVENLABS_USD_PER_HOUR,
    dailyUsdCap: env.GLOBAL_DAILY_USD,
    failedTicks: failed.count ?? 0,
  });
}

/** Send yesterday's summary to ALARM_EMAIL. Returns the summary and whether it was sent. */
export async function sendDailySummary(
  now = new Date(),
  mailer: Mailer = defaultMailer(),
): Promise<{ summary: DaySummary; sent: boolean }> {
  const env = getEnv();
  const summary = await loadDaySummary(yesterdayUtc(now));
  const sent = await mailer.send(summaryMail(summary, env.ALARM_EMAIL, env.GLOBAL_DAILY_USD));
  return { summary, sent };
}

export interface SpendAlarmDeps {
  mailer: Mailer;
  /** True exactly once per UTC day, when today's spend is at/over the threshold (DB lock). */
  claim(thresholdUsd: number): Promise<boolean>;
  /** Give today's claim back (sending failed), so the next usage update retries. */
  release(): Promise<void>;
  /** Today's recorded spend. */
  dayUsd(): Promise<number>;
}

function defaultSpendDeps(): SpendAlarmDeps {
  return {
    mailer: defaultMailer(),
    dayUsd,
    async claim(threshold) {
      const { data, error } = await supabaseAdmin().rpc("claim_spend_alarm", { p_threshold_usd: threshold });
      if (error) throw new Error(`claim_spend_alarm: ${error.message}`);
      return data === true;
    },
    async release() {
      const today = new Date().toISOString().slice(0, 10);
      const { error } = await supabaseAdmin().from("spend_alarms").delete().eq("day", today);
      if (error) throw new Error(`release spend alarm: ${error.message}`);
    },
  };
}

/**
 * Call after anything that adds to usage_daily. Sends the "50 % of the dollar cap" email the
 * first time the day passes it (once per day, marker in spend_alarms). Never throws: it must not
 * break a tick or a session close. Returns true when it sent.
 */
export async function checkSpendAlarm(deps: SpendAlarmDeps = defaultSpendDeps()): Promise<boolean> {
  try {
    const env = getEnv();
    const threshold = env.GLOBAL_DAILY_USD * ALARM_FRACTION;
    // Cheap read first: the lock-taking claim only runs once the day is near the threshold.
    const spent = await deps.dayUsd();
    if (spent < threshold) return false;
    if (!(await deps.claim(threshold))) return false;
    const message: MailMessage = {
      to: env.ALARM_EMAIL,
      subject: `⚠️ Simon Says: dagens kostnad har passerat ${Math.round(ALARM_FRACTION * 100)} % av taket`,
      text: [
        `Dagens registrerade kostnad är ${usd(spent)} av taket ${usd(env.GLOBAL_DAILY_USD)} (UTC-dygn).`,
        `Vid taket stoppas nya sessioner och pågående möten avslutas.`,
      ].join("\n"),
    };
    let sent = false;
    try {
      sent = await deps.mailer.send(message);
    } catch (e) {
      console.error(`spend alarm: mail failed: ${(e as Error).message}`);
    }
    if (!sent) await deps.release();
    return sent;
  } catch (e) {
    console.error(`spend alarm: ${(e as Error).message}`);
    return false;
  }
}
