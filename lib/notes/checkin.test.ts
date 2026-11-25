import { afterEach, describe, expect, it, vi } from "vitest";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CheckinWindow } from "@/lib/db/types";

// Fictional meeting only. No paid calls: every Claude call goes to a fake client.
const recorded: unknown[] = [];
const spendChecks = { n: 0 };
vi.mock("@/lib/env", () => ({ getEnv: () => ({ KILL_SWITCH: false, GLOBAL_DAILY_USD: 25, ANTHROPIC_API_KEY: "test" }) }));
vi.mock("@/lib/db/usage", () => ({ dayUsd: async () => (spendChecks.n++, 0) }));
vi.mock("@/lib/db/claude-usage", () => ({ recordClaudeUsage: async (...a: unknown[]) => void recorded.push(a) }));

const { CHECKIN_MAX_FAILURES, CHECKIN_MAX_MS, CHECKIN_PLACEHOLDER, CHECKIN_SEARCH_MS, detectCheckin, maskCheckin, nextWindow } =
  await import("./checkin");

const OPEN: CheckinWindow = { startMs: null, endMs: null, closed: false, failures: 0 };

afterEach(() => {
  vi.restoreAllMocks();
  recorded.length = 0;
  spendChecks.n = 0;
});

describe("constants", () => {
  it("are the brief's values", () => {
    expect(CHECKIN_PLACEHOLDER).toBe("[Må-runda — utelämnad]");
    expect(CHECKIN_MAX_MS).toBe(20 * 60_000);
    expect(CHECKIN_SEARCH_MS).toBe(30 * 60_000);
    expect(CHECKIN_MAX_FAILURES).toBe(3);
  });
});

describe("nextWindow", () => {
  it("clamps a start found before the new span to its first line (a block already sent never changes)", () => {
    const w = nextWindow(OPEN, { startMs: 10_000, endMs: null }, { firstMs: 30_000, lastMs: 60_000 });
    expect(w).toEqual({ startMs: 30_000, endMs: null, closed: false, failures: 0 });
  });

  it("sets the start once", () => {
    const w1 = nextWindow(OPEN, { startMs: 40_000, endMs: null }, { firstMs: 30_000, lastMs: 60_000 });
    const w2 = nextWindow(w1, { startMs: 70_000, endMs: null }, { firstMs: 61_000, lastMs: 90_000 });
    expect(w2.startMs).toBe(40_000);
    expect(w2.closed).toBe(false);
  });

  it("an end found closes the window there", () => {
    const open = { ...OPEN, startMs: 40_000 };
    const w = nextWindow(open, { startMs: null, endMs: 200_000 }, { firstMs: 150_000, lastMs: 240_000 });
    expect(w).toEqual({ startMs: 40_000, endMs: 200_000, closed: true, failures: 0 });
  });

  it("an end found before the new span is clamped to its first line", () => {
    const open = { ...OPEN, startMs: 40_000 };
    const w = nextWindow(open, { startMs: null, endMs: 100_000 }, { firstMs: 150_000, lastMs: 240_000 });
    expect(w.endMs).toBe(150_000);
    expect(w.closed).toBe(true);
  });

  it("start and end in the same span", () => {
    const w = nextWindow(OPEN, { startMs: 40_000, endMs: 120_000 }, { firstMs: 30_000, lastMs: 150_000 });
    expect(w).toEqual({ startMs: 40_000, endMs: 120_000, closed: true, failures: 0 });
  });

  it("an open window closes after CHECKIN_MAX_MS", () => {
    const open = { ...OPEN, startMs: 60_000 };
    const w = nextWindow(open, { startMs: null, endMs: null }, { firstMs: 1_250_000, lastMs: 1_300_000 });
    expect(w).toEqual({ startMs: 60_000, endMs: 1_260_000, closed: true, failures: 0 });
  });

  it("three failures close it: at the new span's first line when it had started, without a window otherwise", () => {
    let w: CheckinWindow = { ...OPEN, startMs: 60_000 };
    w = nextWindow(w, "failed", { firstMs: 100_000, lastMs: 140_000 });
    w = nextWindow(w, "failed", { firstMs: 141_000, lastMs: 180_000 });
    expect(w).toMatchObject({ closed: false, failures: 2 });
    w = nextWindow(w, "failed", { firstMs: 181_000, lastMs: 220_000 });
    expect(w).toEqual({ startMs: 60_000, endMs: 181_000, closed: true, failures: 3 });

    let n: CheckinWindow = OPEN;
    for (let k = 0; k < 3; k++) n = nextWindow(n, "failed", { firstMs: k * 50_000, lastMs: k * 50_000 + 40_000 });
    expect(n).toEqual({ startMs: null, endMs: null, closed: true, failures: 3 });
  });

  it("failures count only in a row: a successful call resets them", () => {
    let w: CheckinWindow = { ...OPEN, startMs: 60_000 };
    w = nextWindow(w, "failed", { firstMs: 100_000, lastMs: 140_000 });
    w = nextWindow(w, "failed", { firstMs: 141_000, lastMs: 180_000 });
    w = nextWindow(w, { startMs: null, endMs: null }, { firstMs: 181_000, lastMs: 220_000 });
    expect(w).toMatchObject({ closed: false, failures: 0 });
    w = nextWindow(w, "failed", { firstMs: 221_000, lastMs: 260_000 });
    expect(w).toMatchObject({ closed: false, failures: 1 });
  });

  it("no start by CHECKIN_SEARCH_MS → closed without a window", () => {
    const w = nextWindow(OPEN, { startMs: null, endMs: null }, { firstMs: 1_750_000, lastMs: 1_800_000 });
    expect(w).toEqual({ startMs: null, endMs: null, closed: true, failures: 0 });
  });

  it("an end while no start is known is ignored (one slip never switches masking off)", () => {
    const w = nextWindow(OPEN, { startMs: null, endMs: 90_000 }, { firstMs: 30_000, lastMs: 120_000 });
    expect(w).toEqual(OPEN);
  });

  it("a closed window never changes", () => {
    const closed: CheckinWindow = { startMs: 40_000, endMs: 90_000, closed: true, failures: 0 };
    expect(nextWindow(closed, { startMs: 1, endMs: 2 }, { firstMs: 100_000, lastMs: 200_000 })).toEqual(closed);
    expect(nextWindow(closed, "failed", { firstMs: 100_000, lastMs: 200_000 })).toEqual(closed);
  });
});

