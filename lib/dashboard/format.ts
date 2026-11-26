// Display text for the org dashboard. Swedish, Europe/Stockholm. Pure.

const TZ = "Europe/Stockholm";
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

/** "24 nov", with the year when it isn't `now`'s year ("24 nov 2025"). */
export function formatDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const year = (x: Date) => x.toLocaleDateString("sv-SE", { timeZone: TZ, year: "numeric" });
  return d
    .toLocaleDateString("sv-SE", { timeZone: TZ, day: "numeric", month: "short", ...(year(d) === year(now) ? {} : { year: "numeric" }) })
    .replace(/\./g, "");
}

/** "2026-11" → "november 2026". */
export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

/** How long a task has been open: "ny i veckan", "1 vecka", "3 veckor". */
export function formatWeeks(weeks: number): string {
  if (weeks < 1) return "ny i veckan";
  return weeks === 1 ? "1 vecka" : `${weeks} veckor`;
}

/** Lower-case, accents kept, spaces collapsed: what the decision search compares. */
export const searchKey = (s: string) => s.normalize("NFC").toLocaleLowerCase("sv").replace(/\s+/g, " ").trim();

/** Every word of the query is somewhere in the text (agenda label included). */
export function matchesQuery(text: string, query: string): boolean {
  const q = searchKey(query);
  if (!q) return true;
  const t = searchKey(text);
  return q.split(" ").every((w) => t.includes(w));
}
