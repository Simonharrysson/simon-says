// Dates and titles of Privat recordings (Stockholm time). Pure: pages, e-mail and the start use it.

const TZ = "Europe/Stockholm";

export type PrivatLocale = "sv" | "en";

const tag = (locale: PrivatLocale) => (locale === "en" ? "en-GB" : "sv-SE");

/** "26 nov 18.05" / "26 Nov 18:05". */
export function shortWhen(iso: string | Date, locale: PrivatLocale = "sv"): string {
  const at = typeof iso === "string" ? new Date(iso) : iso;
  const day = new Intl.DateTimeFormat(tag(locale), { day: "numeric", month: "short", timeZone: TZ }).format(at).replace(/\./g, "");
  const time = new Intl.DateTimeFormat(tag(locale), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).format(at);
  return `${day} ${locale === "sv" ? time.replace(":", ".") : time}`;
}

/** "torsdag 26 november" / "Thursday 26 November". */
export function longDay(iso: string, locale: PrivatLocale = "sv"): string {
  return new Intl.DateTimeFormat(tag(locale), { weekday: "long", day: "numeric", month: "long", timeZone: TZ }).format(new Date(iso));
}

/** The recording's title: "TDDE15 · 26 nov 18.05". */
export function privatTitle(contextName: string, startedAt: string | Date, locale: PrivatLocale = "sv"): string {
  return `${contextName.trim()} · ${shortWhen(startedAt, locale)}`;
}
