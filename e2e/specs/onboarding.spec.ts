import { expect, expectAccessible, test } from "../fixtures";

// Landing → Logga in med Google → create a förening → Kom igång (some steps done, some skipped)
// → the förening page. A brand-new user each time (a user may create at most two föreningar).

test.use({ storageState: { cookies: [], origins: [] } });

test("a new user signs in, creates a förening and goes through Kom igång @phone", async ({ page, nextLogin, newEmail }) => {
  nextLogin.email = newEmail("ny");
  const orgName = `Testföreningen ${Date.now().toString(36)}`;

  await page.goto("/");
  await page.getByRole("button", { name: "Kom igång med Google" }).first().click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Föreningar" })).toBeVisible();
  await expect(page.getByText("Du är inte med i någon förening än")).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Namn").fill(orgName);
  await page.getByRole("button", { name: "Skapa" }).click();
  await expect(page).toHaveURL(/\/kom-igang/);

  // 1. Namn och logga
  await expect(page.getByRole("heading", { name: "Välkommen! Hur ser ni ut?" })).toBeVisible();
  await expect(page.getByLabel("Föreningens namn")).toHaveValue(orgName);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Fortsätt" }).click();

  // 2. Styrelsen: add one person
  await expect(page.getByRole("heading", { name: "Vilka sitter i styrelsen?" })).toBeVisible();
  await page.getByLabel("Namn", { exact: true }).fill("Anna Berg");
  await page.getByLabel("Roll").fill("Ordförande");
  await page.getByRole("button", { name: "Lägg till", exact: true }).click();
  await expect(page.getByRole("list", { name: "Styrelsen" })).toContainText("Anna Berg");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Fortsätt" }).click();

  // 3. Mötesmapp: skip
  await expect(page.getByRole("heading", { name: "Var ska mötesdokumenten ligga?" })).toBeVisible();
  await page.getByRole("button", { name: "Hoppa över" }).click();

  // 4. Format: keep Veckomöte
  await expect(page.getByRole("heading", { name: "Så brukar ni ha möten" })).toBeVisible();
  await page.getByRole("button", { name: "Fortsätt" }).click();

  // 5. Protokoll: skip
  await expect(page.getByRole("heading", { name: "Era tidigare möten" })).toBeVisible();
  await page.getByRole("button", { name: "Hoppa över" }).click();

  // 6. Röster: skip
  await expect(page.getByRole("heading", { name: "Röster (valfritt)" })).toBeVisible();
  await page.getByRole("button", { name: "Hoppa över" }).click();

  // Klart
  await expect(page.getByRole("heading", { name: "Nu är ni redo" })).toBeVisible();
  await expect(page.getByText("Styrelsen: klart", { exact: true })).toBeAttached();
  await expect(page.getByText("Mötesmapp: hoppades över", { exact: true })).toBeAttached();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Till föreningen" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText(orgName);
  await expect(page.getByText("Du är admin")).toBeVisible();
  // The board person is on the förening's board list (Inställningar).
  await page.getByRole("navigation", { name: "Föreningens vyer" }).getByRole("link", { name: "Inställningar" }).click();
  await expect(page.getByRole("list", { name: "Styrelsen" })).toContainText("Anna Berg");
  await expectAccessible(page);
});
