import { expect, expectAccessible, test } from "../fixtures";

// The public pages: they render, have no serious accessibility problems, and fit a phone.

test.use({ storageState: { cookies: [], origins: [] } });

for (const [path, heading] of [
  ["/", "Anteckningarna skriver sig själva."],
  ["/login", "Logga in"],
  ["/integritet", null],
] as const) {
  test(`${path} renders and passes axe @phone`, async ({ page }) => {
    await page.goto(path);
    if (heading) await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    else await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectAccessible(page);
    // Nothing wider than the screen (no sideways scrolling at 390 px).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
  });
}
