// Limits of the protocol import (todo #7), shared by the routes and the Översikt.

/** Docs per pick (and per estimate request); a Doc can hold several meetings. */
export const MAX_IMPORT_DOCS = 150;
/** 0032 claim_history_import: protocols read per förening per 24 h. */
export const IMPORT_RATE_LIMITED = "Simon Says har läst 60 protokoll ett och ett åt föreningen det senaste dygnet. Fortsätt i morgon.";
/** 0036 create_history_import_job: meetings per förening per 24 h through the batch path. */
export const BATCH_RATE_LIMITED = "Föreningen har redan låtit Simon Says läsa nära 500 protokoll det senaste dygnet. Fortsätt i morgon eller välj färre.";

/** "≈ 0,40 USD" (two decimals rounded up, at least 0,01; Swedish decimal comma). */
export function formatUsd(x: number, locale: "sv" | "en" = "sv"): string {
  const n = (Math.max(0.01, Math.ceil(x * 100 - 1e-9) / 100)).toFixed(2);
  return `≈ ${locale === "en" ? n : n.replace(".", ",")} USD`;
}

/** A picked Doc that is one of Simon Says' own meeting Docs: its meeting is already in the history. */
export const OWN_DOC_MESSAGE = "Det här är ett av Simon Says egna mötesdokument; det mötet finns redan med.";
