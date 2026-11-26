import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";

// Copy (live.limits.* in the catalogs) for why a meeting stopped on its own, or is about to (final fix wave C9). The
// reason comes from the heartbeat (`reason`) or the token route's refusal code.

const globalReason = (reason?: string | null) => reason === "global_day" || reason === "global_usd";

/** Shown after a meeting ended on its own. */
export function autoStopText(reason?: string | null, locale: Locale = defaultLocale): string {
  const t = translator(locale);
  if (globalReason(reason)) return t("live.limits.stop.global");
  switch (reason) {
    case "meeting_length":
    case "org_month":
    case "kill_switch":
    case "el_service":
      return t(`live.limits.stop.${reason}`);
    default:
      return t("live.limits.stop.default");
  }
}

/** The "avslutas om N min" banner's explanation. */
export function limitWarningText(reason?: string | null, locale: Locale = defaultLocale): string {
  const t = translator(locale);
  if (globalReason(reason)) return t("live.limits.warn.global");
  return reason === "org_month" ? t("live.limits.warn.org_month") : t("live.limits.warn.default");
}

/** URL-safe reason for `?stoppat=<reason>` (anything else becomes "1"). */
export function stopParam(reason?: string | null): string {
  return reason && /^[a-z_]{1,30}$/.test(reason) ? reason : "1";
}
