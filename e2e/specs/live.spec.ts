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
async function freshStarter(seedOrg: Fixtures["seedOrg"], signedIn: Fixtures["signedIn"], newEmail: Fixtures["newEmail"], people: string[] = []) {
  const email = newEmail("ordf");
  const org = await seedOrg({ admin: email, people });
  const { page } = await signedIn(email, org.url);
  return { org, page };
}

test("Starta möte → namnrunda → live notes in the Doc → Avsluta → listed @phone", async ({ seedOrg, signedIn, newEmail, db }) => {
  const { org, page } = await freshStarter(seedOrg, signedIn, newEmail, ["Anna Berg", "Erik Lund"]);
  const { meetingId, docId } = await startMeeting(page, org);

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

  await page.getByRole("link", { name: "Tillbaka till föreningen" }).click();
  const meetings = page.getByRole("list", { name: "Möten" });
  await expect(meetings.getByRole("listitem")).toHaveCount(1);
  await expect(meetings).toContainText("Klart");
});

test("auto-end like Meet: no tab heard from, the cron ends the meeting", async ({ seedOrg, signedIn, newEmail, db, request }) => {
  const { org, page } = await freshStarter(seedOrg, signedIn, newEmail);
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
