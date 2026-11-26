// Display text for the org Översikt. Europe/Stockholm; Swedish unless told otherwise. Pure.

import { defaultLocale, intlTag, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
import type { Overview } from "./overview";

const TZ = "Europe/Stockholm";

/** "24 nov", with the year when it isn't `now`'s year ("24 nov 2025"). */
export function formatDay(iso: string, now: Date = new Date(), locale: Locale = defaultLocale): string {
  const d = new Date(iso);
  const year = (x: Date) => x.toLocaleDateString("sv-SE", { timeZone: TZ, year: "numeric" });
  return d
    .toLocaleDateString(intlTag(locale), { timeZone: TZ, day: "numeric", month: "short", ...(year(d) === year(now) ? {} : { year: "numeric" }) })
    .replace(/\./g, "");
}

/** "Målen bygger på …": what the goals rest on, imported protocols and own meetings. */
export function basisLine(o: Pick<Overview, "meetingCount" | "firstMeeting" | "imported">, now: Date, locale: Locale = defaultLocale): string {
  const t = translator(locale);
  const imported = o.imported.count;
  const own = o.meetingCount;
  if (imported === 0 && own === 0) return t("overview.basisNone");
  const starts = [o.imported.first, o.firstMeeting].filter((d): d is string => Boolean(d)).map((d) => (d.length === 10 ? `${d}T12:00:00Z` : d));
  const first = starts.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const since = first ? t("overview.since", { date: formatDay(first, now, locale) }) : "";
  if (imported === 0) return t("overview.basisOwn", { own, since });
  if (own === 0) return t("overview.basisImported", { imported, since });
  return t("overview.basisBoth", { imported, own, since });
}
