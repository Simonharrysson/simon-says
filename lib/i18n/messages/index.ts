// The message catalogs. Swedish (sv) is the source of truth: exactly the copy the app has always
// had. English (en) must have every key sv has (tsc checks the shape, lib/i18n/messages.test.ts
// checks keys and placeholders). One JSON file per area; add a new area in both lists.
//
// Glossary and rules: docs/ui.md "Language".

import type { Locale } from "../config";
import enOnboarding from "./en/onboarding.json";
import svOnboarding from "./sv/onboarding.json";
import enPrepare from "./en/prepare.json";
import svPrepare from "./sv/prepare.json";
import enDrive from "./en/drive.json";
import svDrive from "./sv/drive.json";
import enImportProgress from "./en/importProgress.json";
import svImportProgress from "./sv/importProgress.json";
import enHistory from "./en/history.json";
import svHistory from "./sv/history.json";
import enOverview from "./en/overview.json";
import svOverview from "./sv/overview.json";
import enFormatEditor from "./en/formatEditor.json";
import svFormatEditor from "./sv/formatEditor.json";
import enStart from "./en/start.json";
import svStart from "./sv/start.json";
import enSummary from "./en/summary.json";
import svSummary from "./sv/summary.json";
import enApi from "./en/api.json";
import svApi from "./sv/api.json";
import enInvites from "./en/invites.json";
import svInvites from "./sv/invites.json";
import enEmails from "./en/emails.json";
import svEmails from "./sv/emails.json";
import enFormats from "./en/formats.json";
import svFormats from "./sv/formats.json";
import enOrg from "./en/org.json";
import svOrg from "./sv/org.json";
import enOrgs from "./en/orgs.json";
import svOrgs from "./sv/orgs.json";
import enPrivacy from "./en/privacy.json";
import svPrivacy from "./sv/privacy.json";
import enLanding from "./en/landing.json";
import svLanding from "./sv/landing.json";
import enStatus from "./en/status.json";
import svStatus from "./sv/status.json";
import enFormat from "./en/format.json";
import svFormat from "./sv/format.json";
import enJoin from "./en/join.json";
import svJoin from "./sv/join.json";
import enLogin from "./en/login.json";
import svLogin from "./sv/login.json";
import enAccount from "./en/account.json";
import enCommon from "./en/common.json";
import enMailPrefs from "./en/mailPrefs.json";
import enNotices from "./en/notices.json";
import svAccount from "./sv/account.json";
import svCommon from "./sv/common.json";
import svMailPrefs from "./sv/mailPrefs.json";
import svNotices from "./sv/notices.json";

export const sv = {
  onboarding: svOnboarding,
  prepare: svPrepare,
  drive: svDrive,
  importProgress: svImportProgress,
  history: svHistory,
  overview: svOverview,
  formatEditor: svFormatEditor,
  start: svStart,
  summary: svSummary,
  api: svApi,
  invites: svInvites,
  emails: svEmails,
  formats: svFormats,
  org: svOrg,
  orgs: svOrgs,
  privacy: svPrivacy,
  landing: svLanding,
  status: svStatus,
  format: svFormat,
  join: svJoin,
  login: svLogin,
  common: svCommon,
  account: svAccount,
  mailPrefs: svMailPrefs,
  notices: svNotices,
};

export type Messages = typeof sv;

export const en: Messages = {
  onboarding: enOnboarding,
  prepare: enPrepare,
  drive: enDrive,
  importProgress: enImportProgress,
  history: enHistory,
  overview: enOverview,
  formatEditor: enFormatEditor,
  start: enStart,
  summary: enSummary,
  api: enApi,
  invites: enInvites,
  emails: enEmails,
  formats: enFormats,
  org: enOrg,
  orgs: enOrgs,
  privacy: enPrivacy,
  landing: enLanding,
  status: enStatus,
  format: enFormat,
  join: enJoin,
  login: enLogin,
  common: enCommon,
  account: enAccount,
  mailPrefs: enMailPrefs,
  notices: enNotices,
};

export const messages: Record<Locale, Messages> = { sv, en };
