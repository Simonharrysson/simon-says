import { describe, expect, it } from "vitest";
import { handled, markStep, resumeStep, showCard, stepFromNumber, stepNumber, STEP_IDS, type OnboardingState } from "./steps";

const fresh: OnboardingState = { done: [], skipped: [], completedAt: null, dismissedAt: null };
const NOW = "2026-11-26T12:00:00Z";

describe("onboarding steps", () => {
  it("resumes at the first step not handled", () => {
    expect(resumeStep(fresh)).toBe("namn");
    expect(resumeStep({ done: ["namn", "mapp"], skipped: ["styrelsen"] })).toBe("format");
    expect(resumeStep({ done: [...STEP_IDS], skipped: [] })).toBeNull();
  });

  it("marks steps in order; done wins over an earlier skip; a skip never undoes done", () => {
    let s = markStep(fresh, "mapp", "skipped", NOW);
    s = markStep(s, "namn", "done", NOW);
    expect(s).toMatchObject({ done: ["namn"], skipped: ["mapp"] });
    s = markStep(s, "mapp", "done", NOW);
    expect(s).toMatchObject({ done: ["namn", "mapp"], skipped: [] });
    s = markStep(s, "mapp", "skipped", NOW);
    expect(s).toMatchObject({ done: ["namn", "mapp"], skipped: [] });
    expect(handled(s)).toEqual(["namn", "mapp"]);
  });

  it("completes when the last step is handled, and the card hides", () => {
    let s = fresh;
    for (const id of STEP_IDS) {
      expect(s.completedAt).toBeNull();
      s = markStep(s, id, id === "roster" ? "skipped" : "done", NOW);
    }
    expect(s.completedAt).toBe(NOW);
    expect(showCard(s)).toBe(false);
    expect(showCard(fresh)).toBe(true);
    expect(showCard({ ...fresh, dismissedAt: NOW })).toBe(false);
    expect(showCard(null)).toBe(false);
  });

  it("maps step numbers both ways", () => {
    expect(stepNumber("namn")).toBe(1);
    expect(stepFromNumber("6")).toBe("roster");
    expect(stepFromNumber("0")).toBeNull();
    expect(stepFromNumber("x")).toBeNull();
  });
});
