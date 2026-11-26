import { OPERATORS } from "../env";
import { expect, expectAccessible, fake, queuePick, seedMeeting, test } from "../fixtures";

// The förening page: the Mötesformat "Ändra" menu, settings, deleting a meeting and the förening,
// and the service admin's Testmöte menu.

test("Mötesformat: Ändra → Byt format, and Välj mötesmapp in the Picker @phone", async ({ page, seedOrg, db }) => {
  const org = await seedOrg();
  await page.goto(org.url);
  const card = page.locator("section", { has: page.getByRole("heading", { name: "Mötesformat" }) });
  await expect(card).toBeVisible();

  await expectAccessible(page);
  await card.getByRole("button", { name: "Ändra" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  // (No axe while the menu is open: Radix aria-hides the page behind its modal menu, which axe
  // reports as focusable content under aria-hidden although focus is trapped in the menu.)
  await page.getByRole("menuitem", { name: /Byt format/ }).click();
  await card.getByLabel("Byt format").selectOption({ label: "Styrelseprotokoll" });
  await card.getByRole("button", { name: "Byt", exact: true }).click();
  await expect(card.getByText("Styrelseprotokoll", { exact: true })).toBeVisible();

  // Välj mötesmapp: the Picker hands back a folder the admin owns.
  const folder = await fake.createDoc({ name: `Möten ${org.name}`, mimeType: "application/vnd.google-apps.folder" });
  await queuePick(page, [{ id: folder.id, name: folder.name, mimeType: "application/vnd.google-apps.folder" }]);
  await card.getByRole("button", { name: "Ändra" }).click();
  await page.getByRole("menuitem", { name: /Välj mötesmapp/ }).click();
  await expect(card.getByText(`Mötesmapp: ${folder.name}`)).toBeVisible();
  const { data } = await db.from("orgs").select("meeting_folder_id").eq("id", org.id).single();
  expect(data?.meeting_folder_id).toBe(folder.id);
});

test("settings: rename the förening and stop sharing the transcript", async ({ page, seedOrg }) => {
  const org = await seedOrg();
  await page.goto(org.url);
  const settings = page.locator("section", { has: page.getByRole("heading", { name: "Inställningar" }) });
  const newName = `${org.name} (ny)`;
  await settings.getByRole("textbox", { name: "Namn", exact: true }).fill(newName);
  await settings.getByRole("checkbox", { name: /Dela transkriptionen i dokumentet/ }).uncheck();
  await settings.getByRole("button", { name: "Spara ändringar" }).click();
  await expect(settings.getByText("Sparat")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(newName);
  await expect(settings.getByRole("checkbox", { name: /Dela transkriptionen i dokumentet/ })).not.toBeChecked();
  await expectAccessible(page);

  // The account page.
  await page.goto("/installningar");
  await expect(page.getByRole("main").getByText("admin@e2e.test")).toBeVisible();
  await expectAccessible(page);
});

test("delete a meeting, then the förening (confirm dialogs)", async ({ page, seedOrg, db }) => {
  const org = await seedOrg();
  const meeting = await seedMeeting(db, org, { daysAgo: 2, items: [{ section: "decision", text: "Ett beslut" }] });
  await page.goto(org.url);
  const meetings = page.getByRole("list", { name: "Möten" });
  await expect(meetings.getByRole("listitem")).toHaveCount(1);

  await meetings.getByRole("button", { name: /Radera mötet/ }).click();
  const dialog = page.getByRole("dialog", { name: "Radera mötet?" });
  await expect(dialog).toContainText("Google-dokumentet ligger kvar i Drive");
  await expectAccessible(page);
  // Avbryt keeps it.
  await dialog.getByRole("button", { name: "Avbryt" }).click();
  await expect(meetings.getByRole("listitem")).toHaveCount(1);

  await meetings.getByRole("button", { name: /Radera mötet/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Radera mötet" }).click();
  await expect(page.getByText("Mötet är raderat.")).toBeVisible();
  await expect(page.getByText("Inga möten än")).toBeVisible();
  const { count } = await db.from("meetings").select("id", { count: "exact", head: true }).eq("id", meeting.id);
  expect(count).toBe(0);
  // The Doc stays in Drive.
  expect((await fake.doc(meeting.docId))?.trashed).toBe(false);

  // Radera föreningen needs the name typed.
  await page.getByRole("button", { name: "Radera föreningen" }).click();
  const confirm = page.getByRole("dialog", { name: `Radera ${org.name}?` });
  const go = confirm.getByRole("button", { name: "Radera för alltid" });
  await expect(go).toBeDisabled();
  await confirm.getByRole("textbox").fill(org.name);
  await go.click();
  await expect(page).toHaveURL(/\/orgs\?klart=raderad/);
  await expect(page.getByText("Föreningen är raderad.")).toBeVisible();
});

test("Testmöte menu: Utan dagordning starts a replay, Avsluta mötet ends it from the row", async ({ seedOrg, signedIn, db }, testInfo) => {
  const operator = OPERATORS[testInfo.retry % OPERATORS.length];
  const org = await seedOrg({ admin: operator });
  const { page } = await signedIn(operator, org.url);
  await page.getByRole("button", { name: "Testmöte" }).click();
  await expect(page.getByRole("menuitem", { name: /Med dagordning/ })).toBeVisible();
  await page.getByRole("menuitem", { name: /Utan dagordning/ }).click();

  await expect(page.getByText("Ett möte pågår")).toBeVisible({ timeout: 30_000 });
  const meetings = page.getByRole("list", { name: "Möten" });
  await expect(meetings).toContainText("Pågår");
  const { data: m } = await db.from("meetings").select("id, doc_id, is_test").eq("org_id", org.id).single();
  expect(m?.is_test).toBe(true);
  expect((await fake.doc(m!.doc_id))?.name).toContain("Testmöte");

  await meetings.getByRole("button", { name: "Avsluta mötet" }).click();
  await page.getByRole("dialog", { name: "Avsluta mötet?" }).getByRole("button", { name: "Avsluta mötet" }).click();
  await expect(page.getByText("Mötet avslutas.")).toBeVisible();
  await expect.poll(async () => (await db.from("meetings").select("status").eq("id", m!.id).single()).data?.status, { timeout: 60_000 }).toBe("done");
});

test("an unknown förening is a real 404 with one header for a signed-in user", async ({ page }) => {
  const res = await page.goto("/orgs/00000000-0000-4000-8000-000000000001");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
  // One header, one <main>, no "Logga in" for someone signed in.
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Logga in" })).toHaveCount(0);
  await expectAccessible(page);
  expect((await page.goto("/orgs/inte-ett-id/forbered"))?.status()).toBe(404);
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a förening page sends to the login first, and back after signing in", async ({ page, seedOrg, nextLogin }) => {
    const org = await seedOrg();
    await page.goto(`${org.url}?flik=oversikt`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(org.url)}$`));
    nextLogin.email = "admin@e2e.test";
    await page.getByRole("button", { name: "Logga in med Google" }).click();
    await expect(page).toHaveURL(new RegExp(`${org.url}$`));
    await expect(page.getByText("Du är admin")).toBeVisible();
  });
});
