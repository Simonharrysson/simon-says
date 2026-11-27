import { test, expect } from "@playwright/test";
import { auditBorders, formatOffenders } from "../e2e/border-audit";
for (const [v, w] of [["foretag-canvas", 1440], ["foretag-canvas-member", 1440], ["foretag-canvas", 390], ["foretag-canvas-member", 390]] as const) {
  test(`${v} ${w}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`http://localhost:3457/design?vy=${v}`);
    await page.waitForTimeout(2500);
    expect(formatOffenders(v, await auditBorders(page))).toEqual([]);
  });
}
