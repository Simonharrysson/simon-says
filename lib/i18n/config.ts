// Languages of the web UI. Swedish is the default and the source of truth; English is a
// translation of it (lib/i18n/messages). Pure: safe in server, client and tests.
//
// Not translated: what we write into Google Docs (notes, agenda Docs, headings) and the Claude
// prompts. The Doc follows the förening's meeting language, which is Swedish for now.

export const locales = ["sv", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "sv";

/** Cookie with the chosen UI language ("sv" | "en"). Set by Konto and the footer switch. */
export const LOCALE_COOKIE = "lang";
/** One year. The DB (user_settings.locale, 0043) is the durable copy for signed-in users. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const TIME_ZONE = "Europe/Stockholm";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

export function toLocale(value: unknown): Locale {
  return isLocale(value) ? value : defaultLocale;
}

/** The BCP 47 tag for dates and numbers: sv-SE or en-GB. */
export function intlTag(locale: Locale): string {
  return locale === "en" ? "en-GB" : "sv-SE";
}

/** The locale in a raw Cookie header (route handlers read it from the Request). */
export function localeFromCookieHeader(header: string | null | undefined): Locale {
  if (!header) return defaultLocale;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LOCALE_COOKIE) return toLocale(decodeURIComponent(rest.join("=")));
  }
  return defaultLocale;
}

/** Same-origin relative path to go back to after switching language; anything else → "/". */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}
