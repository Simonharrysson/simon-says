import { SCRIPTED } from "../fakes/scripted";
import { expect, expectAccessible, fake, seedMeeting, test } from "../fixtures";

// Översikt: goals proposed by (scripted) Claude and approved; the protocol import's small path
// (read access → folder → Docs → read directly → goals).

test("Översikt: Föreslå mål → edit → Godkänn målen @phone", async ({ page, seedOrg, db }) => {
  const org = await seedOrg({ people: ["Anna Berg"] });
  for (const daysAgo of [21, 14, 7]) {
    await seedMeeting(db, org, { daysAgo, items: [{ section: "decision", text: `Hackathon-beslut ${daysAgo}` }, { section: "action", text: "Boka lokal", owner: "Anna Berg" }] });
  }
  await page.goto(`${org.url}?flik=oversikt`);
  await expect(page.getByRole("link", { name: "Översikt" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Mål" })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Föreslå mål" }).click();
  await expect(page.getByLabel("Mål 1", { exact: true })).toHaveValue(SCRIPTED.goals[0].title);
  await expect(page.getByLabel("Mål 2", { exact: true })).toHaveValue(SCRIPTED.goals[1].title);
  expect(await fake.claudeCalls("goals")).not.toHaveLength(0);
  await expectAccessible(page);

  // The admin edits before approving.
  await page.getByLabel("Mål 2", { exact: true }).fill("Ett hackathon den 14 februari");
  await page.getByRole("button", { name: "Godkänn målen" }).click();

  const goals = page.getByRole("list", { name: "Mål" });
  await expect(goals).toContainText(SCRIPTED.goals[0].title);
  await expect(goals).toContainText("Ett hackathon den 14 februari");
  await page.reload();
  await expect(page.getByRole("list", { name: "Mål" })).toContainText("Ett hackathon den 14 februari");
});

test("protocol import, small path: read access → folder → Docs → goals", async ({ page, seedOrg }) => {
  const org = await seedOrg();
  const folder = await fake.createDoc({ name: `Protokoll ${org.name}`, mimeType: "application/vnd.google-apps.folder", owner: "admin@e2e.test" });
  for (const date of ["2025-09-02", "2025-09-16", "2025-10-07"]) {
    await fake.createDoc({
      name: `${date} Styrelsemöte`,
      parents: [folder.id],
      owner: "admin@e2e.test",
      createdTime: `${date}T18:00:00Z`,
      modifiedTime: `${date}T20:00:00Z`,
      paragraphs: [
        { text: `Styrelsemöte ${date}`, style: "HEADING_1" },
        { text: "Närvarande: Anna Berg, Erik Lund" },
        { text: "Beslut: hackathonet planeras till februari." },
        { text: "Att göra: Anna bokar lokal." },
      ],
    });
  }

  await page.goto(`${org.url}?flik=oversikt`);
  await page.getByRole("button", { name: "Läs in gamla protokoll" }).click();
  await page.getByRole("button", { name: "Ge åtkomst" }).click();

  // Back from Google's consent with read access: step 1, the folders.
  await expect(page.getByText("Steg 1 av 2: Välj mapparna med protokollen")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: `Välj ${folder.name}` }).check();
  await page.getByRole("button", { name: "Visa mötena i 1 mapp" }).click();

  await expect(page.getByText("Steg 2 av 2: Välj protokollen")).toBeVisible();
  const docs = page.getByRole("list", { name: "Dokument" });
  await expect(docs.getByRole("listitem")).toHaveCount(3);
  await page.getByLabel(/Välj alla som inte är inlästa/).check();
  await page.getByRole("button", { name: "Fortsätt med 3 protokoll" }).click();

  await expect(page.getByText("3 möten att läsa in")).toBeVisible();
  await page.getByRole("button", { name: "Läs in 3 protokoll" }).click();

  // Read directly (small import), then the goals over the whole history.
  await expect(page.getByLabel("Mål 1", { exact: true })).toHaveValue("Ett hackathon i februari", { timeout: 60_000 });
  expect(await fake.claudeCalls("extract")).not.toHaveLength(0);
  await page.getByRole("button", { name: "Godkänn målen" }).click();
  await expect(page.getByRole("list", { name: "Mål" })).toContainText("Ett hackathon i februari");
  await expect(page.getByText(/3 inlästa gamla protokoll/)).toBeVisible();
});
