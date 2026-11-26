import { expect, expectAccessible, fake, seedMeeting, test } from "../fixtures";

// Förbered möte: the draft carries last week's open task, a point typed in the field but never
// added with "Lägg till" still lands on the agenda, and the agenda Doc is written.

test("Förbered möte: Från förra veckan and a typed-but-not-added point reach the Doc @phone", async ({ page, seedOrg, db }) => {
  const org = await seedOrg({ people: ["Anna Berg"] });
  await seedMeeting(db, org, { daysAgo: 7, items: [{ section: "action", text: "Boka lokal till hackathonet", owner: "Anna Berg" }, { section: "decision", text: "Vi kör hackathon" }] });

  await page.goto(`${org.url}/forbered`);
  await expect(page.getByRole("group", { name: "Vilket möte?" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Ta fram dagordningen" }).click();

  // The draft: Från förra veckan holds the open task (and not the decision).
  const agenda = page.getByRole("list", { name: "Dagordning" });
  await expect(agenda).toBeVisible();
  await expect(page.getByText("Boka lokal till hackathonet")).toBeVisible();
  await expect(page.getByText("Vi kör hackathon")).toHaveCount(0);
  await expectAccessible(page);

  // Typed, never added.
  await page.getByLabel("Lägg till punkt").fill("Rekrytering");
  await page.getByRole("button", { name: "Skapa dagordning" }).click();
  await expect(page.getByText("Dokumentet är skapat")).toBeVisible();

  const [doc] = await fake.files(`Dagordning – ${org.name}`);
  expect(doc, "the agenda Doc in Drive").toBeTruthy();
  const text = await fake.docText(doc.id);
  expect(text).toContain("Rekrytering");
  expect(text).toContain("Boka lokal till hackathonet");
  expect(text).toContain("Från förra veckan");

  // Simon's "Rekrytering" bug: the typed point stays on the agenda when it is opened again.
  await page.getByRole("link", { name: `Till ${org.name}` }).click();
  await expect(page.getByText("Nästa möte")).toBeVisible();
  await page.getByRole("link", { name: "Ändra", exact: true }).click();
  // A click before hydration submits the form natively (the page reloads): click until it takes.
  await expect(async () => {
    await page.getByRole("button", { name: "Ta fram dagordningen" }).click();
    await expect(page.getByText("Du ändrar en förberedd dagordning")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  const labels = await page.getByRole("list", { name: "Dagordning" }).getByRole("textbox").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(labels).toContain("Rekrytering");
  expect(await fake.docText(doc.id)).toContain("Rekrytering");
});
