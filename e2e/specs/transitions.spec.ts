import { expect, test } from "../fixtures";

// Motion on navigation (docs/ui.md): a tab switch fades the förening panel in (CSS `tab-in`,
// components/views/OrgTabsShell.tsx); a link between pages runs a view transition typed "nav"
// (app/(app)/layout.tsx). The suite runs with reduced motion, so these specs turn it off and
// check that the animation is actually started, not only that the content swaps.

type Recorded = { anims: { name: string; inSettings: boolean }[]; vts: string[][] };

test.describe("transitions", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const rec: Recorded = { anims: [], vts: [] };
      (window as unknown as { __motion: Recorded }).__motion = rec;
      document.addEventListener("animationstart", (e) => {
        const el = e.target as Element;
        rec.anims.push({ name: e.animationName, inSettings: Boolean(el.closest?.("[data-tab-in]")?.textContent?.includes("Radera föreningen")) });
      });
      const start = document.startViewTransition?.bind(document);
      if (start) {
        document.startViewTransition = ((arg: Parameters<typeof start>[0]) => {
          rec.vts.push(typeof arg === "object" && arg && "types" in arg ? [...(arg.types ?? [])] : []);
          return start(arg);
        }) as typeof document.startViewTransition;
      }
    });
  });

  const motion = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { __motion: Recorded }).__motion);

  test("a tab switch fades the panel in; a page load doesn't", async ({ page, seedOrg }) => {
    const org = await seedOrg();
    await page.goto(org.url);
    const tabs = page.getByRole("navigation", { name: "Föreningens vyer" });
    await expect(tabs.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("[data-tab-in]")).toHaveCount(0);
    expect((await motion(page)).anims.filter((a) => a.name === "tab-in")).toHaveLength(0);

    await tabs.getByRole("link", { name: "Inställningar" }).click();
    await expect(page.getByRole("heading", { name: "Radera föreningen", exact: true })).toBeVisible();
    await expect.poll(async () => (await motion(page)).anims.some((a) => a.name === "tab-in" && a.inSettings)).toBe(true);

    // Back to a kept tab: it fades in again (no new server content needed).
    const before = (await motion(page)).anims.filter((a) => a.name === "tab-in").length;
    await tabs.getByRole("link", { name: "Möten" }).click();
    await expect(tabs.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "page");
    await expect.poll(async () => (await motion(page)).anims.filter((a) => a.name === "tab-in").length).toBeGreaterThan(before);
  });

  test("a link between pages runs a view transition", async ({ page }) => {
    await page.goto("/hem");
    const rail = page.getByRole("navigation", { name: "Huvudmeny" });
    await rail.getByRole("link", { name: "Föreningar" }).click();
    await expect(page).toHaveURL(/\/orgs$/);
    await expect.poll(async () => (await motion(page)).vts.some((types) => types.includes("nav"))).toBe(true);
    await rail.getByRole("link", { name: "Hem" }).click();
    await expect(page).toHaveURL(/\/hem$/);
    await expect.poll(async () => (await motion(page)).vts.filter((types) => types.includes("nav")).length).toBeGreaterThanOrEqual(2);
  });
});

test("reduced motion: the tab fade is effectively off", async ({ page, seedOrg }) => {
  const org = await seedOrg();
  await page.goto(org.url);
  const tabs = page.getByRole("navigation", { name: "Föreningens vyer" });
  await tabs.getByRole("link", { name: "Översikt" }).click();
  const panel = page.locator("[data-tab-in] > [data-panel] > *:visible").first();
  await expect(panel).toBeVisible();
  const { name, duration } = await panel.evaluate((el) => ({ name: getComputedStyle(el).animationName, duration: parseFloat(getComputedStyle(el).animationDuration) }));
  expect(name).toBe("tab-in");
  expect(duration).toBeLessThan(0.01);
});
