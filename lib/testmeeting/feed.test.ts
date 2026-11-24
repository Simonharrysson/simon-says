import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { IngestError } from "@/lib/segments/ingest";
import { dueMs, END_DEADLINE_MS, planBatches, runFeed, SPEED, type FeedDeps } from "./feed";
import { FIXTURE_LINES, FIXTURE_SPEAKER_NAMES, stripSessionPrefix, toSegments } from "./fixture";

const jsonl = () =>
  readFileSync("fixtures/notes/synthetic.jsonl", "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

describe("fixture module", () => {
  it("is identical to fixtures/notes/synthetic.jsonl", () => {
    expect(FIXTURE_LINES).toEqual(jsonl());
    expect(FIXTURE_LINES).toHaveLength(70);
  });

  it("maps lines to one run each: index = segmentIndex, runIndex 0, label without the session prefix", () => {
    const segs = toSegments(FIXTURE_LINES, "test-1");
    expect(segs).toHaveLength(70);
    segs.forEach((s, i) => {
      expect(s).toMatchObject({ elSessionId: "test-1", segmentIndex: i, runIndex: 0, text: FIXTURE_LINES[i].text });
      expect(s.speaker).not.toMatch(/^S\d+-/);
      expect(s.startMs).toBe(FIXTURE_LINES[i].startMs);
      expect(s.endMs).toBeGreaterThanOrEqual(s.startMs);
    });
    expect(segs[0].speaker).toBe("speaker_0");
  });

  it("seeds names for every speaker the fixture uses, keyed by the stored (unprefixed) label", () => {
    expect(FIXTURE_SPEAKER_NAMES.speaker_0).toBe("Karin Ek");
    for (const l of FIXTURE_LINES) expect(FIXTURE_SPEAKER_NAMES[stripSessionPrefix(l.speaker)]).toBeTruthy();
  });
});

describe("timing (3x)", () => {
  it("a line is due at startMs / 3", () => {
    expect(SPEED).toBe(3);
    expect(dueMs({ startMs: 30_000 })).toBe(10_000);
  });

  it("every line is posted once, never before it is due, and within one interval after", () => {
    const batches = planBatches(FIXTURE_LINES, "s");
    const posted = batches.flatMap((b) => b.segments.map((s) => s.segmentIndex));
    expect(posted).toEqual(FIXTURE_LINES.map((_, i) => i));
    for (const b of batches) {
      for (const s of b.segments) {
        expect(b.atMs).toBeGreaterThanOrEqual(dueMs(FIXTURE_LINES[s.segmentIndex]));
        expect(b.atMs - dueMs(FIXTURE_LINES[s.segmentIndex])).toBeLessThan(5000);
      }
    }
  });

  it("the replay (~200 s) leaves the 300 s function budget plenty of room", () => {
    const last = planBatches(FIXTURE_LINES, "s").at(-1)!;
    expect(last.atMs).toBeLessThanOrEqual(205_000);
    expect(last.atMs).toBeLessThan(END_DEADLINE_MS - 60_000);
  });

  it("stays under the ingest caps in any real minute (120 runs, 20 000 chars)", () => {
    const batches = planBatches(FIXTURE_LINES, "s");
    for (const start of batches.map((b) => b.atMs)) {
      const inWindow = batches.filter((b) => b.atMs >= start && b.atMs < start + 60_000).flatMap((b) => b.segments);
      expect(inWindow.length).toBeLessThanOrEqual(120);
      expect(inWindow.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(20_000);
    }
  });
});

function fakeDeps(over: Partial<FeedDeps> = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const deps: FeedDeps = {
    now: () => now,
    sleep: async (ms) => {
      now += Math.max(0, ms);
    },
    ingest: vi.fn(async () => {
      calls.push("ingest");
    }),
    heartbeat: vi.fn(async () => {
      calls.push("heartbeat");
    }),
    tick: vi.fn(async () => {
      calls.push("tick");
    }),
    end: vi.fn(async () => {
      calls.push("end");
      return "ended" as const;
    }),
    ...over,
  };
  return { deps, calls, clock: () => now };
}

describe("runFeed", () => {
  it("posts every batch with a heartbeat and a tick, then ends the meeting with the deadline", async () => {
    const { deps, calls } = fakeDeps();
    const n = planBatches(FIXTURE_LINES, "s").length;
    const res = await runFeed("m1", "s", 5_000_000, deps);
    expect(res).toBe("ended");
    expect(deps.ingest).toHaveBeenCalledTimes(n);
    expect(deps.heartbeat).toHaveBeenCalledTimes(n);
    expect(deps.tick).toHaveBeenCalledTimes(n);
    expect(calls.at(-1)).toBe("end");
    expect(deps.end).toHaveBeenCalledWith("m1", { deadlineAt: new Date(5_000_000 + END_DEADLINE_MS) });
  });

  it("replays in real time: the last batch is posted ~200 s after the start", async () => {
    const { deps, clock } = fakeDeps();
    await runFeed("m1", "s", 0, deps);
    expect(clock() - 1_000_000).toBe(planBatches(FIXTURE_LINES, "s").at(-1)!.atMs);
  });

  it("does not wait for a tick before the next batch, but waits for all ticks before ending", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const { deps } = fakeDeps({
      tick: vi.fn(() => slow.then(() => void order.push("tick-done"))),
      ingest: vi.fn(async () => void order.push("ingest")),
      end: vi.fn(async () => {
        order.push("end");
        return "ended" as const;
      }),
    });
    const run = runFeed("m1", "s", 0, deps);
    await vi.waitFor(() => expect(order.filter((o) => o === "ingest").length).toBe(planBatches(FIXTURE_LINES, "s").length));
    expect(order).not.toContain("end"); // ticks still running
    release();
    await run;
    expect(order.at(-1)).toBe("end");
    expect(order.indexOf("tick-done")).toBeLessThan(order.indexOf("end"));
  });

  it("retries a failed batch once, stops when the meeting is no longer live, and still ends", async () => {
    let fails = 1;
    const a = fakeDeps({
      ingest: vi.fn(async () => {
        if (fails-- > 0) throw new Error("db blip");
      }),
    });
    await runFeed("m1", "s", 0, a.deps);
    expect(a.deps.ingest).toHaveBeenCalledTimes(planBatches(FIXTURE_LINES, "s").length + 1);

    const b = fakeDeps({
      ingest: vi.fn(async () => {
        throw new IngestError("meeting_not_live");
      }),
    });
    expect(await runFeed("m1", "s", 0, b.deps)).toBe("ended");
    expect(b.deps.ingest).toHaveBeenCalledTimes(1);
    expect(b.deps.end).toHaveBeenCalledTimes(1);
  });

  it("never throws, even if end does", async () => {
    const { deps } = fakeDeps({
      end: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await runFeed("m1", "s", 0, deps)).toBe("error");
  });
});
