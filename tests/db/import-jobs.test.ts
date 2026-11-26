import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BatchCreateParams, MessageBatch, MessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/messages/batches";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { createOrg, joinOrg } from "@/lib/db/orgs";

// Protocol import jobs (0036) against the local stack, with a FAKE Anthropic batch client and a
// scripted digest. Fictional föreningar and names only; no API call.

const env = { KILL_SWITCH: false, GLOBAL_DAILY_USD: 25, ANTHROPIC_API_KEY: "test" };
const usage: { orgId: string; usd: number }[] = [];
vi.mock("@/lib/env", () => ({ getEnv: () => env }));
vi.mock("@/lib/db/usage", () => ({ dayUsd: async () => 0 }));
vi.mock("@/lib/db/claude-usage", () => ({ recordClaudeUsage: async (orgId: string, u: { usd: number }) => void usage.push({ orgId, usd: u.usd }) }));
vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));

const { advanceJob, cancelJob, createBatchJob, createDirectJob, currentJobId, failStaleSubmits, jobView, loadJob } = await import("@/lib/history/jobs");
const { scriptedClient } = await import("@/scripts/lib/goals-scripted");

type Result = MessageBatchIndividualResponse["result"];

/** The slice of `client.messages.batches` the import uses, in memory. */
function fakeBatches() {
  const s = {
    created: [] as BatchCreateParams[],
    status: "in_progress" as MessageBatch["processing_status"],
    processing: 0,
    canceled: false,
    results: new Map<string, Result>(),
    resultsCalls: 0,
  };
  const batch = (): MessageBatch =>
    ({
      id: `msgbatch_fake${s.created.length}`,
      processing_status: s.status,
      request_counts: { processing: s.processing, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    }) as unknown as MessageBatch;
  const client = {
    messages: {
      batches: {
        create: async (b: BatchCreateParams) => {
          s.created.push(b);
          s.processing = b.requests.length;
          s.status = "in_progress";
          return batch();
        },
        retrieve: async () => batch(),
        cancel: async () => {
          s.canceled = true;
          s.status = "canceling";
          return batch();
        },
        results: async () => {
          s.resultsCalls++;
          const all = [...s.results.entries()].map(([custom_id, result]) => ({ custom_id, result }) as MessageBatchIndividualResponse);
          return (async function* () {
            yield* all;
          })();
        },
      },
    },
  };
  return { s, client };
}

const succeeded = (body: unknown, stop = "end_turn"): Result =>
  ({
    type: "succeeded",
    message: {
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(body) }],
      stop_reason: stop,
      usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) as unknown as Result;

const answer = (date: string | null, decision: string) => ({
  date,
  topics: ["Höstturneringen"],
  decisions: [{ text: decision, topic: "Höstturneringen" }],
  tasks: [{ text: "Ture Lindqvist bokar aulan", owner: "Kassör", done: false, topic: "Höstturneringen" }],
  reports: [],
  names: ["Ture Lindqvist"],
});

const part = (text: string, date: string | null = null, dateInferred = false) => ({ title: "Protokoll", text, date, dateInferred });

describe.skipIf(!hasLocalSupabase)("protocol import jobs (0036)", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;

  beforeAll(async () => {
    [admin, member] = await Promise.all([createTestUser("ijadmin"), createTestUser("ijmember")]);
    const r = await createOrg(admin.db, "Brädspelsföreningen Rutan");
    if (!r.ok) throw new Error("org setup failed");
    orgId = r.id;
    const { data } = await adminClient().from("orgs").select("invite_code").eq("id", orgId).single();
    expect(await joinOrg(member.db, data!.invite_code as string)).toBe(orgId);
  });

  it("a batch import: one batch, results saved once (cleaned, dated), one digest, the proposal stored", async () => {
    const db = adminClient();
    const fake = fakeBatches();
    const created = await createBatchJob(db, fake.client, {
      orgId,
      userId: admin.id,
      viaListing: true,
      estimateUsd: 1.2,
      spendRoom: 10,
      items: [
        { docId: "doc-rutan-aaaa", section: 0, sections: 3, label: "Styrelsen 2025, möte 1 av 3", part: part("§1 Höstturneringen", "2025-09-02") },
        { docId: "doc-rutan-aaaa", section: 1, sections: 3, label: "Styrelsen 2025, möte 2 av 3", part: part("§1 Höstturneringen", "2025-10-07") },
        { docId: "doc-rutan-aaaa", section: 2, sections: 3, label: "Styrelsen 2025, möte 3 av 3", part: part("§1 Höstturneringen", "2025-11-04") },
        { docId: "doc-rutan-bbbb", section: 0, sections: 1, label: "Utan datum", part: part("§1 Höstturneringen"), fileDate: "2025-08-20" },
        { docId: "doc-rutan-cccc", section: 0, sections: 1, label: "Mötesanteckningar – Simon Says", skip: "own_doc" },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.jobId;
    expect(fake.s.created).toHaveLength(1);
    const ids = fake.s.created[0].requests.map((r) => r.custom_id);
    expect(ids).toHaveLength(4);
    expect(ids.every((c) => /^i\d+$/.test(c))).toBe(true);
    expect(JSON.stringify(fake.s.created[0])).not.toContain("fallbacks");

    let view = (await jobView(db, jobId))!;
    expect(view).toMatchObject({ mode: "batch", status: "running", total: 5 });
    expect(view.items.map((i) => i.state)).toEqual(["reading", "reading", "reading", "reading", "skipped"]);
    expect(view.items[4]).toMatchObject({ reason: "own_doc", label: "Mötesanteckningar – Simon Says" });
    expect(await currentJobId(db, orgId)).toBe(jobId);

    // One open import per förening.
    const busy = await createDirectJob(db, { orgId, userId: admin.id, viaListing: false, estimateUsd: 0, items: [{ docId: "doc-rutan-dddd", section: 0, sections: 1, label: "x" }] });
    expect(busy).toEqual({ ok: false, error: "busy" });

    // Still processing: counts only.
    expect(await advanceJob(db, jobId, { client: fake.client, force: true })).toBe("polled");
    expect((await loadJob(db, jobId))!.counts).toMatchObject({ processing: 4 });
    expect(fake.s.resultsCalls).toBe(0);

    // Ended: results in any order; the no-date one falls back to the file's date.
    fake.s.status = "ended";
    fake.s.processing = 0;
    fake.s.results.set(ids[3], succeeded(answer(null, "Turneringen planeras")));
    fake.s.results.set(ids[0], succeeded(answer("2025-09-02", "Föreningen arrangerar en höstturnering")));
    fake.s.results.set(ids[2], succeeded(answer("2025-11-04", "Turneringen genomfördes")));
    fake.s.results.set(ids[1], succeeded(answer("2025-10-07", "x"), "refusal"));
    expect(await advanceJob(db, jobId, { client: fake.client, force: true })).toBe("saved:3");
    view = (await jobView(db, jobId))!;
    expect(view.status).toBe("digesting");
    expect(view.items.map((i) => [i.state, i.reason])).toEqual([
      ["done", null],
      ["failed", "refusal"],
      ["done", null],
      ["done", null],
      ["skipped", "own_doc"],
    ]);
    expect(view.items[3]).toMatchObject({ date: "2025-08-20", dateFrom: "file" });
    expect(view.costUsd).toBeGreaterThan(0);
    expect(usage).toHaveLength(1);
    expect(usage[0].orgId).toBe(orgId);

    const { data: items } = await db.from("history_items").select("text, owner").eq("org_id", orgId);
    expect(JSON.stringify(items)).not.toMatch(/Ture|Lindqvist/);
    const { count } = await db.from("history_protocols").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    expect(count).toBe(3);

    // A second worker after the fact changes nothing (no second save, no second bill).
    expect(await advanceJob(db, jobId, { client: fake.client, force: true })).toBe("skip");
    expect(usage).toHaveLength(1);

    // The digest runs once (cron only) and the proposal is stored on the job.
    const digest = scriptedClient([
      {
        goals: [
          {
            title: "Höstturnering i Catan",
            status: "achieved",
            why: "Genomförd i november 2025.",
            earlier_names: [],
            first_mentioned: "2025-09-02",
            last_mentioned: "2025-11-04",
            evidence: [
              { date: "2025-09-02", text: "Beslut om höstturnering" },
              { date: "2025-11-04", text: "Turneringen genomfördes" },
            ],
          },
        ],
        explanation: "Ett mål, nått.",
      },
    ]);
    expect(await advanceJob(db, jobId, { client: fake.client, digest: true, notesClient: digest })).toBe("digest:ok");
    expect(digest.calls).toBe(1);
    view = (await jobView(db, jobId))!;
    expect(view.status).toBe("done");
    expect(view.proposal).toMatchObject({ meetings: 3, trimmed: 0, explanation: "Ett mål, nått." });
    expect(view.proposal!.others.map((g) => g.title)).toEqual(["Höstturnering i Catan"]);
    expect(await advanceJob(db, jobId, { client: fake.client, digest: true, notesClient: digest })).toBe("skip");
    expect(digest.calls).toBe(1);

    // Admins read their jobs; members do not.
    expect((await admin.db.from("history_import_jobs").select("id").eq("org_id", orgId)).data).toHaveLength(1);
    expect((await member.db.from("history_import_jobs").select("id").eq("org_id", orgId)).data).toHaveLength(0);
    expect((await member.db.from("history_import_items").select("id").eq("org_id", orgId)).data).toHaveLength(0);
    // Nobody writes them directly.
    expect((await admin.db.from("history_import_jobs").update({ status: "failed" }).eq("id", jobId).select("id")).data ?? []).toHaveLength(0);

    await db.from("history_import_jobs").update({ seen_at: new Date().toISOString() }).eq("id", jobId);
    expect(await currentJobId(db, orgId)).toBeNull();
  });

  it("cancel: Anthropic is asked to stop, finished results are kept, no digest", async () => {
    const db = adminClient();
    const fake = fakeBatches();
    const created = await createBatchJob(db, fake.client, {
      orgId,
      userId: admin.id,
      viaListing: false,
      estimateUsd: 0.5,
      spendRoom: 10,
      items: [
        { docId: "doc-rutan-eeee", section: 0, sections: 2, label: "Våren, möte 1 av 2", part: part("§1 Spelkafé", "2025-03-04") },
        { docId: "doc-rutan-eeee", section: 1, sections: 2, label: "Våren, möte 2 av 2", part: part("§1 Spelkafé", "2025-04-01") },
      ],
    });
    if (!created.ok) throw new Error(created.error);
    const job = (await loadJob(db, created.jobId))!;
    expect(await cancelJob(db, job, fake.client)).toBe(true);
    expect(fake.s.canceled).toBe(true);
    expect((await loadJob(db, created.jobId))!.status).toBe("canceling");
    const ids = fake.s.created[0].requests.map((r) => r.custom_id);
    fake.s.status = "ended";
    fake.s.results.set(ids[0], succeeded(answer("2025-03-04", "Starta spelkafé")));
    fake.s.results.set(ids[1], { type: "canceled" } as Result);
    expect(await advanceJob(db, created.jobId, { client: fake.client, force: true })).toBe("saved:1");
    const view = (await jobView(db, created.jobId))!;
    expect(view.status).toBe("canceled");
    expect(view.items.map((i) => [i.state, i.reason])).toEqual([
      ["done", null],
      ["skipped", "canceled"],
    ]);
  });

  it("limits: the day's spend room for imports, 500 meetings per förening per 24 h; a failed submit does not count", async () => {
    const db = adminClient();
    const fake = fakeBatches();
    const one = [{ docId: "doc-rutan-ffff", section: 0, sections: 1, label: "Ett möte", part: part("§1 x", "2025-01-01") }];
    expect(await createBatchJob(db, fake.client, { orgId, userId: admin.id, viaListing: false, estimateUsd: 3, spendRoom: 2, items: one })).toEqual({ ok: false, error: "spend" });
    expect(fake.s.created).toHaveLength(0);

    const broken = {
      messages: { batches: { ...fake.client.messages.batches, create: async () => Promise.reject(new Error("RateLimitError: 429")) } },
    };
    const failed = await createBatchJob(db, broken, { orgId, userId: admin.id, viaListing: false, estimateUsd: 0.1, spendRoom: 10, items: one });
    expect(failed).toEqual({ ok: false, error: "submit" });

    // Sent so far in batches: 4 + 2 (skipped and failed ones do not count). 495 more passes 500.
    const batchOf = (n: number) => Array.from({ length: n }, (_, k) => ({ docId: "doc-rutan-gggg", section: k % 60, sections: 60, label: `Möte ${k}`, part: part("x", "2025-01-01") }));
    expect(await createBatchJob(db, fake.client, { orgId, userId: admin.id, viaListing: false, estimateUsd: 0.1, spendRoom: 10, items: batchOf(495) })).toEqual({ ok: false, error: "rate_limited" });
    const fits = await createBatchJob(db, fake.client, { orgId, userId: admin.id, viaListing: false, estimateUsd: 0.1, spendRoom: 10, items: batchOf(494) });
    expect(fits.ok).toBe(true);
  });

  it("direct: a new import replaces one whose page was closed; cancel skips what had not started", async () => {
    const db = adminClient();
    await db.from("history_import_jobs").update({ status: "done", finished_at: new Date().toISOString() }).eq("org_id", orgId).in("status", ["running", "canceling", "digesting"]);
    const items = [
      { docId: "doc-rutan-hhhh", section: 0, sections: 1, label: "Höst" },
      { docId: "doc-rutan-iiii", section: 0, sections: 1, label: "Vår" },
    ];
    const first = await createDirectJob(db, { orgId, userId: admin.id, viaListing: true, estimateUsd: 0, items });
    if (!first.ok) throw new Error(first.error);
    const second = await createDirectJob(db, { orgId, userId: admin.id, viaListing: true, estimateUsd: 0, items });
    if (!second.ok) throw new Error(second.error);
    const old = (await jobView(db, first.jobId))!;
    expect(old.status).toBe("canceled");
    expect(old.items.map((i) => i.reason)).toEqual(["replaced", "replaced"]);
    const fake = fakeBatches();
    expect(await cancelJob(db, (await loadJob(db, second.jobId))!, fake.client)).toBe(true);
    const view = (await jobView(db, second.jobId))!;
    expect(view.status).toBe("canceled");
    expect(view.items.map((i) => [i.state, i.reason])).toEqual([
      ["skipped", "canceled"],
      ["skipped", "canceled"],
    ]);
  });

  it("the digest runs at most once: a run that died mid-digest is closed, not paid again; a submit that never finished is failed", async () => {
    const db = adminClient();
    await db.from("history_import_jobs").update({ status: "done", finished_at: new Date().toISOString() }).eq("org_id", orgId).in("status", ["running", "canceling", "digesting"]);
    const fake = fakeBatches();
    const created = await createBatchJob(db, fake.client, {
      orgId,
      userId: admin.id,
      viaListing: false,
      estimateUsd: 0.2,
      spendRoom: 10,
      items: [{ docId: "doc-rutan-jjjj", section: 0, sections: 1, label: "Dokument 1", part: part("§1 x", "2025-02-02") }],
    });
    if (!created.ok) throw new Error(created.error);
    await db.from("history_import_jobs").update({ status: "digesting", proposal_error: "interrupted" }).eq("id", created.jobId);
    const digest = scriptedClient([{ goals: [], explanation: "" }]);
    expect(await advanceJob(db, created.jobId, { client: fake.client, digest: true, notesClient: digest })).toBe("digest:interrupted");
    expect(digest.calls).toBe(0);
    expect((await loadJob(db, created.jobId))!.status).toBe("done");

    // A job written but never submitted (the request died before Anthropic answered).
    const { data: orphan, error } = await db.rpc("create_history_import_job", {
      p_org_id: orgId,
      p_created_by: admin.id,
      p_mode: "batch",
      p_via_listing: false,
      p_estimate_usd: 0.2,
      p_spend_room: 10,
      p_items: [{ drive_file_id: "doc-rutan-kkkk", label: "Dokument 1" }],
    });
    if (error) throw new Error(error.message);
    expect(await failStaleSubmits(db)).toBe(0);
    expect(await failStaleSubmits(db, new Date(Date.now() + 11 * 60_000))).toBe(1);
    const view = (await jobView(db, orphan as string))!;
    expect(view).toMatchObject({ status: "failed", failure: "submit" });
    expect(view.items[0]).toMatchObject({ state: "failed", reason: "error" });
  });
});
