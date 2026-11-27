import { randomUUID } from "node:crypto";
import { stockholmDateTime } from "@/lib/calendar/events";
import { APP_URL } from "../env";
import { expect, fake, seedMeeting, test } from "../fixtures";

// Inför möten (0059): a member with a connected calendar gets one short mail ~10 minutes before
// the förening's meeting, once they turned förening briefs on (off by default). The 5-minute cron
// is called by hand; the calendar and the mail provider are the fakes.

const cron = (request: import("@playwright/test").APIRequestContext, auth = true) =>
  request.get(`${APP_URL}/api/cron/brief`, auth ? { headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` } } : {});

test("Inför möten: opt in under Konto, one brief before the förening's meeting, never twice", async ({ seedOrg, newEmail, signedIn, db, request }) => {
  const member = newEmail("brief");
  const org = await seedOrg({ members: [member], people: [{ name: "Karin Sjö", email: member }, "Erik Lund"] });
  await seedMeeting(db, org, {
    daysAgo: 7,
    items: [
      { section: "decision", text: "Hackathonet blir den 14 februari" },
      { section: "action", text: "Boka Kårallen", owner: "Erik Lund" },
    ],
  });
  const shared = `c_${randomUUID().slice(0, 8)}@group.calendar.google.com`;
  const start = new Date(Date.now() + 10 * 60_000);
  start.setUTCSeconds(0, 0);
  const event = { id: `ev${randomUUID().slice(0, 8)}`, summary: "Styrelsemöte", start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() };
  await fake.calendar(member, { id: member, summary: "Min kalender", primary: true });
  await fake.calendar(member, { id: shared, summary: "Föreningens kalender" }, [event]);
  // The admin chose the förening's calendar (as in calendar.spec.ts, here written directly).
  await db.from("orgs").update({ calendar_id: shared, calendar_name: "Föreningens kalender", calendar_filter: "möte" }).eq("id", org.id);

  // The member connects their calendar ("Koppla kalender", answered by the test sign-in).
  const { page } = await signedIn(member, "/installningar");
  await page.goto(`/api/e2e/login?email=${encodeURIComponent(member)}&next=${encodeURIComponent("/installningar")}&kalender=1`);
  await expect(page.getByText("Kalendern är kopplad.")).toBeVisible();

  // Without the secret: refused. Not opted in yet: no mail (förening briefs are off by default).
  expect((await cron(request, false)).status()).toBe(401);
  expect((await cron(request)).status()).toBe(200);
  expect(await fake.mail(member)).toEqual([]);

  // Konto → Mejl: "Inför möten" is on, "Även inför föreningsmöten" off until turned on.
  const brief = page.getByRole("switch", { name: "Inför möten" });
  await expect(brief).toBeChecked();
  const orgs = page.getByRole("switch", { name: "Även inför föreningsmöten" });
  await expect(orgs).not.toBeChecked();
  await orgs.click();
  await expect(page.getByText("Sparat")).toBeVisible();
  await expect(orgs).toBeChecked();

  expect((await cron(request)).status()).toBe(200);
  await expect.poll(async () => (await fake.mail(member)).length, { timeout: 30_000 }).toBe(1);
  const [mail] = await fake.mail(member);
  expect(mail.subject).toBe(`Inför Styrelsemöte kl ${stockholmDateTime(event.start).time.replace(":", ".")}`);
  expect(mail.text).toContain("SENAST NI SÅGS");
  expect(mail.text).toContain("Hackathonet blir den 14 februari");
  expect(mail.text).toContain("Erik Lund: Boka Kårallen");
  expect(mail.text).toContain(`/orgs/${org.id}/mote/`);
  expect(mail.headers?.["List-Unsubscribe"]).toContain("k=meeting_brief");

  // The next runs (the meeting is still 5–10 minutes away): nothing more.
  expect((await cron(request)).status()).toBe(200);
  expect((await cron(request)).status()).toBe(200);
  expect(await fake.mail(member)).toHaveLength(1);
});
