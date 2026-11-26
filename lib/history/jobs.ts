import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOverviewInput } from "@/lib/dashboard/load";
import { recordClaudeUsage } from "@/lib/db/claude-usage";
import type { NotesClient, NotesUsage } from "@/lib/notes/engine";
import { buildBatchRequest, countsOf, itemIdOf, readBatchResult, type BatchClient } from "./batch";
import { digestGoals } from "./digest";
import { MAX_HISTORY_CHARS, mergeHistory, ownHistory, splitForApproval } from "./digest-input";
import { protocolDate } from "./extract-prompt";
import type { BatchCounts, ItemState, ItemView, JobProposal, JobStatus, JobView } from "./progress";
import { loadImportedHistory } from "./store";
import type { HistoryMeeting } from "./types";

// Protocol import jobs (0036). Every function takes the SERVICE-ROLE client: the routes check
// that the caller is an admin of the förening first; the cron has no user at all.
//
// A batch job moves running → (canceling →) [results saved] → digesting → done, one step per
// call of advanceJob, so each step fits one request:
//   - poll (cheap, also from the status request, at most every POLL_MS): Anthropic's
//     request_counts onto the job;
//   - when the batch has ended: under the job's lease, every result is read, cleaned exactly as
//     on the direct path (cleanExtraction: names scrubbed, labels filtered, lines cut) and saved
//     with save_history_protocol_as; the item row's transition out of 'reading' is the
//     idempotency point (a result is saved and billed once even if two workers overlap after a
//     lease expired), and usage is recorded on the org once, at half price;
//   - digesting (cron only: up to ~4 minutes): ONE goals digest over the whole history, stored
//     on the job as the proposal the admin opens. Nothing else stores a proposal.

export const POLL_MS = 20_000;
const SAVE_LEASE_S = 240;
const DIGEST_LEASE_S = 300;

interface JobRow {
  id: string;
  org_id: string;
  created_by: string | null;
  mode: "direct" | "batch";
  status: JobStatus;
  via_listing: boolean;
  total: number;
  estimate_usd: number | string;
  cost_usd: number | string;
  batch_id: string | null;
  counts: BatchCounts | null;
  polled_at: string | null;
  proposal: JobProposal | null;
  proposal_error: string | null;
  failure: string | null;
  created_at: string;
  ended_at: string | null;
  finished_at: string | null;
  seen_at: string | null;
}

interface ItemRow {
  id: number;
  position: number;
  drive_file_id: string;
  section: number;
  sections: number;
  label: string;
  state: ItemState;
  reason: string | null;
  heading_date: string | null;
  date_inferred: boolean;
  file_date: string | null;
  protocol_id: string | null;
  meeting_date: string | null;
  date_from: "doc" | "file" | "admin" | null;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
}

const JOB_COLUMNS =
  "id, org_id, created_by, mode, status, via_listing, total, estimate_usd, cost_usd, batch_id, counts, polled_at, proposal, proposal_error, failure, created_at, ended_at, finished_at, seen_at";
const ITEM_COLUMNS =
  "id, position, drive_file_id, section, sections, label, state, reason, heading_date, date_inferred, file_date, protocol_id, meeting_date, date_from, attempts, started_at, finished_at";

export async function loadJob(db: SupabaseClient, jobId: string): Promise<JobRow | null> {
  const { data, error } = await db.from("history_import_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  if (error) throw new Error(`import job: ${error.message}`);
  return (data as JobRow | null) ?? null;
}

export async function loadItems(db: SupabaseClient, jobId: string): Promise<ItemRow[]> {
  const { data, error } = await db.from("history_import_items").select(ITEM_COLUMNS).eq("job_id", jobId).order("position");
  if (error) throw new Error(`import items: ${error.message}`);
  return (data ?? []) as ItemRow[];
}

export function toView(job: JobRow, items: ItemRow[]): JobView {
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    total: job.total,
    createdAt: job.created_at,
    endedAt: job.ended_at,
    finishedAt: job.finished_at,
    estimateUsd: Number(job.estimate_usd),
    costUsd: Number(job.cost_usd),
    counts: job.counts,
    items: items.map(
      (i): ItemView => ({
        id: i.id,
        label: i.label,
        state: i.state,
        reason: i.reason,
        protocolId: i.protocol_id,
        date: i.meeting_date,
        dateFrom: i.date_from,
        startedAt: i.started_at,
        finishedAt: i.finished_at,
      }),
    ),
    proposal: job.proposal,
    proposalError: job.proposal_error,
    failure: job.failure,
  };
}

