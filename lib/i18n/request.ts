import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, TIME_ZONE, toLocale } from "./config";
import { messages } from "./messages";

// next-intl's per-request config (wired in next.config.ts). No URL prefixes: the language is the
// `lang` cookie (Konto / the footer switch; the auth callback copies the saved choice into it),
// Swedish when there is none.
export default getRequestConfig(async () => {
  const locale = toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return { locale, messages: messages[locale], timeZone: TIME_ZONE };
});
