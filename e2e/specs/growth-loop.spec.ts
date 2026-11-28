import type { Browser, Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { auditBorders, formatOffenders } from "../border-audit";
import { ADMIN_EMAIL, APP_URL } from "../env";
import { ensureUser, expect, expectAccessible, fake, guardContext, test, type SeededOrg } from "../fixtures";

// The growth loop (0063): after a meeting, attendees WITHOUT an account get the invite mail
// (their tasks, one button); the link signs them in with (fake) Google and lands them on the
// meeting. A forwarded link gives the next person nothing; the reminder goes once.

async function seedLiveMeeting(db: SupabaseClient, org: SeededOrg, expected: string[], guests: { email: string; name: string }[]) {
  const doc = await fake.createDoc({ name: `Mötesprotokoll – ${org.name}`, owner: ADMIN_EMAIL });
  const startedBy = await ensureUser(db, ADMIN_EMAIL);
  const started = new Date(Date.now() - 45 * 60_000).toISOString();
  const { data, error } = await db
    .from("meetings")
    .insert({
      org_id: org.id,
      started_by: startedBy,
      doc_id: doc.id,
      notes_tab_id: "t.0",
      status: "live",
      started_at: started,
      consent_confirmed_at: started,
      last_heartbeat_at: new Date().toISOString(),
      calendar_event: { title: "Styrelsemöte november", expected, declined: [] },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const items = [
    { meeting_id: data.id, id: "n1", section: "decision", kind: "decision", text: "Vårstädningen blir lördag 18 april", position: 0 },
    { meeting_id: data.id, id: "n2", section: "action", kind: "task", text: "Boka bryggan för vårstädningen", owner: "Oskar Ek", position: 1 },
  ];
  if ((await db.from("note_items").insert(items)).error) throw new Error("items");
  if (guests.length) {
    const g = await db.from("meeting_calendar_guests").insert(guests.map((x) => ({ meeting_id: data.id, email: x.email, name: x.name, response: "accepted" })));
    if (g.error) throw new Error(g.error.message);
  }
  return data.id as string;
}

/** A fresh, signed-out browser whose "Fortsätt med Google" signs in as `email`. */
async function freshBrowser(browser: Browser, blocked: string[], email: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: APP_URL, locale: "sv-SE", timezoneId: "Europe/Stockholm", storageState: { cookies: [], origins: [] }, reducedMotion: "reduce" });
  await guardContext(context, blocked, { email });
  return context.newPage();
}

const linkIn = (text: string) => {
  const m = /https?:\/\/[^\s]+\/r\/[0-9a-f]{32}[A-Za-z0-9_-]{22}/.exec(text);
  if (!m) throw new Error("no invite link in the mail");
  return m[0];
};

test("end meeting → invite queued and sent → the link signs a guest in → the meeting; a forwarded link is refused; one reminder", async ({ page, browser, blocked, seedOrg, newEmail, db, request }) => {
  const oskar = newEmail("oskar");
  const lisa = newEmail("lisa");
  const gast = newEmail("gast");
  const eve = newEmail("eve");
  const org = await seedOrg({ people: [{ name: "Oskar Ek", email: oskar }, { name: "Lisa Holm", email: lisa }] });
  const people = (await db.from("people").select("id, name").eq("org_id", org.id)).data as { id: string; name: string }[];
  const meetingId = await seedLiveMeeting(db, org, people.map((p) => p.id), [{ email: gast, name: "Gun Gäst" }]);

  // The admin ends the meeting.
  await page.goto(org.url);
  await page.getByRole("list", { name: "Möten" }).getByRole("button", { name: "Avsluta mötet" }).click();
  await page.getByRole("dialog", { name: "Avsluta mötet?" }).getByRole("button", { name: "Avsluta mötet" }).click();
  await expect(page.getByText("Mötet avslutas.")).toBeVisible();

  // Queued for the three attendees without an account, then sent (one each, no summary for them).
  const invites = async () => (await db.from("meeting_invites").select("email, status, person_id").eq("meeting_id", meetingId).order("email")).data ?? [];
  await expect.poll(async () => (await invites()).map((r) => r.status).join(","), { timeout: 60_000 }).toBe("sent,sent,sent");
  expect((await invites()).map((r) => r.email).sort()).toEqual([gast, lisa, oskar].sort());
  for (const to of [oskar, lisa, gast]) await expect.poll(async () => (await fake.mail(to)).length, { timeout: 30_000 }).toBe(1);
  const [toGast] = await fake.mail(gast);
  expect(toGast.subject).toMatch(/bjöd in dig till "Styrelsemöte november"$/);
  expect(toGast.text).toContain("Läs allt och bocka av");
  expect(toGast.text).toContain("du stod på mötets gästlista");
  const [toOskar] = await fake.mail(oskar);
  expect(toOskar.text).toContain("DINA UPPGIFTER (1)");
  expect(toOskar.text).toContain("Boka bryggan för vårstädningen");
  expect(toOskar.headers?.["List-Unsubscribe"]).toBeTruthy();

  // The calendar guest (no people row): the link → Fortsätt med Google → the meeting, as a guest.
  const guestPage = await freshBrowser(browser, blocked, gast);
  await guestPage.goto(linkIn(toGast.text));
  await expect(guestPage).toHaveURL(/\/in\/[0-9a-f]{32}/);
  await expect(guestPage.getByRole("heading", { name: "Styrelsemöte november" })).toBeVisible();
  // The landing shows no tasks or decisions (a forwarded mail's link shows nothing new).
  await expect(guestPage.getByText("Boka bryggan")).toHaveCount(0);
  await expectAccessible(guestPage);
  expect(formatOffenders("/in", await auditBorders(guestPage))).toEqual([]);
  await guestPage.getByRole("button", { name: "Fortsätt med Google" }).click();
  await expect(guestPage).toHaveURL(new RegExp(`/orgs/${org.id}/mote/${meetingId}\\?fran=inbjudan`));
  await expect(guestPage.getByText(/Du ser det här mötet som gäst/)).toBeVisible();
  await expect(guestPage.getByText("Vårstädningen blir lördag 18 april")).toBeVisible();
  await expect(guestPage.getByRole("link", { name: "Öppna dokumentet" })).toHaveCount(0);
  // Only that meeting: the förening itself is not theirs.
  const orgPage = await guestPage.goto(org.url);
  expect(orgPage?.status()).toBe(404);
  const funnel = async () => (await db.from("meeting_invites").select("clicked_at, clicked_human_at, claimed_at, claim_kind").eq("meeting_id", meetingId).eq("email", gast).single()).data!;
  await expect.poll(async () => Boolean((await funnel()).clicked_human_at)).toBe(true);
  expect((await funnel()).clicked_at).toBeTruthy();
  expect((await funnel()).claimed_at).toBeTruthy();

  // Admins see the guest in the meeting's attendee list.
  await page.goto(`${org.url}/mote/${meetingId}`);
  await expect(page.getByRole("list", { name: "Gäster med åtkomst till mötet" }).getByText("Gun Gäst")).toBeVisible();

  // Oskar's mail forwarded to Eve: she signs in as herself and gets an explanation, no access.
  const evePage = await freshBrowser(browser, blocked, eve);
  await evePage.goto(linkIn(toOskar.text));
  await evePage.getByRole("button", { name: "Fortsätt med Google" }).click();
  await expect(evePage).toHaveURL(/\/in\/[0-9a-f]{32}[A-Za-z0-9_-]{22}\?fel=konto$/);
  await expect(evePage.getByText("Det här kontot har inte bjudits in")).toBeVisible();
  const eveMeeting = await evePage.goto(`${org.url}/mote/${meetingId}`);
  expect(eveMeeting?.status()).toBe(404);
  // The token still works for Oskar himself: he joins the förening, linked to his row.
  const oskarPage = await freshBrowser(browser, blocked, oskar);
  await oskarPage.goto(linkIn(toOskar.text));
  await oskarPage.getByRole("button", { name: "Fortsätt med Google" }).click();
  await expect(oskarPage).toHaveURL(new RegExp(`/orgs/${org.id}/mote/${meetingId}`));
  await expect(oskarPage.getByText(/Du ser det här mötet som gäst/)).toHaveCount(0);
  const oskarRow = (await db.from("people").select("member_user_id").eq("org_id", org.id).eq("name", "Oskar Ek").single()).data!;
  expect(oskarRow.member_user_id).toBeTruthy();

  // Lisa never clicked: two days later the cron sends the one reminder, and never another.
  await db.from("meeting_invites").update({ sent_at: new Date(Date.now() - 50 * 3600_000).toISOString() }).eq("meeting_id", meetingId).eq("email", lisa);
  const cron = () => request.get(`${APP_URL}/api/cron/finalize`, { headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` } });
  expect((await cron()).status()).toBe(200);
  await expect.poll(async () => (await fake.mail(lisa)).length, { timeout: 30_000 }).toBe(2);
  expect((await fake.mail(lisa)).map((m) => m.subject).filter((s) => s.startsWith("(Påminnelse)"))).toHaveLength(1);
  expect((await cron()).status()).toBe(200);
  expect(await fake.mail(lisa)).toHaveLength(2);
  // The guest clicked: no reminder for her.
  expect(await fake.mail(gast)).toHaveLength(1);
});