describe("maskCheckin", () => {
  const segs = Array.from({ length: 10 }, (_, k) => ({ start_ms: k, speaker: `speaker_${k % 2}`, text: `rad ${k}` }));
  const at = (s: { start_ms: number }) => s.start_ms;

  it("the window's run becomes one placeholder line; the rest stays", () => {
    const out = maskCheckin(segs, { startMs: 3, endMs: 6, closed: true, failures: 0 }, at);
    expect(out.map((s) => s.text)).toEqual(["rad 0", "rad 1", "rad 2", CHECKIN_PLACEHOLDER, "rad 6", "rad 7", "rad 8", "rad 9"]);
    expect(out[3]).toEqual({ start_ms: 3, speaker: "–", text: CHECKIN_PLACEHOLDER });
  });

  it("an open window masks everything from its start", () => {
    const out = maskCheckin(segs, { startMs: 7, endMs: null, closed: false, failures: 0 }, at);
    expect(out.map((s) => s.text)).toEqual(["rad 0", "rad 1", "rad 2", "rad 3", "rad 4", "rad 5", "rad 6", CHECKIN_PLACEHOLDER]);
  });

  it("each contiguous run gets its own placeholder (segments out of time order)", () => {
    const mixed = [segs[0], segs[4], segs[1], segs[5], segs[8]];
    const out = maskCheckin(mixed, { startMs: 3, endMs: 6, closed: true, failures: 0 }, at);
    expect(out.map((s) => s.text)).toEqual(["rad 0", CHECKIN_PLACEHOLDER, "rad 1", CHECKIN_PLACEHOLDER, "rad 8"]);
  });

  it("no window, or no start: unchanged", () => {
    expect(maskCheckin(segs, null, at)).toEqual(segs);
    expect(maskCheckin(segs, { startMs: null, endMs: null, closed: true, failures: 0 }, at)).toEqual(segs);
  });
});

