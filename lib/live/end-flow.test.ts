import { describe, expect, it, vi } from "vitest";
import { runEndFlow, type DrainingStream } from "./end-flow";

function fakeStream(rounds: { pending: number; signedOut?: boolean }[], start = rounds[0]?.pending ?? 0) {
  let pending = start;
  let signedOut = false;
  let i = 0;
  const s: DrainingStream & { drains: number } = {
    drains: 0,
    get pending() {
      return pending;
    },
    get signedOut() {
      return signedOut;
    },
    async drain() {
      this.drains++;
      const r = rounds[Math.min(++i, rounds.length - 1)];
      pending = r.pending;
      signedOut = r.signedOut ?? false;
      return pending;
    },
  };
  return s;
}

describe("runEndFlow", () => {
  it("drains until nothing is left, then posts /end once and navigates (R1: /end answers at once)", async () => {
    const s = fakeStream([{ pending: 3 }, { pending: 1 }, { pending: 0 }]);
    const pending: number[] = [];
    const postEnd = vi.fn(async () => 200);
    expect(await runEndFlow({ stream: s, postEnd, drainRoundMs: 60_000, onPending: (n) => pending.push(n) })).toEqual({ kind: "navigate" });
    expect(s.drains).toBe(2);
    expect(postEnd).toHaveBeenCalledTimes(1);
    expect(pending).toEqual([3, 1, 0]);
  });

  it("R3: signed out with lines left → stops waiting at once and does not post /end", async () => {
    const s = fakeStream([{ pending: 2 }, { pending: 2, signedOut: true }]);
    const postEnd = vi.fn(async () => 200);
    expect(await runEndFlow({ stream: s, postEnd, drainRoundMs: 60_000 })).toEqual({ kind: "signed_out", unsent: 2 });
    expect(s.drains).toBe(1);
    expect(postEnd).not.toHaveBeenCalled();
  });

  it("R3: 'Avsluta utan dem' posts /end without waiting for the unsent lines", async () => {
    const s = fakeStream([{ pending: 2, signedOut: true }]);
    const postEnd = vi.fn(async () => 200);
    expect(await runEndFlow({ stream: s, postEnd, drainRoundMs: 60_000, endWithoutUnsent: true })).toEqual({ kind: "navigate" });
    expect(s.drains).toBe(0);
  });

  it("retry only for network errors and 5xx; 401 is signed out; 403/404 navigate", async () => {
    const run = (postEnd: () => Promise<number>) => runEndFlow({ stream: null, postEnd, drainRoundMs: 1 });
    expect(await run(async () => Promise.reject(new TypeError("Failed to fetch")))).toEqual({ kind: "end_failed" });
    expect(await run(async () => 502)).toEqual({ kind: "end_failed" });
    expect(await run(async () => 401)).toEqual({ kind: "signed_out", unsent: 0 });
    expect(await run(async () => 404)).toEqual({ kind: "navigate" });
    expect(await run(async () => 403)).toEqual({ kind: "navigate" });
  });
});
