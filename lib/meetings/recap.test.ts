import { describe, expect, it } from "vitest";
import { summaryStatus } from "./recap";

describe("summaryStatus: what the meeting page says about the summary e-mail", () => {
  it("not swept yet (or mid-send): pending", () => {
    expect(summaryStatus(null, [])).toEqual({ state: "pending" });
    expect(summaryStatus("sending", [{ detail: { sent: 2 } }])).toEqual({ state: "pending" });
  });

  it("sent: the runs add up; the mode says to whom", () => {
    expect(summaryStatus("sent", [{ detail: { sent: 2, mode: "missed" } }, { detail: { sent: 1, mode: "missed" } }])).toEqual({ state: "sent", sent: 3, mode: "missed" });
    expect(summaryStatus("partial", [{ detail: { sent: 1, mode: "all" } }])).toEqual({ state: "sent", sent: 1, mode: "all" });
  });

  it("sent but no count readable: says nothing rather than a wrong number", () => {
    expect(summaryStatus("sent", [])).toEqual({ state: "none" });
    expect(summaryStatus("sent", [{ detail: { sent: "x", mode: "weird" } }])).toEqual({ state: "none" });
  });

  it("off in the settings; nobody, no notes, a Testmöte or older meetings: nothing to say", () => {
    expect(summaryStatus("off", [])).toEqual({ state: "off" });
    for (const s of ["none", "uncertain", "no_notes", "test", "before", "failed"]) expect(summaryStatus(s, [])).toEqual({ state: "none" });
  });
});