export async function jobView(db: SupabaseClient, jobId: string): Promise<JobView | null> {
  const job = await loadJob(db, jobId);
  return job ? toView(job, await loadItems(db, jobId)) : null;
}

/** The job the Översikt shows: one still open, else the latest finished one the admin has not closed. */
export async function currentJobId(db: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await db
    .from("history_import_jobs")
    .select("id, status, seen_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`import job: ${error.message}`);
  const row = (data ?? [])[0] as { id: string; status: JobStatus; seen_at: string | null } | undefined;
  return row && !row.seen_at ? row.id : null;
}

// ---------------------------------------------------------------------------------------------
// Creating

/** One meeting of the pick, as the routes hand it over. */
export interface NewItem {
  docId: string;
  section: number;
  sections: number;
  label: string;
  /** Skipped before sending (own Doc, empty, too long …). */
  skip?: string;
  /** Batch only: the text to send (never stored) and what the cron needs for the date. */
  part?: { title: string; text: string; date: string | null; dateInferred: boolean };
  fileDate?: string | null;
}

export type CreateResult = { ok: true; jobId: string } | { ok: false; error: "busy" | "rate_limited" | "spend" | "submit" | "error" };

async function insertJob(
  db: SupabaseClient,
  input: { orgId: string; userId: string; mode: "direct" | "batch"; viaListing: boolean; estimateUsd: number; spendRoom: number; items: NewItem[] },
): Promise<CreateResult> {
  const { data, error } = await db.rpc("create_history_import_job", {
    p_org_id: input.orgId,
    p_created_by: input.userId,
    p_mode: input.mode,
    p_via_listing: input.viaListing,
    p_estimate_usd: Math.round(input.estimateUsd * 10_000) / 10_000,
    p_spend_room: Math.max(0, Math.round(input.spendRoom * 10_000) / 10_000),
    p_items: input.items.map((i) => ({
      drive_file_id: i.docId,
      section: i.section,
      sections: i.sections,
      label: i.label.slice(0, 240) || "Dokument",
      ...(i.skip ? { state: "skipped", reason: i.skip } : {}),
      ...(i.part ? { heading_date: i.part.date ?? "", date_inferred: i.part.dateInferred } : {}),
      ...(i.fileDate ? { file_date: i.fileDate } : {}),
    })),
  });
  if (error) {
    const code = error.hint ?? error.message;
    if (code === "busy" || code === "rate_limited" || code === "spend") return { ok: false, error: code };
    console.error(`import job: create: ${error.message}`.slice(0, 200));
    return { ok: false, error: "error" };
  }
  return { ok: true, jobId: data as string };
}

/** A direct job: the browser drives the items (no Doc is read here). */
export function createDirectJob(db: SupabaseClient, input: { orgId: string; userId: string; viaListing: boolean; estimateUsd: number; items: NewItem[] }) {
  return insertJob(db, { ...input, mode: "direct", spendRoom: 0 });
}

/**
 * A batch job: the job and its items are written first (the claim on the 500 per 24 h and on the
 * day's spend room), then ONE Anthropic batch with every sendable meeting is created. If that
 * fails, the job is marked failed and no longer counts. The text in `part` is sent and dropped.
 */
export async function createBatchJob(
  db: SupabaseClient,
  client: BatchClient,
  input: { orgId: string; userId: string; viaListing: boolean; estimateUsd: number; spendRoom: number; items: NewItem[] },
): Promise<CreateResult> {
  const created = await insertJob(db, { ...input, mode: "batch" });
  if (!created.ok) return created;
  const jobId = created.jobId;
  const rows = await loadItems(db, jobId);
  const requests = rows.flatMap((r) => {
    const part = r.state === "waiting" ? input.items[r.position]?.part : undefined;
    return part ? [buildBatchRequest(r.id, part)] : [];
  });
  try {
    if (!requests.length) throw new Error("nothing to send");
    const batch = await client.messages.batches.create({ requests });
    const now = new Date().toISOString();
    await must(db.from("history_import_jobs").update({ batch_id: batch.id, counts: countsOf(batch), polled_at: now }).eq("id", jobId));
    await must(db.from("history_import_items").update({ state: "reading", started_at: now }).eq("job_id", jobId).eq("state", "waiting"));
    console.info(`import job: batch of ${requests.length} submitted`);
    return { ok: true, jobId };
  } catch (err) {
    console.error(`import job: submit: ${(err as Error).message}`.slice(0, 200));
    const now = new Date().toISOString();
    await db.from("history_import_items").update({ state: "failed", reason: "error", finished_at: now }).eq("job_id", jobId).eq("state", "waiting");
    await db.from("history_import_jobs").update({ status: "failed", failure: "submit", finished_at: now }).eq("id", jobId);
    return { ok: false, error: "submit" };
  }
}

async function must<T extends { error: { message: string } | null }>(q: PromiseLike<T>): Promise<T> {
  const res = await q;
  if (res.error) throw new Error(res.error.message);
  return res;
}

// ---------------------------------------------------------------------------------------------
// Advancing a batch job

async function lease(db: SupabaseClient, jobId: string, seconds: number): Promise<boolean> {
  const { data, error } = await db.rpc("lease_history_import_job", { p_job_id: jobId, p_seconds: seconds });
  if (error) throw new Error(`import job: lease: ${error.message}`);
  return data === true;
}

const release = (db: SupabaseClient, jobId: string) => db.from("history_import_jobs").update({ lease_until: null }).eq("id", jobId);

export interface AdvanceOptions {
  client: BatchClient;
  /** The cron: may run the goals digest (minutes). The status request never does. */
  digest?: boolean;
  /** Poll even when the last poll is recent (the cron). */
  force?: boolean;
  notesClient?: NotesClient;
  now?: Date;
}

/** One step for one job. Returns what happened (for logs and tests). */
export async function advanceJob(db: SupabaseClient, jobId: string, opts: AdvanceOptions): Promise<string> {
  const job = await loadJob(db, jobId);
  if (!job || job.mode !== "batch") return "skip";
  const now = opts.now ?? new Date();
  if (job.status === "running" || job.status === "canceling") {
    if (!job.batch_id) return "skip";
    if (!opts.force && job.polled_at && now.getTime() - Date.parse(job.polled_at) < POLL_MS) return "recent";
    const batch = await opts.client.messages.batches.retrieve(job.batch_id);
    await must(db.from("history_import_jobs").update({ counts: countsOf(batch), polled_at: now.toISOString() }).eq("id", jobId));
    if (batch.processing_status !== "ended") return "polled";
    if (!(await lease(db, jobId, SAVE_LEASE_S))) return "leased";
    try {
      return await saveResults(db, job, opts.client, now);
    } finally {
      await release(db, jobId);
    }
  }
  if (job.status === "digesting" && opts.digest) {
    if (!(await lease(db, jobId, DIGEST_LEASE_S))) return "leased";
    try {
      return await runDigest(db, job, opts.notesClient, now);
    } finally {
      await release(db, jobId);
    }
  }
  return "skip";
}

async function saveResults(db: SupabaseClient, job: JobRow, client: BatchClient, now: Date): Promise<string> {
  const items = new Map((await loadItems(db, job.id)).map((i) => [i.id, i]));
  const people = await orgPeople(db, job.org_id);
  const total: NotesUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  let saved = 0;
  const finish = async (item: ItemRow, patch: Record<string, unknown>) => {
    // The transition out of 'reading' is the idempotency point: only one worker gets the row.
    const { data, error } = await db
      .from("history_import_items")
      .update({ ...patch, finished_at: now.toISOString() })
      .eq("id", item.id)
      .eq("state", "reading")
      .select("id");
    if (error) throw new Error(`import item: ${error.message}`);
    return (data ?? []).length === 1;
  };

  for await (const r of await client.messages.batches.results(job.batch_id!)) {
    const id = itemIdOf(r.custom_id);
    const item = id === null ? undefined : items.get(id);
    if (!item || item.state !== "reading") continue;
    const out = readBatchResult(r.result, people, now);
    const usd = out.usage?.usd ?? 0;
    const add = (u: NotesUsage | null) => {
      if (!u) return;
      total.input += u.input;
      total.output += u.output;
      total.cacheRead += u.cacheRead;
      total.cacheWrite += u.cacheWrite;
      total.usd += u.usd;
    };
    if (!out.ok) {
      const skipped = out.reason === "canceled";
      if (await finish(item, { state: skipped ? "skipped" : "failed", reason: out.reason, usd })) add(out.usage);
      continue;
    }
    const when = protocolDate(out.protocol.date, item.heading_date, item.date_inferred, item.file_date, now);
    if (!when) {
      if (await finish(item, { state: "failed", reason: "no_date", usd })) add(out.usage);
      continue;
    }
    const { data: protocolId, error } = await db.rpc("save_history_protocol_as", {
      p_org_id: job.org_id,
      p_imported_by: job.created_by,
      p_drive_file_id: item.drive_file_id,
      p_section: item.section,
      p_sections: item.sections,
      p_meeting_date: when.date,
      p_date_from: when.dateFrom,
      p_items: out.protocol.items,
    });
    if (error) {
      console.error(`import job: save: ${error.message}`.slice(0, 200));
      if (await finish(item, { state: "failed", reason: "save_failed", usd })) add(out.usage);
      continue;
    }
    if (await finish(item, { state: "done", reason: null, protocol_id: protocolId, meeting_date: when.date, date_from: when.dateFrom, usd })) {
      add(out.usage);
      saved++;
    }
  }
  // A request Anthropic never reported back (should not happen): failed, retryable.
  await db.from("history_import_items").update({ state: "failed", reason: "error", finished_at: now.toISOString() }).eq("job_id", job.id).eq("state", "reading");

  if (total.usd > 0 || total.input > 0) {
    try {
      await recordClaudeUsage(job.org_id, total);
    } catch (e) {
      console.error(`import job: usage: ${(e as Error).message}`.slice(0, 200));
    }
  }
  // A cancelled batch keeps what was already read, without a digest (the admin stopped it).
  const status: JobStatus = job.status === "canceling" ? "canceled" : saved > 0 ? "digesting" : "done";
  await must(
    db
      .from("history_import_jobs")
      .update({
        status,
        cost_usd: Number(job.cost_usd) + total.usd,
        ended_at: now.toISOString(),
        ...(status === "digesting" ? {} : { finished_at: now.toISOString() }),
      })
      .eq("id", job.id),
  );
  console.info(`import job: ${saved} protocols saved, $${total.usd.toFixed(4)} (batch price), → ${status}`);
  return `saved:${saved}`;
}

async function orgPeople(db: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await db.from("people").select("name").eq("org_id", orgId);
  if (error) throw new Error(`import job: people: ${error.message}`);
  return ((data ?? []) as { name: string }[]).map((p) => p.name);
}

/**
 * The newest meetings that fit the digest (MAX_HISTORY_CHARS): with hundreds of imported
 * protocols the whole history can be too long for one call; the oldest are left out (the digest
 * reads the newest anyway to set every goal's status) and the admin is told how many.
 */
export function fitHistory(history: HistoryMeeting[], max = MAX_HISTORY_CHARS): { history: HistoryMeeting[]; trimmed: number } {
  let size = 2;
  let keep = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    size += JSON.stringify(history[i]).length + 1;
    if (size > max) break;
    keep++;
  }
  return { history: history.slice(history.length - keep), trimmed: history.length - keep };
}

