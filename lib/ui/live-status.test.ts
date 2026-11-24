import { describe, expect, it } from "vitest";
import { liveStatus } from "./live-status";

describe("liveStatus", () => {
  it("live and healthy: pulsing Transkriberar, ring on, no banners", () => {
    const s = liveStatus({ phase: "live", connection: "ok" });
    expect(s).toMatchObject({ kind: "live", tone: "live", label: "Transkriberar", listening: true, partial: "live", banners: [] });
  });

  it("name round counts as live", () => {
    expect(liveStatus({ phase: "name-round", connection: "ok" }).kind).toBe("live");
  });

  it("reconnecting never claims to be transcribing", () => {
    const s = liveStatus({ phase: "live", connection: "reconnecting", staleMinutes: 4 });
    expect(s.kind).toBe("reconnecting");
    expect(s.tone).toBe("waiting");
    expect(s.listening).toBe(false);
    expect(s.partial).toBe("last-heard");
    // Stale notes are shown on the Doc card, never as a second banner next to the connection one.
    expect(s.banners).toEqual(["connection"]);
    expect(s.doc).toBe("stale");
  });

  it("error is the only banner, even when offline too, and Paus is gone", () => {
    const s = liveStatus({ phase: "error", connection: "offline", minutesLeft: 10 });
    expect(s).toMatchObject({ kind: "error", tone: "alert", canPause: false, listening: false, partial: "silent" });
    expect(s.banners).toEqual(["error"]);
  });

  it("error with a paused Doc: error first", () => {
    expect(liveStatus({ phase: "error", connection: "ok", docPaused: true }).banners).toEqual(["error", "doc"]);
  });

  it("paused wins the headline over a dropped connection", () => {
    const s = liveStatus({ phase: "paused", connection: "offline" });
    expect(s.kind).toBe("paused");
    expect(s.listening).toBe(false);
    expect(s.banners).toEqual(["connection"]);
  });

  it("Doc paused and reconnecting: the action (log in) comes first", () => {
    const s = liveStatus({ phase: "live", connection: "reconnecting", docPaused: true });
    expect(s.banners).toEqual(["doc", "connection"]);
    expect(s.doc).toBe("paused");
  });

  it("time limit outranks a self-healing connection", () => {
    expect(liveStatus({ phase: "live", connection: "offline", minutesLeft: 12 }).banners).toEqual(["time", "connection"]);
  });

  it("ending shows no banners about the running meeting", () => {
    const s = liveStatus({ phase: "ending", connection: "offline", minutesLeft: 2 });
    expect(s.banners).toEqual([]);
    expect(s.canPause).toBe(false);
  });
});
