import { APP_URL, ADMIN_EMAIL } from "../env";
import { ensureUser, expect, fake, test, type SeededOrg } from "../fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";

// The summary e-mail after a meeting (0037), "missed" mode (the default): only people in the list
// with an e-mail who were not there get it, through the fake mail provider. Attendance here comes
// from the Närvarande line; when it can't be read ("hela styrelsen"), nobody is mailed.

async function seedLiveMeeting(db: SupabaseClient, org: SeededOrg, attendees: string) {
  const doc = await fake.createDoc({ name: `Mötesprotokoll – ${org.name}`, owner: ADMIN_EMAIL });
  const startedBy = await ensureUser(db, ADMIN_EMAIL);
  const started = new Date(Date.now() - 45 * 60_000).toISOString();
  const { data, error } = await db
    .from("meetings")
    .insert({ org_id: org.id, started_by: startedBy, doc_id: doc.id, notes_tab_id: "t.0", status: "live", started_at: started, consent_confirmed_at: started, last_heartbeat_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const items = [
    { meeting_id: data.id, id: "n1", section: "attendees", kind: "attendee", text: attendees, position: 0 },
    { meeting_id: data.id, id: "n2", section: "decision", kind: "decision", text: "Hackathonet blir den 14 februari", position: 1 },
    { meeting_id: data.id, id: "n3", section: "action", kind: "task", text: "Maila Kårallen om lokalen", owner: "Erik Lund", position: 2 },
  ];
  const ins = await db.from("note_items").insert(items);
  if (ins.error) throw new Error(ins.error.message);
  return data.id as string;
}

test("Avsluta mötet → the summary goes to who missed it, not to who was there", async ({ page, seedOrg, newEmail, db }) => {
  const anna = newEmail("anna");
  const karin = newEmail("karin");
  const org = await seedOrg({ people: [{ name: "Anna Berg", email: anna }, "Erik Lund", { name: "Karin Sjö", email: karin }] });
  const meetingId = await seedLiveMeeting(db, org, "Anna Berg, Erik Lund");

  await page.goto(org.url);
  await page.getByRole("list", { name: "Möten" }).getByRole("button", { name: "Avsluta mötet" }).click();
  await page.getByRole("dialog", { name: "Avsluta mötet?" }).getByRole("button", { name: "Avsluta mötet" }).click();
  await expect(page.getByText("Mötet avslutas.")).toBeVisible();

  const state = async () => (await db.from("meetings").select("status, summary_state").eq("id", meetingId).single()).data;
  await expect.poll(async () => `${(await fake.mail(karin)).length} mail, ${JSON.stringify(await state())}`, { timeout: 60_000 }).toBe(
    '1 mail, {"status":"done","summary_state":"sent"}',
  );
  const [mail] = await fake.mail(karin);
  expect(mail.text).toContain("Hackathonet blir den 14 februari");
  expect(mail.text).toContain("Maila Kårallen om lokalen");
  expect(mail.headers?.["List-Unsubscribe"]).toBeTruthy();
  // Anna was there.
  expect(await fake.mail(anna)).toEqual([]);
});

test("unsure attendance ('hela styrelsen') mails nobody", async ({ seedOrg, newEmail, db, request }) => {
  const karin = newEmail("karin");
  const org = await seedOrg({ people: ["Anna Berg", { name: "Karin Sjö", email: karin }] });
  const meetingId = await seedLiveMeeting(db, org, "Hela styrelsen");
  // Ended (its summary not handled yet): the cron's sweep handles it.
  await db.from("meetings").update({ status: "done", ended_at: new Date().toISOString() }).eq("id", meetingId);
  const res = await request.get(`${APP_URL}/api/cron/finalize`, { headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` } });
  expect(res.status()).toBe(200);
  await expect
    .poll(async () => JSON.stringify((await db.from("meetings").select("status, summary_state").eq("id", meetingId).single()).data), { timeout: 60_000 })
    .toBe('{"status":"done","summary_state":"uncertain"}');
  expect(await fake.mail(karin)).toEqual([]);
});
