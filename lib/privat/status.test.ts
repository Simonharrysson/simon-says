import { describe, expect, it } from "vitest";
import { summaryStatus, SWEEP_WINDOW_MS } from "./status";

const now = Date.parse("2026-11-26T12:00:00Z");
const ended = (msAgo: number) => new Date(now - msAgo).toISOString();
const m = (summary_state: Parameters<typeof summaryStatus>[0]["summary_state"], over = {}) => ({ status: "done" as const, summary_state, ended_at: ended(60_000), ...over });

describe("the recording page's summary status", () => {
  it("honest states, never 'on its way' forever", () => {
    expect(summaryStatus(m(null), true, now)).toBe("ready");
    expect(summaryStatus(m(null), false, now)).toBe("pending");
    expect(summaryStatus(m("sending"), false, now)).toBe("pending");
    expect(summaryStatus(m("sending", { ended_at: ended(SWEEP_WINDOW_MS + 1) }), false, now)).toBe("failed");
    expect(summaryStatus(m(null, { ended_at: ended(SWEEP_WINDOW_MS + 1) }), false, now)).toBe("failed");
    for (const s of ["failed", "partial", "none", "off", "sent", "uncertain"] as const) expect(summaryStatus(m(s), false, now)).toBe("failed");
    expect(summaryStatus(m("no_notes"), false, now)).toBe("none");
    expect(summaryStatus(m("test"), false, now)).toBe("none");
    expect(summaryStatus(m(null, { status: "abandoned" }), false, now)).toBe("none");
  });
});