describe("detectCheckin", () => {
  const lines = [
    { atMs: 61_000, speaker: "Anna Berg", text: "Då kör vi må-rundan, Erik börjar." },
    { atMs: 65_000, speaker: "Erik Lund", text: "Jag mår bra, lite trött efter helgen." },
    { atMs: 130_000, speaker: "Anna Berg", text: "Bra, då går vi till från förra veckan." },
  ];
  const agenda = [
    { key: "ag-1", label: "Godkänn dagordning", role: "procedural" as const },
    { key: "ag-2", label: "Må-runda", role: "checkin" as const },
    { key: "ag-3", label: "Från förra veckan", role: "followup" as const },
  ];
  const input = { lines, context: [{ atMs: 20_000, speaker: "Anna Berg", text: "Välkomna allihop." }], agenda, window: OPEN };

  function fakeClient(answer: unknown, over: Partial<BetaMessage> = {}) {
    const bodies: BetaMessageStreamParams[] = [];
    const client = {
      beta: {
        messages: {
          stream(body: BetaMessageStreamParams) {
            bodies.push(body);
            return {
              finalMessage: async () =>
                ({
                  id: "msg",
                  type: "message",
                  role: "assistant",
                  model: "claude-opus-5-5",
                  stop_reason: "end_turn",
                  content: [{ type: "text", text: JSON.stringify(answer) }],
                  usage: { input_tokens: 800, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                  ...over,
                }) as unknown as BetaMessage,
            };
          },
        },
      },
    };
    return { client, bodies };
  }
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("times of lines in `lines` → their atMs; usage returned, not recorded (the caller records it)", async () => {
    const { client, bodies } = fakeClient({ start_at: "00:01:01", end_at: "00:02:10" });
    const out = await detectCheckin(input, { orgId: "org-1", client });
    expect(out.found).toEqual({ startMs: 61_000, endMs: 130_000 });
    expect(out.usage?.input).toBe(800);
    expect(recorded).toHaveLength(0);
    expect(spendChecks.n).toBe(0); // the tick checks the kill switch / cap before calling
    const body = bodies[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config?.effort).toBe("medium");
    expect(body.output_config?.format?.type).toBe("json_schema");
    expect(body.fallbacks).toBe("default");
    const text = (body.messages[0].content as { text: string }[])[0].text;
    expect(text).toContain("ag-2: Må-runda (checkin)");
    expect(text).toContain("[00:01:05] Erik Lund: Jag mår bra");
    expect(text).toContain("[00:00:20] Anna Berg: Välkomna allihop.");
  });

  it("nulls pass through", async () => {
    const { client } = fakeClient({ start_at: null, end_at: null });
    expect((await detectCheckin(input, { orgId: "org-1", client })).found).toEqual({ startMs: null, endMs: null });
  });

  it("a time not among `lines` (a context line, or invented) → failed", async () => {
    quiet();
    for (const answer of [
      { start_at: "00:00:20", end_at: null },
      { start_at: "00:01:01", end_at: "00:09:99" },
    ]) {
      const { client } = fakeClient(answer);
      expect((await detectCheckin(input, { orgId: "org-1", client })).found).toBe("failed");
    }
  });

  it("refusal → failed, its usage still returned", async () => {
    quiet();
    const { client } = fakeClient({}, { stop_reason: "refusal", content: [] });
    const out = await detectCheckin(input, { orgId: "org-1", client });
    expect(out.found).toBe("failed");
    expect(out.usage?.input).toBe(800);
  });

  it("malformed output or a failed request → failed", async () => {
    quiet();
    const { client } = fakeClient({ start: "00:01:01" });
    expect((await detectCheckin(input, { orgId: "org-1", client })).found).toBe("failed");
    const broken = {
      beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new Error("timeout")) }) } },
    };
    const out = await detectCheckin(input, { orgId: "org-1", client: broken });
    expect(out).toEqual({ found: "failed", usage: null });
  });

  it("two lines in one second: start → the earliest, end → the latest (over-mask, never leak)", async () => {
    const same = [
      { atMs: 432_100, speaker: "Anna Berg", text: "Då tar vi må-rundan." },
      { atMs: 432_800, speaker: "Erik Lund", text: "Jag mår bra." },
      { atMs: 500_000, speaker: "Anna Berg", text: "Tack, vidare." },
      { atMs: 560_200, speaker: "Erik Lund", text: "Och jag är lite trött." },
      { atMs: 560_900, speaker: "Anna Berg", text: "Nu: från förra veckan." },
    ];
    const { client } = fakeClient({ start_at: "00:07:12", end_at: "00:09:20" });
    const out = await detectCheckin({ ...input, lines: same }, { orgId: "org-1", client });
    expect(out.found).toEqual({ startMs: 432_100, endMs: 560_900 });
  });

  it("the window's state is told: start already known → only the end is asked for", async () => {
    const { client, bodies } = fakeClient({ start_at: null, end_at: "00:02:10" });
    const out = await detectCheckin({ ...input, window: { ...OPEN, startMs: 40_000 } }, { orgId: "org-1", client });
    expect(out.found).toEqual({ startMs: null, endMs: 130_000 });
    const text = (bodies[0].messages[0].content as { text: string }[])[0].text;
    expect(text).toContain("began at 00:00:40");
  });
});
