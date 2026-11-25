import { describe, expect, it } from "vitest";
import { autoStopText, limitWarningText, stopParam } from "./limit-copy";

describe("limit copy (C9)", () => {
  it("says which limit stopped the meeting", () => {
    expect(autoStopText("meeting_length")).toMatch(/4 timmar/);
    expect(autoStopText("org_month")).toMatch(/20 timmar den här månaden/);
    expect(autoStopText("global_usd")).toMatch(/dagens gräns för hela tjänsten/);
    expect(autoStopText("el_service")).toMatch(/kvot är slut – meddela den som driver Simon Says/);
    expect(autoStopText(undefined)).toBe("Mötet avslutades automatiskt.");
    for (const r of ["org_month", "global_day", "el_service", undefined]) expect(autoStopText(r)).not.toMatch(/4 timmar/);
  });

  it("warns per reason", () => {
    expect(limitWarningText("meeting_length")).toMatch(/högst 4 timmar/);
    expect(limitWarningText("org_month")).toMatch(/Föreningens 20 timmar/);
    expect(limitWarningText("global_day")).not.toMatch(/4 timmar/);
  });

  it("stopParam keeps only plain reason codes", () => {
    expect(stopParam("org_month")).toBe("org_month");
    expect(stopParam("x&y=1")).toBe("1");
    expect(stopParam(null)).toBe("1");
  });
});
