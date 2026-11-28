import type { TestInfo } from "@playwright/test";
import { auditBorders, formatOffenders } from "../border-audit";
import { expect, expectAccessible, seedMeeting, test } from "../fixtures";

// /admin (Insikter, migration 0066): the internal dashboard. The shared signed-in admin is in
// ADMIN_EMAILS (e2e/env.ts); everyone else, signed in or not, gets a real 404. Other specs seed
// orgs in parallel on the same stack, so this checks its own org's row, never global totals.

async function size(page: import("@playwright/test").Page, info: TestInfo) {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
}

test("an admin sees the key figures, the weekly charts and every org, searchable and sortable @phone", async ({ page, seedOrg, db }, info) => {
  await size(page, info);
  const org = await seedOrg({ name: `Insiktsforeningen ${Date.now().toString(36)}`, members: ["insikt-medlem@e2e.test"] });
  await seedMeeting(db, org, { daysAgo: 2 });
  await seedMeeting(db, org, { daysAgo: 9 });

  const res = await page.goto("/admin");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Insikter", level: 1 })).toBeVisible();
  // Not linked from the app's navigation.
  await expect(page.getByRole("banner").getByRole("link", { name: "Insikter" })).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  const kpis = page.getByRole("region", { name: "Nyckeltal" });
  for (const label of ["Konton", "Aktiva, 7 dagar", "Aktiva, 30 dagar", "Organisationer", "Möten", "Transkriberat, 30 dagar"]) {
    await expect(kpis.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("status").filter({ hasText: "Fel senaste 7 dagarna" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Möten per vecka" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Nya konton per vecka" })).toBeVisible();

  // The org table: search finds this test's org with its counts (2 members, 2 meetings).
  await page.getByRole("searchbox", { name: "Sök på namn" }).fill(org.name);
  const row = page.getByRole("row").filter({ hasText: org.name });
  await expect(row).toHaveCount(1);
  // Its kind (a column on a desktop, under the name on a phone), 2 members and 2 meetings.
  await expect(row.getByText("Förening", { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(row.getByRole("cell").filter({ hasText: /^2$/ })).toHaveCount(2);
  await page.getByRole("combobox", { name: "Typ" }).selectOption("foretag");
  await expect(row).toHaveCount(0);
  await expect(page.getByText("Inga organisationer matchar.")).toBeVisible();
  await page.getByRole("combobox", { name: "Typ" }).selectOption("all");
  await expect(row).toHaveCount(1);

  // Sorting: a column header toggles its direction.
  const members = page.getByRole("columnheader", { name: "Medlemmar", exact: true });
  await members.getByRole("button").click();
  await expect(members).toHaveAttribute("aria-sort", "descending");
  await members.getByRole("button").click();
  await expect(members).toHaveAttribute("aria-sort", "ascending");

  // Nothing private on the page: no e-mail address of anyone.
  expect(await page.locator("main").innerText()).not.toMatch(/@e2e\.test/);

  // The page never scrolls sideways (the table has its own scroll box).
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(formatOffenders("/admin", await auditBorders(page)), "double borders").toEqual([]);
  await expectAccessible(page);
});

test("a signed-in member who is not an admin gets a real 404", async ({ signedIn, newEmail }) => {
  const { page } = await signedIn(newEmail("inte-admin"), "/orgs");
  const res = await page.goto("/admin");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
  await expect(page.getByText("Konton", { exact: true })).toHaveCount(0);
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a visitor gets a real 404, not the login", async ({ page }) => {
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(404);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
  });
});
