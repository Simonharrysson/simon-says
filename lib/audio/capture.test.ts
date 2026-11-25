import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESUME_TIMEOUT_MS, resumeWithin } from "./capture";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("resumeWithin (C11)", () => {
  it("true when the context resumes and runs", async () => {
    const ctx = { state: "suspended" as AudioContextState, resume: async () => void (ctx.state = "running") };
    expect(await resumeWithin(ctx)).toBe(true);
  });

  it("false after the timeout when Safari never settles resume()", async () => {
    const ctx = { state: "interrupted" as AudioContextState, resume: () => new Promise<void>(() => {}) };
    const p = resumeWithin(ctx);
    await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS);
    expect(await p).toBe(false);
  });

  it("false when resume() resolves but the context still isn't running, or rejects", async () => {
    expect(await resumeWithin({ state: "interrupted" as AudioContextState, resume: async () => {} })).toBe(false);
    expect(await resumeWithin({ state: "suspended" as AudioContextState, resume: async () => Promise.reject(new Error("x")) })).toBe(false);
  });
});
