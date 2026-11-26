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
  await page.getByLabel("Lägg till punkt").fill("Fest på universitetet");
  await page.getByRole("button", { name: "Skapa dagordning" }).click();
  await expect(page.getByText("Dokumentet är skapat")).toBeVisible();

  const [doc] = await fake.files(`Dagordning – ${org.name}`);
  expect(doc, "the agenda Doc in Drive").toBeTruthy();
  const text = await fake.docText(doc.id);
  expect(text).toContain("Fest på universitetet");
  expect(text).toContain("Boka lokal till hackathonet");
  expect(text).toContain("Från förra veckan");

  // The förening page names the next meeting.
  await page.getByRole("link", { name: `Till ${org.name}` }).click();
  await expect(page.getByText("Nästa möte")).toBeVisible();
});
