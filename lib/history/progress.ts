import type { GoalSuggestion } from "./digest-input";

// The protocol import's progress (0036 jobs), shared by the server (the job view) and the
// import page. Pure, no server imports. The point of this file: every state the admin sees has
// a number and says what is happening; an estimate is shown only once there is throughput to
// base it on, and until then the view says so plainly.

/** Up to this many meetings the browser reads them directly, a few at a time. */
export const DIRECT_MAX = 20;
/** How many meetings the browser reads at once on the direct path. */
export const DIRECT_CONCURRENCY = 5;
/** Meetings per förening per 24 h through the batch path (0036 create_history_import_job). */
export const MAX_BATCH_PROTOCOLS = 500;
/**
 * Share of the global daily Claude cap that imports may plan for: in-flight batch estimates plus
 * today's spend must stay under it, so a large import landing never stops live notes.
 */
export const BATCH_SPEND_SHARE = 0.6;
/** A direct "läses" row older than this is a request that died with its page: retryable. */
export const STALE_READING_MS = 3 * 60_000;

export type ImportMode = "direct" | "batch";
export const importMode = (protocols: number): ImportMode => (protocols > DIRECT_MAX ? "batch" : "direct");

export type ItemState = "waiting" | "reading" | "done" | "skipped" | "failed";
export type JobStatus = "running" | "canceling" | "digesting" | "done" | "canceled" | "failed";

/** Why a meeting was skipped or failed, in the admin's words. Unknown codes get a general line. */
export const REASON_MESSAGES: Record<string, string> = {
  own_doc: "Simon Says eget mötesdokument; mötet finns redan med.",
  empty: "Dokumentet är tomt.",
  too_long: "För långt för att vara ett protokoll.",
  "many-meetings": "Dokumentet verkar innehålla flera möten som inte gick att skilja åt.",
  "too-many": "Dokumentet innehåller fler än 60 möten.",
  doc_changed: "Dokumentet har ändrats sedan du valde det.",
  doc_unreadable: "Simon Says kan inte läsa dokumentet längre.",
  google_auth_lost: "Åtkomsten till Google Drive har gått ut. Ge åtkomst igen och försök på nytt.",
  no_date: "Inget datum hittades i protokollet.",
  refusal: "Claude ville inte läsa just det här protokollet.",
  malformed: "Svaret från Claude gick inte att använda.",
  error: "Något gick fel när protokollet lästes.",
  expired: "Claude hann inte läsa det inom ett dygn.",
  canceled: "Avbruten.",
  replaced: "Ersatt av en ny inläsning.",
  spend: "Simon Says kan inte läsa protokoll just nu.",
  rate_limited: "Dagens gräns för föreningen är nådd.",
  save_failed: "Kunde inte sparas.",
  unreachable: "Vi nådde inte servern.",
  stale: "Sidan stängdes medan det lästes.",
};

export const reasonMessage = (code: string | null | undefined): string | null =>
  code ? (REASON_MESSAGES[code] ?? REASON_MESSAGES.error) : null;

/** Can "Försök igen" help? (Not for an own Doc, an empty one or a cancelled import.) */
export const retryable = (state: ItemState, reason: string | null): boolean =>
  state === "failed" && !["own_doc", "empty", "too_long", "many-meetings", "too-many"].includes(reason ?? "");

export interface ItemView {
  id: number;
  label: string;
  state: ItemState;
  reason: string | null;
  protocolId: string | null;
  date: string | null;
  dateFrom: "doc" | "file" | "admin" | null;
  /** ISO times. */
  startedAt: string | null;
  finishedAt: string | null;
}

/** Anthropic's request_counts for a batch. */
export interface BatchCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

export interface JobProposal {
  goals: { title: string; why: string | null; evidence?: { date: string; text: string }[] }[];
  explanation: string;
  others: GoalSuggestion[];
  /** Meetings the digest read, and how many of the oldest were left out to fit. */
  meetings: number;
  trimmed: number;
}

export interface JobView {
  id: string;
  mode: ImportMode;
  status: JobStatus;
  total: number;
  createdAt: string;
  endedAt: string | null;
  finishedAt: string | null;
  estimateUsd: number;
  costUsd: number;
  counts: BatchCounts | null;
  items: ItemView[];
  proposal: JobProposal | null;
  proposalError: string | null;
  failure: string | null;
}

export interface Tally {
  waiting: number;
  reading: number;
  done: number;
  skipped: number;
  failed: number;
}

export function tally(items: Pick<ItemView, "state">[]): Tally {
  const t: Tally = { waiting: 0, reading: 0, done: 0, skipped: 0, failed: 0 };
  for (const i of items) t[i.state]++;
  return t;
}

export interface Progress {
  /** Meetings that will be (or were) sent to Claude: total minus those skipped before sending. */
  total: number;
  /** Of those, how many Claude has finished (done or failed; for a running batch: Anthropic's count). */
  finished: number;
  /** Whole minutes left, rounded up; null = no estimate yet (say so, never spin). */
  minutesLeft: number | null;
  /** Why there is no estimate: nothing finished yet, or too early to tell. */
  noEstimate: "none_finished" | "too_early" | null;
}

const MIN_ELAPSED_MS = 45_000;

/** Minutes left from observed throughput: elapsed / finished × remaining. */
export function minutesLeft(finished: number, total: number, elapsedMs: number): { minutes: number | null; why: Progress["noEstimate"] } {
  if (finished >= total) return { minutes: 0, why: null };
  if (finished <= 0) return { minutes: null, why: "none_finished" };
  if (elapsedMs < MIN_ELAPSED_MS) return { minutes: null, why: "too_early" };
  const ms = (elapsedMs / finished) * (total - finished);
  return { minutes: Math.max(1, Math.ceil(ms / 60_000)), why: null };
}

/**
 * The job's progress at `now`. Direct: items done/failed, throughput since the first request
 * started. Batch while running: Anthropic's request_counts (results arrive only when the whole
 * batch ends, but the counts move), throughput since the job was created.
 */
export function jobProgress(job: Pick<JobView, "mode" | "status" | "createdAt" | "counts" | "items">, now: number): Progress {
  const t = tally(job.items);
  const skippedBefore = job.items.filter((i) => i.state === "skipped" && !i.startedAt).length;
  const total = job.items.length - skippedBefore;
  let finished = t.done + t.failed + (t.skipped - skippedBefore);
  let since = Date.parse(job.createdAt);
  if (job.mode === "batch" && (job.status === "running" || job.status === "canceling") && job.counts) {
    finished = Math.max(finished, total - job.counts.processing);
  } else if (job.mode === "direct") {
    const starts = job.items.flatMap((i) => (i.startedAt ? [Date.parse(i.startedAt)] : []));
    if (starts.length) since = Math.min(...starts);
  }
  finished = Math.min(finished, total);
  const { minutes, why } = minutesLeft(finished, total, now - since);
  return { total, finished, minutesLeft: minutes, noEstimate: why };
}

/** "ca 4 min kvar", "under en minut kvar", "ca 1 h 20 min kvar". */
export function formatMinutesLeft(minutes: number): string {
  if (minutes <= 1) return "ca en minut kvar";
  if (minutes < 60) return `ca ${minutes} min kvar`;
  const h = Math.floor(minutes / 60);
  const m = Math.round((minutes % 60) / 5) * 5;
  return m && m < 60 ? `ca ${h} h ${m} min kvar` : `ca ${m === 60 ? h + 1 : h} h kvar`;
}

export const isOpen = (status: JobStatus) => status === "running" || status === "canceling" || status === "digesting";
