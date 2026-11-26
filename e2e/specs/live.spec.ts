import type { Page } from "@playwright/test";
import { SCRIPTED } from "../fakes/scripted";
import { APP_URL } from "../env";
import { expect, expectAccessible, fake, test, type Fixtures, type SeededOrg } from "../fixtures";

// Starta möte → consent → name round → live with the fake ElevenLabs transcript (the fake mic
// plays a tone; the fake server commits a scripted line per second of audio) → the scripted
// Claude notes land in the Doc fake → Avsluta → the meeting is listed. And the Meet-like
// auto-end: nobody connected any more, the cron ends the meeting.

async function startMeeting(page: Page, org: SeededOrg): Promise<{ meetingId: string; docId: string }> {
  await page.goto(org.url);
  await page.getByRole("link", { name: "Starta möte", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();
  // No agenda in the folder: a new Doc in the förening's format.
  await page.getByRole("button", { name: "Skapa nytt dokument" }).click();
  await page.getByRole("checkbox", { name: "Alla i rummet vet att mötet transkriberas och kan be om paus" }).check();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Starta mötet" }).click();

  // The name round opens on the meeting's own address.
  await expect(page.getByRole("heading", { name: "Namnrunda" })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  const meetingId = page.url().split("/").at(-1)!;
  // Voices show up as the fake transcribes the tone.
  await expect(page.getByRole("list", { name: "Namn vi hört" }).getByRole("listitem").filter({ hasText: /Talare/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  const [doc] = await fake.files(`Mötesprotokoll – ${org.name}`);
  expect(doc, "the meeting Doc in Drive").toBeTruthy();
  return { meetingId, docId: doc.id };
}

/** The scripted notes reach the Doc (first tick, right after the first segments). */
async function expectNotesInDoc(docId: string) {
  await expect.poll(() => fake.docText(docId), { timeout: 60_000, message: "scripted decision in the Doc" }).toContain(SCRIPTED.decision);
  const text = await fake.docText(docId);
  expect(text).toContain(SCRIPTED.action);
}

// A starter may have one live meeting at a time (and a few starts an hour): every meeting spec
// starts as a fresh admin of its own förening.
async function freshStarter(
  seedOrg: Fixtures["seedOrg"],
  signedIn: Fixtures["signedIn"],
  newEmail: Fixtures["newEmail"],
  people: (string | { name: string; email?: string })[] = [],
) {
  const email = newEmail("ordf");
  const org = await seedOrg({ admin: email, people });
  const { page } = await signedIn(email, org.url);
  return { org, page };
}

test("Starta möte → namnrunda → live notes in the Doc → Avsluta → listed, summary to who missed it @phone", async ({ seedOrg, signedIn, newEmail, db }) => {
  // The fake has four voices; the scripted name round calls them Anna, Erik, Lisa and Omar.
  const anna = newEmail("anna");
  const karin = newEmail("karin");
  const { org, page } = await freshStarter(seedOrg, signedIn, newEmail, [
    { name: "Anna Berg", email: anna },
    "Erik Lund",
    "Lisa Holm",
    "Omar Said",
    { name: "Karin Sjö", email: karin },
  ]);
  const { meetingId, docId } = await startMeeting(page, org);

  // Everyone has spoken before Klar, so attendance is certain: the fake speaks its four voices in
  // the first lines and merges two of them into one after the 6th line (three voices). Wait past it.
  await expect
    .poll(async () => (await db.from("segments").select("segment_index", { count: "exact", head: true }).eq("meeting_id", meetingId)).count ?? 0, {
      timeout: 30_000,
      message: "the fake past its merge (6th line)",
    })
    .toBeGreaterThanOrEqual(12);
  await expect(page.getByRole("list", { name: "Namn vi hört" }).getByRole("listitem")).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole("button", { name: "Klar, alla har sagt sitt namn" }).click();
  await expect(page.getByRole("heading", { name: "Namnrunda" })).toHaveCount(0, { timeout: 30_000 });
  await expectNotesInDoc(docId);
  await expectAccessible(page);

  await page.getByRole("button", { name: "Avsluta", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Avsluta mötet?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Avsluta mötet" }).click();

  await expect(page).toHaveURL(new RegExp(`/meetings/${meetingId}`));
  await expect(page.getByRole("heading", { name: "Mötet är avslutat" })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => fake.docText(docId), { timeout: 30_000 }).toMatch(/Avslutat \d{2}:\d{2}/);
  const { data } = await db.from("meetings").select("status").eq("id", meetingId).single();
  expect(data?.status).toBe("done");
  // The transcript tab got the fake's lines (held during the name round, written by the final pass).
  expect((await fake.doc(docId))?.tabs.find((t) => t.title === "Transkript")?.text).toContain("välkomna");

  // Summary ("missed" mode, the default): Karin was not there and gets it; Anna was.
  const state = async () => (await db.from("meetings").select("summary_state").eq("id", meetingId).single()).data?.summary_state;
  const voices = async () =>
    JSON.stringify((await db.from("speaker_map").select("el_session_id, speaker_label, person_id, display_name, merged_into_label, needs_confirm").eq("meeting_id", meetingId)).data);
  await expect
    .poll(async () => `${(await fake.mail(karin)).length} mail, summary_state ${await state()}`, { timeout: 30_000, message: `voices: ${await voices()}` })
    .toBe("1 mail, summary_state sent");
  const [summary] = await fake.mail(karin);
  expect(summary.text).toContain(SCRIPTED.decision);
  expect(await fake.mail(anna)).toEqual([]);

  await page.getByRole("link", { name: "Tillbaka till föreningen" }).click();
  const meetings = page.getByRole("list", { name: "Möten" });
  await expect(meetings.getByRole("listitem")).toHaveCount(1);
  await expect(meetings).toContainText("Klart");
});

test("auto-end like Meet: no tab heard from, the cron ends the meeting; unsure attendance mails nobody", async ({ seedOrg, signedIn, newEmail, db, request }) => {
  const karin = newEmail("karin");
  const { org, page } = await freshStarter(seedOrg, signedIn, newEmail, [{ name: "Karin Sjö", email: karin }]);
  const { meetingId, docId } = await startMeeting(page, org);
  await page.getByRole("button", { name: "Hoppa över" }).click();
  await expectNotesInDoc(docId);

  // The laptop goes away: no more heartbeats (the page closes without Avsluta).
  await page.close({ runBeforeUnload: false });
  const gone = new Date(Date.now() - 60 * 60_000).toISOString();
  await db.from("meetings").update({ last_heartbeat_at: gone }).eq("id", meetingId);

  const res = await request.get(`${APP_URL}/api/cron/finalize`, { headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` } });
  expect(res.status()).toBe(200);
  const summary = (await res.json()) as { autoEnded: number };
  expect(summary.autoEnded).toBeGreaterThanOrEqual(1);

  const { data } = await db.from("meetings").select("status, ended_at").eq("id", meetingId).single();
  expect(data?.status).toBe("done");
  await expect.poll(() => fake.docText(docId), { timeout: 30_000 }).toMatch(/Avslutat \d{2}:\d{2}/);
  // The name round was skipped: unnamed voices, so "missed" can't know who was there. Nobody is mailed.
  await expect
    .poll(async () => (await db.from("meetings").select("summary_state").eq("id", meetingId).single()).data?.summary_state, { timeout: 30_000 })
    .toBe("uncertain");
  expect(await fake.mail(karin)).toEqual([]);
});

test("a seeded meeting without speech is abandoned by the cron and can be continued", async ({ page, seedOrg, db, request }) => {
  const org = await seedOrg();
  const { data: m } = await db.from("meetings").insert({ org_id: org.id, doc_id: "fkseededdoc000000", notes_tab_id: "t.0", status: "live", started_at: new Date(Date.now() - 3_700_000).toISOString(), last_heartbeat_at: new Date(Date.now() - 3_600_000).toISOString() }).select("id").single();
  const res = await request.get(`${APP_URL}/api/cron/finalize`, { headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` } });
  expect(res.status()).toBe(200);
  const { data } = await db.from("meetings").select("status").eq("id", m!.id).single();
  expect(data?.status).toBe("abandoned");
  await page.goto(org.url);
  await expect(page.getByRole("list", { name: "Möten" })).toContainText("Avbrutet");
});