async function runDigest(db: SupabaseClient, job: JobRow, notesClient: NotesClient | undefined, now: Date): Promise<string> {
  const finishWith = (patch: Record<string, unknown>) =>
    must(db.from("history_import_jobs").update({ status: "done", finished_at: now.toISOString(), ...patch }).eq("id", job.id));
  let merged: HistoryMeeting[];
  let names: string[];
  try {
    const [input, imported] = await Promise.all([loadOverviewInput(db, job.org_id), loadImportedHistory(db, job.org_id)]);
    names = input.people.map((p) => p.name);
    merged = mergeHistory(imported, ownHistory(job.org_id, input));
  } catch (err) {
    console.error(`import job: history: ${(err as Error).message}`.slice(0, 200));
    await finishWith({ proposal_error: "error" });
    return "digest:error";
  }
  const { history, trimmed } = fitHistory(merged);
  if (history.length < 3) {
    await finishWith({ proposal_error: "too_few" });
    return "digest:too_few";
  }
  const res = await digestGoals({ orgId: job.org_id, history, names }, { client: notesClient });
  if (!res.ok) {
    await finishWith({ proposal_error: res.error, cost_usd: Number(job.cost_usd) + (res.usage?.usd ?? 0) });
    return `digest:${res.error}`;
  }
  const { approve, others } = splitForApproval(res.goals);
  const proposal: JobProposal = { goals: approve, explanation: res.explanation, others, meetings: history.length, trimmed };
  await finishWith({ proposal, proposal_error: null, cost_usd: Number(job.cost_usd) + res.usage.usd });
  console.info(`import job: digest over ${history.length} meetings (${trimmed} oldest left out), ${res.goals.length} goals`);
  return "digest:ok";
}

