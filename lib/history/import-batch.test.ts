import { describe, expect, it, vi } from "vitest";
import type { MessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/messages/batches";

// The import's batch path and progress (0036): pure parts and a fake Anthropic batch client.
// Fictional föreningar and names only; no API call.

const env = { KILL_SWITCH: false, GLOBAL_DAILY_USD: 25, ANTHROPIC_API_KEY: "test" };
vi.mock("@/lib/env", () => ({ getEnv: () => env }));
vi.mock("@/lib/db/usage", () => ({ dayUsd: async () => 0 }));
vi.mock("@/lib/db/claude-usage", () => ({ recordClaudeUsage: async () => undefined }));

const { buildBatchRequest, customId, itemIdOf, readBatchResult, batchUsage } = await import("./batch");
const { estimateImport, extractionUsd, BATCH_DISCOUNT } = await import("./cost");
const { protocolDate, EXTRACT_SYSTEM_PROMPT, EXTRACT_JSON_SCHEMA } = await import("./extract-prompt");
const { isBusyDetail, extractProtocol } = await import("./extract");
const { jobProgress, minutesLeft, formatMinutesLeft, importMode, retryable, reasonMessage, tally, DIRECT_MAX } = await import("./progress");
const { fitHistory } = await import("./jobs");
const { messageUsage } = await import("@/lib/notes/engine");

type Result = MessageBatchIndividualResponse["result"];

const answer = (over: Record<string, unknown> = {}) => ({
  date: "2025-09-02",
  topics: ["§1 Mötets öppnande", "Höstturneringen"],
  decisions: [{ text: "Ture Lindqvist bokar aulan till turneringen", topic: "Höstturneringen" }],
  tasks: [{ text: "Hedvig ringer Spelhörnan", owner: "Hedvig", done: false, topic: null }],
  reports: [{ text: "Vi är 41 medlemmar", topic: null }],
  names: ["Ture Lindqvist", "Hedvig Sandberg"],
  ...over,
});

const succeeded = (body: unknown, stop = "end_turn", usage = { input_tokens: 2000, output_tokens: 300 }): Result =>
  ({
    type: "succeeded",
    message: {
      id: "msg_x",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
      stop_reason: stop,
      usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) as unknown as Result;

describe("batch requests", () => {
  it("the same extraction request as the direct path, without stream or fallbacks; custom_id by item row", () => {
    const req = buildBatchRequest(4711, { title: "Protokoll 2/9-25", text: "§1 Öppnande\n§2 Höstturneringen" });
    expect(req.custom_id).toBe("i4711");
    expect(req.custom_id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    const p = req.params as unknown as Record<string, unknown>;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(16_000);
    expect(p.system).toBe(EXTRACT_SYSTEM_PROMPT);
    expect(p.output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema: EXTRACT_JSON_SCHEMA } });
    expect(p).not.toHaveProperty("stream");
    expect(p).not.toHaveProperty("fallbacks");
    expect(p).not.toHaveProperty("betas");
    expect(JSON.stringify(p.messages)).toContain("Höstturneringen");
    expect(itemIdOf(customId(12))).toBe(12);
    expect(itemIdOf("x12")).toBeNull();
    expect(itemIdOf("i")).toBeNull();
  });

  it("a succeeded result is cleaned like the direct path: names scrubbed, numbering stripped", () => {
    const out = readBatchResult(succeeded(answer()), ["Malte Ek"], new Date("2026-11-26T12:00:00Z"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.protocol.date).toBe("2025-09-02");
    const text = out.protocol.items.map((i) => `${i.text} ${i.owner ?? ""} ${i.topic ?? ""}`).join(" | ");
    expect(text).not.toMatch(/Ture|Hedvig|Lindqvist|Sandberg/);
    expect(out.protocol.items.find((i) => i.kind === "topic")?.text).toBe("Mötets öppnande");
    expect(text).toContain("Spelhörnan");
  });

  it("stop_reason before content: a refusal or max_tokens is a failure with its usage", () => {
    expect(readBatchResult(succeeded(answer(), "refusal"), [])).toMatchObject({ ok: false, reason: "refusal" });
    const cut = readBatchResult(succeeded(answer(), "max_tokens"), []);
    expect(cut).toMatchObject({ ok: false, reason: "error" });
    expect(cut.usage?.usd).toBeGreaterThan(0);
    expect(readBatchResult(succeeded("inte json"), [])).toMatchObject({ ok: false, reason: "malformed" });
    expect(readBatchResult(succeeded({ date: 3 }), [])).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("errored, expired and canceled results; canceled never ran", () => {
    expect(readBatchResult({ type: "errored", error: { type: "error", error: { type: "api_error", message: "x" } } } as unknown as Result, [])).toMatchObject({ ok: false, reason: "error", usage: null });
    expect(readBatchResult({ type: "expired" } as Result, [])).toMatchObject({ ok: false, reason: "expired" });
    expect(readBatchResult({ type: "canceled" } as Result, [])).toMatchObject({ ok: false, reason: "canceled", usage: null });
  });

  it("usage is billed at half the standard price", () => {
    const u = { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const full = messageUsage(u as never, "claude-opus-5-5").usd;
    expect(batchUsage(u, "claude-opus-5-5").usd).toBeCloseTo(full / 2, 10);
    expect(BATCH_DISCOUNT).toBe(0.5);
  });
});

describe("estimate and mode", () => {
  it("up to DIRECT_MAX meetings direct at full price; more as a batch at half price (the digest stays full)", () => {
    const small = estimateImport(Array(DIRECT_MAX).fill(3000));
    expect(small.mode).toBe("direct");
    expect(small.importUsd).toBeCloseTo(DIRECT_MAX * extractionUsd(3000), 10);
    const big = estimateImport(Array(DIRECT_MAX + 1).fill(3000));
    expect(big.mode).toBe("batch");
    expect(big.importUsd).toBeCloseTo(((DIRECT_MAX + 1) * extractionUsd(3000)) / 2, 10);
    expect(big.totalUsd).toBeCloseTo(big.importUsd + big.digestUsd, 10);
    expect(importMode(500)).toBe("batch");
  });
});

describe("dates", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  it("Claude's date, else the heading (inferred year → 'file'), else the file's creation date", () => {
    expect(protocolDate("2025-09-02", "2025-01-01", true, "2024-01-01", now)).toEqual({ date: "2025-09-02", dateFrom: "doc" });
    expect(protocolDate(null, "2025-03-04", false, null, now)).toEqual({ date: "2025-03-04", dateFrom: "doc" });
    expect(protocolDate(null, "2025-03-04", true, null, now)).toEqual({ date: "2025-03-04", dateFrom: "file" });
    expect(protocolDate(null, null, false, "2024-02-01", now)).toEqual({ date: "2024-02-01", dateFrom: "file" });
    expect(protocolDate(null, "2031-01-01", false, null, now)).toBeNull();
  });
});

describe("Anthropic busy → back off", () => {
  it("429/529/503 are busy (not run, claim released); other failures are not", async () => {
    expect(isBusyDetail("RateLimitError: 429 rate_limit_error")).toBe(true);
    expect(isBusyDetail("OverloadedError: 529")).toBe(true);
    expect(isBusyDetail("ServiceUnavailableError: 503")).toBe(true);
    expect(isBusyDetail("APIConnectionTimeoutError: timed out")).toBe(false);
    const throwing = (name: string) => {
      class E extends Error {}
      Object.defineProperty(E, "name", { value: name });
      return { beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new E("nope")) }) } } };
    };
    const input = { orgId: null, title: "t", text: "x", people: [] };
    expect(await extractProtocol(input, { client: throwing("RateLimitError") as never })).toMatchObject({ ok: false, error: "busy" });
    expect(await extractProtocol(input, { client: throwing("APIConnectionTimeoutError") as never })).toMatchObject({ ok: false, error: "error" });
  });
});

