// Display formatting for the UI. Swedish, Europe/Stockholm. Pure functions (tested).

const TZ = "Europe/Stockholm";

/** "24 nov 2026 kl. 18:05" style, for meeting lists. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("sv-SE", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return `${day.replace(".", "")} kl. ${time}`;
}

/** "18:05" in Stockholm time. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

/** Meeting timer: "04:09" under an hour, "1:02:09" from an hour. Negative input counts as 0. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** "45 min", "1 h 12 min", "2 h" — for durations of finished meetings. Under a minute → "under 1 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return "under 1 min";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Whole minutes between two instants (floored, never negative). */
export function minutesBetween(fromIso: string, to: Date = new Date()): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(fromIso).getTime()) / 60000));
}

/** Swedish plural helper: plural(1, "person", "personer") → "1 person". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The newest end of a growing text: the last `max` characters, cut at a word boundary and
 * prefixed with "…". Live partials grow at the end, so the end is what matters.
 */
export function tailText(text: string, max = 160): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const tail = clean.slice(-max);
  const space = tail.indexOf(" ");
  return `…${space > 0 && space < 30 ? tail.slice(space + 1) : tail}`;
}
