// Limits of the protocol import (todo #7), shared by the routes and the Översikt.

/** Docs per pick (and per estimate request); a Doc can hold several meetings. */
export const MAX_IMPORT_DOCS = 150;

/** "≈ 0,40 USD" (two decimals rounded up, at least 0,01; Swedish decimal comma). */
export function formatUsd(x: number, locale: "sv" | "en" = "sv"): string {
  const n = (Math.max(0.01, Math.ceil(x * 100 - 1e-9) / 100)).toFixed(2);
  return `≈ ${locale === "en" ? n : n.replace(".", ",")} USD`;
}

