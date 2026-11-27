import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SCRIPTED } from "../fakes/scripted";
import { expect, expectAccessible, fake, test } from "../fixtures";

// Concrete tasks (docs/superpowers/specs/2026-11-26-concrete-tasks-design.md): a förening that
// requires Vem, När and Klart när (the default). The scripted Claude adds two tasks without När
// and Klart när: the Doc shows the placeholders and the live page's Uppgifter asks about them.
// Avsluta lists them as a gentle offer: fill in, leave as it is, or "Avsluta ändå" in one tap.
// Admins can turn the question off from the dialog (with Ångra). Each end logs counts only
// (meeting_events 'end_tasks'); turning it off from the dialog logs 'task_setting'.

const [fika, plan] = SCRIPTED.incomplete;

/** Start a meeting in a new förening that asks (the default) and wait for both incomplete tasks on the live page. */
async function startWithIncompleteTasks(page: Page, orgName: string) {
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
  const [doc] = await fake.files(`Mötesprotokoll – ${orgName}`);
  await page.getByRole("button", { name: "Hoppa över" }).click();
  const panel = page.getByRole("list", { name: "Uppgifter" });
  await expect(panel.getByRole("listitem").filter({ hasText: fika })).toContainText("Vem ansvarar och när ska det vara klart?", { timeout: 90_000 });
  await expect(panel.getByRole("listitem").filter({ hasText: plan })).toBeVisible();
  return { meetingId, doc };
}

const endTasksEvents = async (db: SupabaseClient, meetingId: string) =>
  (await db.from("meeting_events").select("detail").eq("meeting_id", meetingId).eq("kind", "end_tasks").order("id")).data?.map((r) => r.detail);

