import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { IngestError } from "@/lib/segments/ingest";
import { dueMs, END_DEADLINE_MS, planBatches, runFeed, SPEED, TICK_DEADLINE_MS, TICK_WAIT_MS, type FeedDeps } from "./feed";
import { validRole } from "@/lib/people/roles";
import {
  AGENDA_FIXTURE_LINES,
  AGENDA_TEST_PEOPLE,
  FIXTURE_LINES,
  FIXTURE_SPEAKER_NAMES,
  stripSessionPrefix,
  testPeople,
  toSegments,
  usesTestPeople,
} from "./fixture";

const jsonl = (name = "synthetic") =>
  readFileSync(`fixtures/notes/${name}.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const expectedOf = (name: string) => JSON.parse(readFileSync(`fixtures/notes/${name}.expected.json`, "utf8"));

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

describe("agenda Testmöte fixtures (A13)", () => {
  it("the bundled line files are identical to fixtures/notes/veckomote-a/-b.jsonl", () => {
    expect(AGENDA_FIXTURE_LINES.a).toEqual(jsonl("veckomote-a"));
    expect(AGENDA_FIXTURE_LINES.b).toEqual(jsonl("veckomote-b"));
  });

  it("every agenda fixture ends by 540 000 ms: the replay is at most 135 s at 4x (plus one batch interval)", () => {
    for (const lines of Object.values(AGENDA_FIXTURE_LINES)) {
      expect(lines.at(-1)!.startMs).toBeLessThanOrEqual(540_000);
      expect(planBatches(lines, "s").at(-1)!.atMs).toBeLessThanOrEqual(135_000 + 5000);
      // Session-relative times only grow.
      lines.forEach((l, i) => i > 0 && expect(l.startMs).toBeGreaterThan(lines[i - 1].startMs));
    }
  });

  it("every fixture says it is fictional", () => {
    for (const name of ["veckomote-a", "veckomote-b"]) expect(expectedOf(name).source).toMatch(/fictional/i);
    expect(JSON.parse(readFileSync("fixtures/agenda/veckomote.agenda.json", "utf8")).source).toMatch(/fictional/i);
  });

  it("five people with unique first names and valid, unique roles; the name round can find each of them", () => {
    const a = expectedOf("veckomote-a");
    expect(AGENDA_TEST_PEOPLE).toEqual(a.people);
    expect(expectedOf("veckomote-b").people).toEqual(a.people);
    expect(AGENDA_TEST_PEOPLE.map((p) => p.role)).toEqual(["Ordförande", "Kassör", "Sekreterare", "PR-ansvarig", "Eventansvarig"]);
    for (const p of AGENDA_TEST_PEOPLE) expect(validRole(p.role)).toBe(p.role);
    expect(new Set(AGENDA_TEST_PEOPLE.map((p) => p.name.split(" ")[0])).size).toBe(5);
    expect(Object.values(a.speakerNames).sort()).toEqual(AGENDA_TEST_PEOPLE.map((p) => p.name).sort());
    for (const lines of Object.values(AGENDA_FIXTURE_LINES)) {
      const opening = lines.slice(0, 5).map((l) => l.text).join(" ");
      for (const p of AGENDA_TEST_PEOPLE) expect(opening).toContain(p.name);
    }
  });

  it("expected tasks and carried items name people the test people resolve to their role", async () => {
    const { ownerLabel, resolveOwner } = await import("@/lib/people/roles");
    const people = testPeople("org1");
    for (const name of ["veckomote-a", "veckomote-b"]) {
      for (const t of expectedOf(name).action_items) expect(ownerLabel(resolveOwner(t.owner, people), t.owner, "role")).toBe(t.ownerLabel);
    }
    expect(ownerLabel(resolveOwner("Kassören", people), "Kassören", "role")).toBe("Kassör");
    expect(expectedOf("veckomote-b").carried.map((c: { done: boolean }) => c.done)).toEqual([true, true, false, false]);
  });

  it("test people only for agenda Testmöten, with ids that are never stored", () => {
    expect(usesTestPeople({ is_test: true, agenda_doc: true })).toBe(true);
    expect(usesTestPeople({ is_test: true, agenda_doc: false })).toBe(false);
    expect(usesTestPeople({ is_test: false, agenda_doc: true })).toBe(false);
    expect(usesTestPeople({ is_test: null, agenda_doc: null })).toBe(false);
    const people = testPeople("org1");
    expect(people).toHaveLength(5);
    for (const p of people) expect(p).toMatchObject({ org_id: "org1", member_user_id: null, id: expect.stringMatching(/^test-person-/) });
  });
});

describe("timing (4x)", () => {
  it("a line is due at startMs / 4", () => {
    expect(SPEED).toBe(4);
    expect(dueMs({ startMs: 40_000 })).toBe(10_000);
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

  it("the replay (~150 s) leaves the 300 s function budget plenty of room", () => {
    const last = planBatches(FIXTURE_LINES, "s").at(-1)!;
    expect(last.atMs).toBeLessThanOrEqual(155_000);
    expect(last.atMs).toBeLessThan(END_DEADLINE_MS - 60_000);
  });

  it("stays under the ingest caps in any real minute (120 runs, 20 000 chars; ~28 runs/min)", () => {
    const batches = planBatches(FIXTURE_LINES, "s");
    for (const start of batches.map((b) => b.atMs)) {
      const inWindow = batches.filter((b) => b.atMs >= start && b.atMs < start + 60_000).flatMap((b) => b.segments);
      expect(inWindow.length).toBeLessThanOrEqual(120);
      expect(inWindow.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(20_000);
    }
  });
});

function fakeDeps(over: Partial<FeedDeps> = {}, opts: { longSleepsResolve?: boolean } = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const deps: FeedDeps = {
    now: () => now,
    // Long sleeps are the "stop waiting for ticks" timer: they only fire when a test says so.
    sleep: (ms) => {
      if (ms > 10_000 && !opts.longSleepsResolve) return new Promise<void>(() => {});
      now += Math.max(0, ms);
      return Promise.resolve();
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
    const res = await runFeed("m1", "s", 1_000_000, deps);
    expect(res).toBe("ended");
    expect(deps.ingest).toHaveBeenCalledTimes(n);
    expect(deps.heartbeat).toHaveBeenCalledTimes(n);
    expect(deps.tick).toHaveBeenCalledTimes(n);
    expect(calls.at(-1)).toBe("end");
    expect(deps.end).toHaveBeenCalledWith("m1", { deadlineAt: new Date(1_000_000 + END_DEADLINE_MS) });
  });

  it("replays in real time: the last batch is posted ~150 s after the start", async () => {
    const { deps, clock } = fakeDeps();
    await runFeed("m1", "s", 1_000_000, deps);
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
    const run = runFeed("m1", "s", 1_000_000, deps);
    await vi.waitFor(() => expect(order.filter((o) => o === "ingest").length).toBe(planBatches(FIXTURE_LINES, "s").length));
    expect(order).not.toContain("end"); // ticks still running
    release();
    await run;
    expect(order.at(-1)).toBe("end");
    expect(order.indexOf("tick-done")).toBeLessThan(order.indexOf("end"));
  });

  it("gives every mid-feed tick a deadline (invocation start + 230 s)", async () => {
    const { deps } = fakeDeps();
    await runFeed("m1", "s", 1_000_000, deps);
    for (const call of vi.mocked(deps.tick).mock.calls) expect(call[1]).toEqual(new Date(1_000_000 + TICK_DEADLINE_MS));
  });

  it("stops waiting for a hung tick at invocation start + 235 s and still ends", async () => {
    const { deps, clock } = fakeDeps({ tick: vi.fn(() => new Promise<void>(() => {})) }, { longSleepsResolve: true });
    expect(await runFeed("m1", "s", 1_000_000, deps)).toBe("ended");
    expect(deps.end).toHaveBeenCalledTimes(1);
    expect(clock()).toBeGreaterThanOrEqual(1_000_000 + TICK_WAIT_MS);
  });

  it("retries a failed batch once, stops when the meeting is no longer live, and still ends", async () => {
    let fails = 1;
    const a = fakeDeps({
      ingest: vi.fn(async () => {
        if (fails-- > 0) throw new Error("db blip");
      }),
    });
    await runFeed("m1", "s", 1_000_000, a.deps);
    expect(a.deps.ingest).toHaveBeenCalledTimes(planBatches(FIXTURE_LINES, "s").length + 1);

    const b = fakeDeps({
      ingest: vi.fn(async () => {
        throw new IngestError("meeting_not_live");
      }),
    });
    expect(await runFeed("m1", "s", 1_000_000, b.deps)).toBe("ended");
    expect(b.deps.ingest).toHaveBeenCalledTimes(1);
    expect(b.deps.end).toHaveBeenCalledTimes(1);
  });

  it("never throws, even if end does", async () => {
    const { deps } = fakeDeps({
      end: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await runFeed("m1", "s", 1_000_000, deps)).toBe("error");
  });
});
