// Limits of the protocol import (todo #7), shared by the routes and the Översikt.

/** Protocols per pick (and per estimate request). */
export const MAX_IMPORT_DOCS = 60;
/** 0032 claim_history_import: protocols read per förening per 24 h. */
export const IMPORT_RATE_LIMITED = "Simon Says har läst 60 protokoll åt föreningen det senaste dygnet. Fortsätt i morgon.";

/** "≈ 0,40 USD" (two decimals rounded up, at least 0,01; Swedish decimal comma). */
export function formatUsd(x: number): string {
  return `≈ ${(Math.max(0.01, Math.ceil(x * 100 - 1e-9) / 100)).toFixed(2).replace(".", ",")} USD`;
}

/** A picked Doc that is one of Simon Says' own meeting Docs: its meeting is already in the history. */
export const OWN_DOC_MESSAGE = "Det här är ett av Simon Says egna mötesdokument; det mötet finns redan med.";
