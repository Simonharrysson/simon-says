import { createTranslator } from "next-intl";
import { defaultLocale, type Locale, TIME_ZONE } from "./config";
import { messages } from "./messages";

/**
 * A translator outside React and outside a request: e-mails (in the recipient's language),
 * route handlers (locale from the Request's cookie) and pure display helpers. Keys are full
 * paths ("common.signIn"), typed from the Swedish catalog.
 */
export function translator(locale: Locale = defaultLocale) {
  return createTranslator({ locale, messages: messages[locale], timeZone: TIME_ZONE });
}

export type Translator = ReturnType<typeof translator>;
