import { describe, expect, it } from "vitest";
import { autoEndStatus, CONNECTED_WITHIN_SEC, lastSeenMs, presence, PRESENCE_GRACE_SEC } from "./presence";

const T0 = Date.parse("2026-11-26T18:00:00Z");
const ago = (sec: number) => new Date(T0 - sec * 1000).toISOString();
const m = (heartbeatAgoSec: number | null, startedAgoSec = 3600) => ({
  last_heartbeat_at: heartbeatAgoSec === null ? null : ago(heartbeatAgoSec),
  started_at: ago(startedAgoSec),
});

describe("presence (Meet-like: live while a tab is connected)", () => {
  it("grace is about 5 min, longer than a few missed 10 s heartbeats", () => {
    expect(PRESENCE_GRACE_SEC).toBe(300);
    expect(CONNECTED_WITHIN_SEC).toBeGreaterThanOrEqual(30);
  });

  it("connected while the heartbeat is fresh", () => {
    expect(presence(m(0), T0)).toBe("connected");
    expect(presence(m(CONNECTED_WITHIN_SEC), T0)).toBe("connected");
  });

  it("grace after the last tab went away: reopening it continues the meeting", () => {
    expect(presence(m(CONNECTED_WITHIN_SEC + 1), T0)).toBe("grace");
    expect(presence(m(4 * 60), T0)).toBe("grace");
    expect(presence(m(PRESENCE_GRACE_SEC), T0)).toBe("grace");
  });

  it("gone after the grace period: the cron ends it", () => {
    expect(presence(m(PRESENCE_GRACE_SEC + 1), T0)).toBe("gone");
    expect(presence(m(16 * 60), T0)).toBe("gone");
  });

  it("no heartbeat yet: counts from the start", () => {
    expect(lastSeenMs(m(null, 120))).toBe(T0 - 120_000);
    expect(presence(m(null, 120), T0)).toBe("grace");
    expect(presence(m(null, 600), T0)).toBe("gone");
  });

  it("ends like Avsluta (done) when anything was said, abandoned only when nothing was", () => {
    expect(autoEndStatus(true)).toBe("done");
    expect(autoEndStatus(false)).toBe("abandoned");
  });
});
