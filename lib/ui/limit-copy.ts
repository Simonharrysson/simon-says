// Swedish copy for why a meeting stopped on its own, or is about to (final fix wave C9). The
// reason comes from the heartbeat (`reason`) or the token route's refusal code.

/** Shown after a meeting ended on its own. */
export function autoStopText(reason?: string | null): string {
  switch (reason) {
    case "meeting_length":
      return "Mötet nådde gränsen på 4 timmar och avslutades automatiskt.";
    case "org_month":
      return "Föreningen har använt sina 20 timmar den här månaden, så mötet avslutades automatiskt. Tiden fylls på den 1:a.";
    case "global_day":
    case "global_usd":
      return "Simon Says har nått dagens gräns för hela tjänsten, så mötet avslutades automatiskt. Det går att starta möten igen i morgon.";
    case "kill_switch":
      return "Tjänsten är pausad just nu, så mötet avslutades automatiskt.";
    case "el_service":
      return "Transkriberingstjänstens kvot är slut – meddela den som driver Simon Says. Mötet avslutades automatiskt.";
    default:
      return "Mötet avslutades automatiskt.";
  }
}

/** The "avslutas om N min" banner's explanation. */
export function limitWarningText(reason?: string | null): string {
  switch (reason) {
    case "org_month":
      return "Föreningens 20 timmar för den här månaden tar snart slut. Tiden fylls på den 1:a.";
    case "global_day":
    case "global_usd":
      return "Simon Says närmar sig dagens gräns för hela tjänsten. Det går att starta möten igen i morgon.";
    default:
      return "Ett möte kan vara högst 4 timmar. Behöver ni mer tid, avsluta och starta ett nytt möte.";
  }
}

/** URL-safe reason for `?stoppat=<reason>` (anything else becomes "1"). */
export function stopParam(reason?: string | null): string {
  return reason && /^[a-z_]{1,30}$/.test(reason) ? reason : "1";
}
