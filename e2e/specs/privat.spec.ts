import type { Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SCRIPTED } from "../fakes/scripted";
import { ensureUser, expect, expectAccessible, fake, test } from "../fixtures";

// Privat (0045): a personal recording with the fake ElevenLabs (the fake mic plays a tone, the fake
// transcribes it) and no Google Doc → the notes land in the database → Avsluta → one Claude
// summary (the fake) → the summary e-mail through the fake mailer → the context page lists the
// task. A second recording in the same context gets "Sedan sist" (the first task: klart).

const P = SCRIPTED.privat;

async function record(page: Page, db: SupabaseClient, pick: (page: Page) => Promise<void>): Promise<string> {
  await expect(page.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();
  await expect(page.getByText("Anteckningarna sparas bara hos dig i Privat.")).toBeVisible();
  // The consent tick first, retried until it sticks: a click before hydration does nothing, and once
  // it holds the page is hydrated (a value typed before that would be reset).
  const consent = page.getByRole("checkbox", { name: "Alla i rummet vet att mötet transkriberas och kan be om paus" });
  await expect(async () => {
    await consent.check({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await pick(page);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Starta mötet" }).click();
  await expect(page.getByRole("heading", { name: "Namnrunda" })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  const meetingId = page.url().split("/").at(-1)!;
  await page.getByRole("button", { name: "Hoppa över" }).click();

  // No Doc: the engine's notes are stored in the database only.
  const { data: m } = await db.from("meetings").select("doc_id, context_id").eq("id", meetingId).single();
  expect(m?.doc_id).toBeNull();
  expect(m?.context_id).toBeTruthy();
  await expect
    .poll(async () => ((await db.from("note_items").select("text").eq("meeting_id", meetingId)).data ?? []).map((r) => r.text), {
      timeout: 60_000,
      message: "scripted notes stored",
    })
    .toContain(SCRIPTED.decision);

  await page.getByRole("button", { name: "Avsluta", exact: true }).click();
  await page.getByRole("dialog", { name: "Avsluta mötet?" }).getByRole("button", { name: "Avsluta mötet" }).click();
  await expect(page.getByRole("heading", { name: "Mötet är avslutat" })).toBeVisible({ timeout: 60_000 });
  return meetingId;
}

test("Privat: record without a Doc → summary e-mail → the context keeps the task; the next recording has Sedan sist @phone", async ({
  signedIn,
  newEmail,
  db,
}) => {
  test.setTimeout(240_000);
  const email = newEmail("privat");
  const { page } = await signedIn(email, "/privat");

  // The space exists on the first visit, empty, and is not a förening.
  await expect(page.getByRole("heading", { name: "Privat", level: 1 })).toBeVisible();
  await expect(page.getByText("Inga inspelningar än")).toBeVisible();
  await expectAccessible(page);
  // The top rail (now with Privat) never scrolls sideways, also at 390 px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "horizontal overflow in px").toBeLessThanOrEqual(0);

  // First recording: a new context, typed inline.
  await page.getByRole("link", { name: "Spela in" }).click();
  const first = await record(page, db, async (p) => {
    const name = p.getByRole("textbox", { name: "Vad gäller inspelningen?" });
    // First time: a text field, prefilled with the catch-all context.
    await expect(name).toHaveValue("Övrigt");
    await name.fill("TDDE15");
    await p.getByRole("button", { name: "Lägg till" }).click();
    await expect(p.getByRole("combobox", { name: "Vad gäller inspelningen?" })).toHaveValue(/[0-9a-f-]{36}/);
    await expect(p.getByRole("combobox", { name: "Vad gäller inspelningen?" }).locator("option:checked")).toHaveText("TDDE15");
    await expect(p.getByRole("checkbox", { name: /Skriv även i ett Google-dokument/ })).not.toBeChecked();
  });

  await expect.poll(async () => (await fake.mail(email)).length, { timeout: 90_000, message: "summary e-mail" }).toBe(1);
  const [mail] = await fake.mail(email);
  expect(mail.subject).toMatch(/^TDDE15: sammanfattning /);
  expect(mail.text).toContain(P.summary);
  expect(mail.text).toContain(`MINA UPPGIFTER\n- ${P.firstTask}`);
  expect(mail.text).toContain(`ÖPPNA FRÅGOR\n- ${P.question}`);
  expect(mail.text).not.toContain("SEDAN SIST");
  expect(mail.text).toContain(`/privat/mote/${first}`);
  expect(mail.headers?.["List-Unsubscribe"]).toBeTruthy();

  // The context page keeps the task; the recording is listed with its summary.
  await page.goto("/privat");
  await page.getByRole("link", { name: /TDDE15/ }).click();
  await expect(page.getByRole("heading", { name: "TDDE15", level: 1 })).toBeVisible();
  await expect(page.getByRole("list", { name: "Öppna uppgifter" })).toContainText(P.firstTask);
  await expect(page.getByRole("list", { name: "Inspelningar" })).toContainText(P.summary);
  await expectAccessible(page);

  // Second recording from the context page: the context is preselected.
  await page.getByRole("link", { name: "Spela in" }).click();
  const second = await record(page, db, async (p) => {
    await expect(p.getByRole("combobox", { name: "Vad gäller inspelningen?" }).locator("option:checked")).toHaveText("TDDE15");
  });
  await expect.poll(async () => (await fake.mail(email)).length, { timeout: 90_000, message: "second summary e-mail" }).toBe(2);
  const mail2 = (await fake.mail(email)).find((m) => m.text.includes(`/privat/mote/${second}`))!;
  expect(mail2.text).toContain(`SEDAN SIST\n- ${P.firstTask} — klart`);
  expect(mail2.text).toContain(`MINA UPPGIFTER\n- ${P.nextTask}`);

  // The done task left the open list; the new one is there. The recording page shows Sedan sist.
  await page.goto("/privat");
  await page.getByRole("link", { name: /TDDE15/ }).click();
  const open = page.getByRole("list", { name: "Öppna uppgifter" });
  await expect(open).toContainText(P.nextTask);
  await expect(open).not.toContainText(P.firstTask);
  await page.goto(`/privat/mote/${second}`);
  await expect(page.getByRole("heading", { name: "Sedan sist" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Sedan sist" })).toContainText(`${P.firstTask}klart`);
  await expectAccessible(page);

  // Ticking a task by hand sticks.
  await page.getByRole("checkbox", { name: P.nextTask }).check();
  await expect.poll(async () => (await db.from("context_tasks").select("done").eq("meeting_id", second).single()).data?.done).toBe(true);

  // Privat is not a förening.
  await page.goto("/orgs");
  await expect(page.getByText("Du är inte med i någon förening än")).toBeVisible();
});

test("Privat: deleting a recording removes its notes and summary", async ({ signedIn, newEmail, db }) => {
  const email = newEmail("privdel");
  const { page } = await signedIn(email, "/privat");
  await expect(page.getByRole("heading", { name: "Privat", level: 1 })).toBeVisible();
  // Seeded as the server would leave a finished recording.
  const userId = await ensureUser(db, email);
  const { data: org } = await db.from("orgs").select("id").eq("kind", "privat").eq("created_by", userId).single();
  const space = org!.id;
  const { data: ctx } = await db.from("contexts").insert({ org_id: space, name: "Kundmöten" }).select("id").single();
  const { data: m } = await db
    .from("meetings")
    .insert({ org_id: space, started_by: userId, status: "done", context_id: ctx!.id, ended_at: new Date().toISOString(), summary_state: "sent" })
    .select("id")
    .single();
  await db.from("note_items").insert({ meeting_id: m!.id, id: "n1", section: "decision", text: "Offerten skickas på måndag" });
  await db.from("private_summaries").insert({ meeting_id: m!.id, context_id: ctx!.id, summary: "Genomgång av offerten.", decisions: ["Offerten skickas på måndag"] });

  await page.goto(`/privat/mote/${m!.id}`);
  await expect(page.getByText("Genomgång av offerten.")).toBeVisible();
  await page.getByRole("button", { name: "Radera inspelningen" }).click();
  await page.getByRole("dialog", { name: "Radera inspelningen?" }).getByRole("button", { name: "Radera inspelningen" }).click();
  await expect(page.getByText("Inspelningen är raderad")).toBeVisible();
  expect((await db.from("meetings").select("id").eq("id", m!.id)).data).toEqual([]);
  expect((await db.from("private_summaries").select("meeting_id").eq("meeting_id", m!.id)).data).toEqual([]);
  expect((await db.from("note_items").select("id").eq("meeting_id", m!.id)).data).toEqual([]);
});
