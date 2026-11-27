import { describe, expect, it } from "vitest";
import { cubicBezier, easeOut } from "./motion";

describe("cubicBezier", () => {
  it("is linear for the linear curve", () => {
    const lin = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    for (const x of [0, 0.25, 0.5, 0.9, 1]) expect(lin(x)).toBeCloseTo(x, 4);
  });
  it("eases out: starts fast, ends at 1, never leaves [0, 1]", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.2)).toBeGreaterThan(0.6);
    for (let x = 0; x <= 1; x += 0.05) {
      const y = easeOut(x);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });
});
