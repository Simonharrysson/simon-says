import { SCRIPTED } from "../fakes/scripted";
import { expect, expectAccessible, fake, seedMeeting, test } from "../fixtures";

// Inställningar → Vad Claude ska veta (0065): Uppdatera → the fake Claude's lines, each with its
// source meeting (a line citing a meeting it wasn't sent is dropped) → an admin changes one and adds
// one → Spara → reloaded, both stay and the changed one is marked "Ändrad av er".

test("Vad Claude ska veta: Uppdatera from the meetings, edit and add a line, save, reload @phone", async ({ page, seedOrg, db }) => {
  test.setTimeout(90_000);
  const org = await seedOrg();
  const meeting = await seedMeeting(db, org, { daysAgo: 2, items: [{ section: "decision", text: "Hackathonet hålls i Kårallen" }] });

  await page.goto(`${org.url}?flik=installningar&del=claude`);
  await expect(page.getByRole("heading", { name: "Vad Claude ska veta", exact: true })).toBeVisible();
  await expect(page.getByText("Inte byggd än.")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Uppdatera från mötena" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Klart: 2 rader från 1 möte." })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: "Kunder, rad 1" })).toHaveValue(SCRIPTED.memory.customer);
  await expect(page.getByRole("textbox", { name: "Ordlista, rad 1" })).toHaveValue(SCRIPTED.memory.glossary);
  // The line citing a meeting Claude wasn't sent never lands.
  await expect(page.getByRole("textbox", { name: "Prioriteringar, rad 1" })).toHaveCount(0);
  await expect(page.locator(`a[href="/orgs/${org.id}/mote/${meeting.id}"]`).first()).toBeVisible();
  await expect(page.getByText(/^Byggd från 1 möte sedan /)).toBeVisible();
  const calls = await fake.claudeCalls("memory");
  expect(calls.some((c) => c.text.includes("Hackathonet hålls i Kårallen"))).toBe(true);

  // Change one, add one, save.
  await page.getByRole("textbox", { name: "Ordlista, rad 1" }).fill("KS = kommunikationsstyrelsen, styrelsens utskott");
  const people = page.getByRole("region", { name: "Vem är vem" });
  await people.getByRole("button", { name: "Lägg till rad" }).click();
  await page.getByRole("textbox", { name: "Vem är vem, rad 1" }).fill("Anna Berg är kassör");
  await expect(page.getByText("Osparade ändringar")).toBeVisible();
  await page.getByRole("button", { name: "Spara", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sparat." })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Ordlista, rad 1" })).toHaveValue("KS = kommunikationsstyrelsen, styrelsens utskott");
  await expect(page.getByRole("textbox", { name: "Vem är vem, rad 1" })).toHaveValue("Anna Berg är kassör");
  await expect(page.getByRole("textbox", { name: "Kunder, rad 1" })).toHaveValue(SCRIPTED.memory.customer);
  await expect(page.getByText("Ändrad av er")).toHaveCount(2);
  await expectAccessible(page);

  // A line built from a meeting the admin can't see (another förening's) never reaches the page.
  const other = await seedOrg({ admin: "someone-else@e2e.test" });
  const hidden = await seedMeeting(db, other, { startedBy: "someone-else@e2e.test" });
  const { data: row } = await db.from("org_memory").select("lines").eq("org_id", org.id).single();
  const lines = [...((row?.lines ?? []) as unknown[]), { id: "hidden1", section: "priorities", text: "Hemlig rad från en annan förening", sources: [hidden.id], edited: false }];
  await db.from("org_memory").update({ lines }).eq("org_id", org.id);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Kunder, rad 1" })).toHaveValue(SCRIPTED.memory.customer);
  await expect(page.getByRole("textbox", { name: "Prioriteringar, rad 1" })).toHaveCount(0);
  await expect(page.getByText("Hemlig rad från en annan förening")).toHaveCount(0);
});