describe("progress", () => {
  const t0 = Date.parse("2026-11-24T18:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const item = (id: number, state: "waiting" | "reading" | "done" | "skipped" | "failed", startedAt: number | null = null) => ({
    id,
    label: `Möte ${id}`,
    state,
    reason: null,
    protocolId: null,
    date: null,
    dateFrom: null,
    startedAt: startedAt === null ? null : iso(startedAt),
    finishedAt: null,
  });

  it("no estimate until something finished and some time has passed; then elapsed / finished × remaining", () => {
    expect(minutesLeft(0, 10, 600_000)).toEqual({ minutes: null, why: "none_finished" });
    expect(minutesLeft(1, 10, 10_000)).toEqual({ minutes: null, why: "too_early" });
    expect(minutesLeft(5, 10, 5 * 60_000)).toEqual({ minutes: 5, why: null });
    expect(minutesLeft(10, 10, 1)).toEqual({ minutes: 0, why: null });
    expect(minutesLeft(9, 10, 60_000).minutes).toBe(1);
  });

  it("direct: counts done and failed, skipped-before-sending is not in the total, throughput from the first start", () => {
    const job = {
      mode: "direct" as const,
      status: "running" as const,
      createdAt: iso(t0 - 3_600_000),
      counts: null,
      items: [item(1, "done", t0), item(2, "failed", t0), item(3, "reading", t0 + 60_000), item(4, "waiting"), { ...item(5, "skipped"), reason: "own_doc" }],
    };
    const p = jobProgress(job, t0 + 120_000);
    expect(p).toMatchObject({ total: 4, finished: 2 });
    // 2 finished in 2 min → 2 left ≈ 2 min (not measured from the job's creation an hour ago).
    expect(p.minutesLeft).toBe(2);
  });

  it("batch while running: Anthropic's counts, throughput since creation; plain 'none yet' at first", () => {
    const items = Array.from({ length: 100 }, (_, k) => item(k + 1, "reading", t0));
    const counts = { processing: 100, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    const started = jobProgress({ mode: "batch", status: "running", createdAt: iso(t0), counts, items }, t0 + 5 * 60_000);
    expect(started).toMatchObject({ total: 100, finished: 0, minutesLeft: null, noEstimate: "none_finished" });
    const later = jobProgress({ mode: "batch", status: "running", createdAt: iso(t0), counts: { ...counts, processing: 60, succeeded: 39, errored: 1 }, items }, t0 + 20 * 60_000);
    expect(later).toMatchObject({ total: 100, finished: 40, minutesLeft: 30 });
  });

  it("minutes in words; tally; retryable only where trying again can help", () => {
    expect(formatMinutesLeft(1)).toBe("ca en minut kvar");
    expect(formatMinutesLeft(7)).toBe("ca 7 min kvar");
    expect(formatMinutesLeft(80)).toBe("ca 1 h 20 min kvar");
    expect(formatMinutesLeft(118)).toBe("ca 2 h kvar");
    expect(tally([item(1, "done"), item(2, "done"), item(3, "failed")])).toEqual({ waiting: 0, reading: 0, done: 2, skipped: 0, failed: 1 });
    expect(retryable("failed", "error")).toBe(true);
    expect(retryable("failed", "too_long")).toBe(false);
    expect(retryable("skipped", "canceled")).toBe(false);
    expect(reasonMessage("own_doc")).toMatch(/eget mötesdokument/);
    expect(reasonMessage("something-new")).toBe(reasonMessage("error"));
    expect(reasonMessage(null)).toBeNull();
  });
});

describe("fitHistory", () => {
  it("keeps the newest meetings that fit the digest and says how many were left out", () => {
    const meeting = (d: string) => ({ date: d, source: "import" as const, items: [{ kind: "decision" as const, text: "x".repeat(80), topic: null, owner: null, done: null }] });
    const history = Array.from({ length: 10 }, (_, k) => meeting(`2025-01-${String(k + 10)}`));
    const one = JSON.stringify(history[0]).length + 1;
    const fit = fitHistory(history, 2 + one * 4);
    expect(fit.trimmed).toBe(6);
    expect(fit.history.map((m) => m.date)).toEqual(history.slice(6).map((m) => m.date));
    expect(fitHistory(history).trimmed).toBe(0);
    expect(JSON.stringify(fit.history).length).toBeLessThanOrEqual(2 + one * 4);
  });
});
