// use-intl/core: no React, so it also loads under react-server outside Next (scripts, e2e fakes).
import { createTranslator } from "use-intl/core";
import { defaultLocale, type Locale, TIME_ZONE } from "./config";
import { messages } from "./messages";

function make(locale: Locale) {
  return createTranslator({ locale, messages: messages[locale], timeZone: TIME_ZONE });
}

export type Translator = ReturnType<typeof make>;

const cache = new Map<Locale, Translator>();

/**
 * A translator outside React and outside a request: e-mails (in the recipient's language),
 * route handlers (locale from the Request's cookie) and pure display helpers. Keys are full
 * paths ("common.signIn"), typed from the Swedish catalog. One per locale, reused.
 */
export function translator(locale: Locale = defaultLocale): Translator {
  let t = cache.get(locale);
  if (!t) cache.set(locale, (t = make(locale)));
  return t;
}
