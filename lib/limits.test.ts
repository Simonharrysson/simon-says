import { describe, expect, it } from "vitest";
import { decideLimits, MEETING_SECONDS, mintSpacingSeconds, ORG_MONTH_SECONDS, type LimitInput } from "./limits";

const base: LimitInput = {
  killSwitch: false,
  consentConfirmed: true,
  orgMonthSeconds: 0,
  meetingSeconds: 0,
  globalDaySeconds: 0,
  dayUsd: 0,
  globalDailyHours: 30,
  globalDailyUsd: 25,
};

describe("decideLimits", () => {
  it("allows a fresh meeting the full 4 h (14 400 s)", () => {
    expect(decideLimits(base)).toEqual({ ok: true, warn: false, stop: false, remainingSeconds: 14_400 });
  });

  it("remaining time is the smallest of meeting, org month and global day", () => {
    expect(decideLimits({ ...base, meetingSeconds: 3600 }).remainingSeconds).toBe(3 * 3600);
    expect(decideLimits({ ...base, orgMonthSeconds: ORG_MONTH_SECONDS - 600 }).remainingSeconds).toBe(600);
    expect(decideLimits({ ...base, globalDaySeconds: 30 * 3600 - 42 }).remainingSeconds).toBe(42);
  });

  it("warns from 3 h 45 into the meeting, stops at 4 h", () => {
    expect(decideLimits({ ...base, meetingSeconds: 3.75 * 3600 - 1 }).warn).toBe(false);
    expect(decideLimits({ ...base, meetingSeconds: 3.75 * 3600 })).toMatchObject({ ok: true, warn: true });
    expect(decideLimits({ ...base, meetingSeconds: MEETING_SECONDS })).toEqual({
      ok: false,
      warn: false,
      stop: true,
      reason: "meeting_length",
      remainingSeconds: 0,
      limit: "meeting_length",
    });
  });

  it("names the cap behind a warning (C9): the closest one", () => {
    expect(decideLimits({ ...base, meetingSeconds: 3.8 * 3600 }).limit).toBe("meeting_length");
    expect(decideLimits({ ...base, orgMonthSeconds: ORG_MONTH_SECONDS - 600 })).toMatchObject({ warn: true, limit: "org_month" });
    expect(decideLimits({ ...base, globalDaySeconds: 30 * 3600 - 300 })).toMatchObject({ warn: true, limit: "global_day" });
    expect(decideLimits(base).limit).toBeUndefined();
  });

  it("stops at 20 h per org and month", () => {
    expect(decideLimits({ ...base, orgMonthSeconds: ORG_MONTH_SECONDS })).toMatchObject({ stop: true, reason: "org_month" });
  });

  it("stops at the global daily hours cap", () => {
    expect(decideLimits({ ...base, globalDaySeconds: 30 * 3600 })).toMatchObject({ stop: true, reason: "global_day" });
    expect(decideLimits({ ...base, globalDailyHours: 1, globalDaySeconds: 3600 })).toMatchObject({ reason: "global_day" });
  });

  it("stops at the global dollar cap (≥)", () => {
    expect(decideLimits({ ...base, dayUsd: 24.99 }).stop).toBe(false);
    expect(decideLimits({ ...base, dayUsd: 25 })).toMatchObject({ stop: true, reason: "global_usd" });
  });

  it("treats less than one second left as reached", () => {
    expect(decideLimits({ ...base, meetingSeconds: MEETING_SECONDS - 0.5 })).toMatchObject({ stop: true, reason: "meeting_length" });
  });

  it("kill switch beats everything, then missing consent", () => {
    expect(decideLimits({ ...base, killSwitch: true, consentConfirmed: false, dayUsd: 99 }).reason).toBe("kill_switch");
    expect(decideLimits({ ...base, consentConfirmed: false, dayUsd: 99 }).reason).toBe("no_consent");
  });
});

describe("mintSpacingSeconds (R2)", () => {
  it("5 s for the first 4 mints, then doubling, capped at 10 min", () => {
    expect([0, 1, 4, 5, 6, 7, 10, 11, 14].map((n) => mintSpacingSeconds(n))).toEqual([5, 5, 5, 10, 20, 40, 320, 600, 600]);
  });
});