// ---------------------------------------------------------------------------------------------
// Cancelling

/** Batch: asks Anthropic to stop (results already done are still saved). Direct: stops at once. */
export async function cancelJob(db: SupabaseClient, job: JobRow, client: BatchClient): Promise<boolean> {
  const now = new Date().toISOString();
  if (job.mode === "batch" && job.status === "running" && job.batch_id) {
    const batch = await client.messages.batches.cancel(job.batch_id);
    await must(db.from("history_import_jobs").update({ status: "canceling", counts: countsOf(batch), polled_at: now }).eq("id", job.id).eq("status", "running"));
    return true;
  }
  if (job.mode === "direct" && job.status === "running") {
    await must(db.from("history_import_items").update({ state: "skipped", reason: "canceled", finished_at: now }).eq("job_id", job.id).eq("state", "waiting"));
    await must(db.from("history_import_jobs").update({ status: "canceled", finished_at: now }).eq("id", job.id).eq("status", "running"));
    return true;
  }
  return false;
}

/** Direct: all items finished → the job is done (the browser then asks for goals as before). */
export async function closeDirectJobIfFinished(db: SupabaseClient, jobId: string): Promise<void> {
  const { count, error } = await db
    .from("history_import_items")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .in("state", ["waiting", "reading"]);
  if (error) throw new Error(`import job: ${error.message}`);
  if (!count) {
    await db.from("history_import_jobs").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", jobId).eq("status", "running");
  }
}

/** Every open batch job, oldest first (the cron). */
export async function openBatchJobIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from("history_import_jobs")
    .select("id")
    .eq("mode", "batch")
    .in("status", ["running", "canceling", "digesting"])
    .order("created_at")
    .limit(50);
  if (error) throw new Error(`import jobs: ${error.message}`);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}