test("incomplete tasks → Avsluta asks: complete one inline, leave one → ends; the Doc shows the fields", async ({ seedOrg, signedIn, newEmail, db }) => {
  const email = newEmail("ordf");
  const org = await seedOrg({ admin: email, name: `${SCRIPTED.tasksOrg} ${randomUUID().slice(0, 6)}`, people: ["Erik Lund", "Anna Berg"] });
  const { page } = await signedIn(email, org.url);

  const { meetingId, doc } = await startWithIncompleteTasks(page, org.name);

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
  // Never a gate: ending is always one tap away.
  await expect(dialog.getByRole("button", { name: "Avsluta ändå" })).toBeEnabled();
  await expectAccessible(page);

  const first = dialog.getByRole("listitem", { name: fika });
  await first.getByLabel("När", { exact: true }).fill("torsdag");
  // Enter with a field still empty names it and moves there, never a silent nothing.
  await first.getByLabel("När", { exact: true }).press("Enter");
  await expect(first.getByRole("status")).toContainText("klart när");
  await expect(first.getByLabel("Klart när", { exact: true })).toBeFocused();
  // Fortsätt mötet and back: what was typed is still there.
  await dialog.getByRole("button", { name: "Fortsätt mötet" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Avsluta", exact: true }).click();
  await expect(first.getByLabel("När", { exact: true })).toHaveValue("torsdag");
  await first.getByLabel("Klart när", { exact: true }).fill("fikat är köpt");
  await first.getByLabel("Klart när", { exact: true }).press("Enter");
  await expect(first).toContainText("Skrivs in i dokumentet");
  await dialog.getByRole("listitem", { name: plan }).getByRole("button", { name: "Lämna som det är" }).click();
  // Every task handled: the button says so.
  await dialog.getByRole("button", { name: "Avsluta mötet" }).click();

  await expect(page.getByRole("heading", { name: "Mötet är avslutat" })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => fake.docText(doc.id), { timeout: 30_000 }).toMatch(/Avslutat \d{2}:\d{2}|avslutat \d{2}:\d{2}/);
  const ended = await fake.docText(doc.id);
  expect(ended).toMatch(new RegExp(`${fika} \\(torsdag\\) – klart när: fikat är köpt`));
  // Left as it is: still says what is missing.
  expect(ended).toMatch(new RegExp(`${plan} \\(deadline\\?\\) – \\(klart när\\?\\)`));
  const { data: rows } = await db.from("note_items").select("text, due, done_when").eq("meeting_id", meetingId);
  expect(rows?.find((r) => r.text === fika)).toMatchObject({ due: "torsdag", done_when: "fikat är köpt" });
  expect(await endTasksEvents(db, meetingId)).toEqual([{ incomplete: 2, filled: 1, dismissed: 1, untouched: 0, skipped: false }]);
});

test("Avsluta ändå ends in one tap, nothing filled in; the counts are logged", async ({ seedOrg, signedIn, newEmail, db }) => {
  const email = newEmail("ordf");
  const org = await seedOrg({ admin: email, name: `${SCRIPTED.tasksOrg} ${randomUUID().slice(0, 6)}`, people: ["Erik Lund"] });
  const { page } = await signedIn(email, org.url);
  const { meetingId, doc } = await startWithIncompleteTasks(page, org.name);

  await page.getByRole("button", { name: "Avsluta", exact: true }).click();
  await page.getByRole("dialog", { name: "Avsluta mötet?" }).getByRole("button", { name: "Avsluta ändå" }).click();

  await expect(page.getByRole("heading", { name: "Mötet är avslutat" })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => fake.docText(doc.id), { timeout: 30_000 }).toMatch(new RegExp(`${plan} \\(deadline\\?\\) – \\(klart när\\?\\)`));
  await expect.poll(() => endTasksEvents(db, meetingId), { timeout: 15_000 }).toEqual([{ incomplete: 2, filled: 0, dismissed: 0, untouched: 2, skipped: true }]);
});

test("an admin turns the question off from the dialog, Ångra turns it back on; off → Avsluta asks the usual question", async ({ seedOrg, signedIn, newEmail, db }) => {
  const email = newEmail("ordf");
  const org = await seedOrg({ admin: email, name: `${SCRIPTED.tasksOrg} ${randomUUID().slice(0, 6)}`, people: ["Erik Lund"] });
  const { page } = await signedIn(email, org.url);
  const { meetingId } = await startWithIncompleteTasks(page, org.name);
  const asks = async () => (await db.from("orgs").select("require_task_fields").eq("id", org.id).single()).data?.require_task_fields;

  await page.getByRole("button", { name: "Avsluta", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Avsluta mötet?" });
  await dialog.getByRole("button", { name: "Fråga inte igen i den här föreningen" }).click();
  await expect(dialog.getByRole("status")).toContainText("Vi frågar inte igen i den här föreningen.");
  await expect(dialog.getByRole("button", { name: "Ångra" })).toBeFocused();
  await expect.poll(asks).toBe(false);
  await expectAccessible(page);

  await dialog.getByRole("button", { name: "Ångra" }).click();
  await expect(dialog.getByRole("button", { name: "Fråga inte igen i den här föreningen" })).toBeVisible();
  await expect.poll(asks).toBe(true);

  // Off again, then keep the meeting going: the next Avsluta asks only the usual question.
  await dialog.getByRole("button", { name: "Fråga inte igen i den här föreningen" }).click();
  await expect(dialog.getByRole("status")).toContainText("Vi frågar inte igen");
  await expect.poll(asks).toBe(false);
  await dialog.getByRole("button", { name: "Fortsätt mötet" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Avsluta", exact: true }).click();
  const usual = page.getByRole("dialog", { name: "Avsluta mötet?" });
  await expect(usual).toContainText("Ljudet stängs av");
  await expect(usual.getByRole("button", { name: "Fråga inte igen i den här föreningen" })).toHaveCount(0);
  await usual.getByRole("button", { name: "Avsluta mötet" }).click();
  await expect(page.getByRole("heading", { name: "Mötet är avslutat" })).toBeVisible({ timeout: 60_000 });

  const { data: events } = await db.from("meeting_events").select("detail").eq("meeting_id", meetingId).eq("kind", "task_setting").order("id");
  expect(events?.map((e) => e.detail)).toEqual([
    { on: false, from: "end_dialog" },
    { on: true, from: "end_dialog" },
    { on: false, from: "end_dialog" },
  ]);
  // The dialog never ended this meeting: nothing to count.
  expect(await endTasksEvents(db, meetingId)).toEqual([]);
});
