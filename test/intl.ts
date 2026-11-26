import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactElement } from "react";
import type { Locale } from "@/lib/i18n/config";
import { messages } from "@/lib/i18n/messages";

/** Wraps an element in the i18n provider, as the root layout does (Swedish unless told). */
export function withIntl(element: ReactElement, locale: Locale = "sv"): ReactElement {
  return createElement(NextIntlClientProvider, { locale, messages: messages[locale], timeZone: "Europe/Stockholm", children: element });
}
