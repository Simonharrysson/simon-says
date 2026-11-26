import { randomUUID } from "node:crypto";
import { SCRIPTED } from "../fakes/scripted";
import { expect, expectAccessible, fake, test } from "../fixtures";

// Concrete tasks (docs/superpowers/specs/2026-11-26-concrete-tasks-design.md): a förening that
// requires Vem, När and Klart när (the default). The scripted Claude adds two tasks without När
// and Klart när: the Doc shows the placeholders and the live page's Uppgifter asks about them.
// Avsluta lists them: one is completed inline, one left as it is, then the meeting ends and the
// final pass writes the answers into the Doc.

const [fika, plan] = SCRIPTED.incomplete;

test("incomplete tasks → Avsluta asks: complete one inline, leave one → ends; the Doc shows the fields", async ({ seedOrg, signedIn, newEmail, db }) => {
  const email = newEmail("ordf");
  const org = await seedOrg({ admin: email, name: `${SCRIPTED.tasksOrg} ${randomUUID().slice(0, 6)}`, people: ["Erik Lund", "Anna Berg"] });
  const { page } = await signedIn(email, org.url);

  await page.getByRole("link", { name: "Starta möte", exact: true }).click();
  // No agenda in the folder: a new Doc in the förening's format, chosen without a click.
  await expect(page.locator("p").filter({ hasText: /^Nytt dokument i / })).toBeVisible();
  // The tick, retried until it sticks: a click before hydration does nothing.
  const consent = page.getByRole("checkbox", { name: "Alla i rummet vet att mötet transkriberas och kan be om paus" });
  await expect(async () => {
    await consent.check({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Starta mötet" }).click();
  await expect(page.getByRole("heading", { name: "Namnrunda" })).toBeVisible({ timeout: 30_000 });
  const meetingId = page.url().split("/").at(-1)!;
  const [doc] = await fake.files(`Mötesprotokoll – ${org.name}`);
  await page.getByRole("button", { name: "Hoppa över" }).click();

  // The Doc writes what is missing visibly.
  await expect.poll(() => fake.docText(doc.id), { timeout: 60_000, message: "the incomplete tasks in the Doc" }).toContain(fika);
  const live = await fake.docText(doc.id);
  expect(live).toMatch(new RegExp(`${fika} \\(deadline\\?\\) – \\(klart när\\?\\)`));
  expect(live).toMatch(new RegExp(`${SCRIPTED.action} \\(${SCRIPTED.actionDue}\\) – klart när: ${SCRIPTED.actionDoneWhen}`));

  // Uppgifter on the live page asks, calmly.
  const panel = page.getByRole("list", { name: "Uppgifter" });
  await expect(panel.getByRole("listitem").filter({ hasText: fika })).toContainText("Vem ansvarar och när ska det vara klart?", { timeout: 30_000 });
  await expectAccessible(page);

  await page.getByRole("button", { name: "Avsluta", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Avsluta mötet?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  const end = dialog.getByRole("button", { name: "Avsluta mötet" });
  await expect(end).toBeDisabled();
  await expectAccessible(page);

  const first = dialog.getByRole("listitem", { name: fika });
  await first.getByLabel("När", { exact: true }).fill("torsdag");
  await first.getByLabel("Klart när", { exact: true }).fill("fikat är köpt");
  await first.getByRole("button", { name: "Spara" }).click();
  await expect(first).toContainText("Skrivs in i dokumentet");
  await expect(end).toBeDisabled();
  await dialog.getByRole("listitem", { name: plan }).getByRole("button", { name: "Lämna som det är" }).click();
  await expect(end).toBeEnabled();
  await end.click();

  await expect(page.getByRole("heading", { name: "Mötet är avslutat" })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => fake.docText(doc.id), { timeout: 30_000 }).toMatch(/Avslutat \d{2}:\d{2}|avslutat \d{2}:\d{2}/);
  const ended = await fake.docText(doc.id);
  expect(ended).toMatch(new RegExp(`${fika} \\(torsdag\\) – klart när: fikat är köpt`));
  // Left as it is: still says what is missing.
  expect(ended).toMatch(new RegExp(`${plan} \\(deadline\\?\\) – \\(klart när\\?\\)`));
  const { data: rows } = await db.from("note_items").select("text, due, done_when").eq("meeting_id", meetingId);
  expect(rows?.find((r) => r.text === fika)).toMatchObject({ due: "torsdag", done_when: "fikat är köpt" });
});
