// The message catalogs. Swedish (sv) is the source of truth: exactly the copy the app has always
// had. English (en) must have every key sv has (tsc checks the shape, lib/i18n/messages.test.ts
// checks keys and placeholders). One JSON file per area; add a new area in both lists.
//
// Glossary and rules: docs/ui.md "Language".

import type { Locale } from "../config";
import enAccount from "./en/account.json";
import enCommon from "./en/common.json";
import enMailPrefs from "./en/mailPrefs.json";
import svAccount from "./sv/account.json";
import svCommon from "./sv/common.json";
import svMailPrefs from "./sv/mailPrefs.json";

export const sv = {
  common: svCommon,
  account: svAccount,
  mailPrefs: svMailPrefs,
};

export type Messages = typeof sv;

export const en: Messages = {
  common: enCommon,
  account: enAccount,
  mailPrefs: enMailPrefs,
};

export const messages: Record<Locale, Messages> = { sv, en };
