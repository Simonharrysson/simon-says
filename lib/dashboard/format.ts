// Display text for the org dashboard. Swedish, Europe/Stockholm. Pure.

import { plural } from "@/lib/format";
import type { Overview } from "./overview";

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

/** How long a task has been open: "ny den här veckan", "1 vecka", "3 veckor". */
export function formatWeeks(weeks: number): string {
  if (weeks < 1) return "ny den här veckan";
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

/** "Bygger på …": what the overview counts, imported protocols and own meetings. */
export function basisLine(o: Pick<Overview, "meetingCount" | "firstMeeting" | "imported">, now: Date): string {
  const imported = o.imported.count;
  const own = o.meetingCount;
  if (imported === 0 && own === 0) return "Översikten fylls på när föreningen har haft sitt första möte med Simon Says.";
  const starts = [o.imported.first, o.firstMeeting].filter((d): d is string => Boolean(d)).map((d) => (d.length === 10 ? `${d}T12:00:00Z` : d));
  const first = starts.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const since = first ? ` sedan ${formatDay(first, now)}` : "";
  if (imported === 0) return `Bygger på ${plural(own, "avslutat möte", "avslutade möten")}${since}. Testmöten räknas inte.`;
  const old = plural(imported, "importerat protokoll", "importerade protokoll");
  if (own === 0) return `Bygger på ${old}${since}. Möten med Simon Says räknas in efter det första mötet.`;
  return `Bygger på ${old} och ${plural(own, "möte med Simon Says", "möten med Simon Says")}${since}. Testmöten räknas inte.`;
}

