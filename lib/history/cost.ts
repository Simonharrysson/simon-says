import { PRICES } from "@/lib/notes/engine";
import { importMode, type ImportMode } from "./progress";

// The cost estimate an admin sees BEFORE confirming an import (todo #7). Local arithmetic only:
// counting tokens with the API would send the protocol text to Anthropic before the admin said
// yes. Calibrated on the paid eval (.superpowers/history-goals/report.md): an extraction call
// costs ≈ 1 900 input tokens of instructions plus the protocol (≈ 3 characters per token for
// Swedish), and ≈ 300 output tokens plus about one per 8 characters of protocol; the digest
// ≈ 1 500 + 250 input and 2 500 + 30 output tokens per meeting. Rounded up, never down.

const CHARS_PER_TOKEN = 3;
const usd = (input: number, output: number) => (input * PRICES.input + output * PRICES.output) / 1e6;

export function extractionUsd(chars: number): number {
  return usd(1900 + chars / CHARS_PER_TOKEN, 300 + chars / 8);
}

export function digestUsd(meetings: number): number {
  return usd(1500 + 250 * meetings, 2500 + 30 * meetings);
}

/** The Message Batches API bills every token at half the standard price. */
export const BATCH_DISCOUNT = 0.5;

export interface ImportEstimate {
  protocols: number;
  /** "direct" (the browser, a few at a time) or "batch" (one Anthropic batch, half price). */
  mode: ImportMode;
  /** Reading every protocol (one call each; halved for a batch). */
  importUsd: number;
  /** One goals digest over them plus `ownMeetings`. */
  digestUsd: number;
  totalUsd: number;
}

/** The digest stays a normal call (full price); only the extraction goes in the batch. */
export function estimateImport(chars: number[], ownMeetings = 0): ImportEstimate {
  const mode = importMode(chars.length);
  const full = chars.reduce((n, c) => n + extractionUsd(c), 0);
  const importUsd = mode === "batch" ? full * BATCH_DISCOUNT : full;
  const d = digestUsd(chars.length + ownMeetings);
  return { protocols: chars.length, mode, importUsd, digestUsd: d, totalUsd: importUsd + d };
}
