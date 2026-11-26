// The date and time "Förbered möte" proposes: the förening's last meeting's weekday and time,
// next week (a weekly förening meets on the same day), never before today. Pure.

const TZ = "Europe/Stockholm";

/** `YYYY-MM-DD` and `HH:MM` of an instant in Stockholm. */
function stockholm(at: Date): { date: string; time: string; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday };
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The proposed meeting date and time: with a last meeting, the next day on or after today with
 * its weekday, at its start time rounded down to the quarter hour; without one, today and no time.
 */
export function proposedWhen(now: Date, lastStartedAt: string | null): { today: string; date: string; time: string } {
  const today = stockholm(now);
  if (!lastStartedAt || !Number.isFinite(Date.parse(lastStartedAt))) return { today: today.date, date: today.date, time: "" };
  const last = stockholm(new Date(lastStartedAt));
  const ahead = (last.weekday - today.weekday + 7) % 7;
  const [h, m] = last.time.split(":").map(Number);
  const time = `${String(h).padStart(2, "0")}:${String(m - (m % 15)).padStart(2, "0")}`;
  return { today: today.date, date: addDays(today.date, ahead), time };
}
