// Display text for the org Översikt. Swedish, Europe/Stockholm. Pure.

import { plural } from "@/lib/format";
import type { Overview } from "./overview";

const TZ = "Europe/Stockholm";

/** "24 nov", with the year when it isn't `now`'s year ("24 nov 2025"). */
export function formatDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const year = (x: Date) => x.toLocaleDateString("sv-SE", { timeZone: TZ, year: "numeric" });
  return d
    .toLocaleDateString("sv-SE", { timeZone: TZ, day: "numeric", month: "short", ...(year(d) === year(now) ? {} : { year: "numeric" }) })
    .replace(/\./g, "");
}

/** "Målen bygger på …": what the goals rest on, imported protocols and own meetings. */
export function basisLine(o: Pick<Overview, "meetingCount" | "firstMeeting" | "imported">, now: Date): string {
  const imported = o.imported.count;
  const own = o.meetingCount;
  if (imported === 0 && own === 0) return "Målen kan föreslås när föreningen har haft sina första möten med Simon Says.";
  const starts = [o.imported.first, o.firstMeeting].filter((d): d is string => Boolean(d)).map((d) => (d.length === 10 ? `${d}T12:00:00Z` : d));
  const first = starts.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const since = first ? ` sedan ${formatDay(first, now)}` : "";
  if (imported === 0) return `Målen bygger på ${plural(own, "avslutat möte", "avslutade möten")}${since}. Testmöten räknas inte.`;
  const old = plural(imported, "importerat protokoll", "importerade protokoll");
  if (own === 0) return `Målen bygger på ${old}${since}. Möten med Simon Says räknas in efter det första mötet.`;
  return `Målen bygger på ${old} och ${plural(own, "möte med Simon Says", "möten med Simon Says")}${since}. Testmöten räknas inte.`;
}

