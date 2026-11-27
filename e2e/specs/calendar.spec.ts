import { randomUUID } from "node:crypto";
import { stockholmDateTime } from "@/lib/calendar/events";
import { expect, expectAccessible, fake, test } from "../fixtures";

// Kalender (todo #14): an admin connects their Google Calendar (read only, its own consent),
// chooses the förening's calendar with a title filter, and its next meeting feeds the Möten tab's
// Nästa möte card: one happening now is offered "Starta möte" (with the event), and "Förbered"
// opens Förbered möte with the event's date, time and title. A member who hasn't connected gets
// a quiet hint.
// "Koppla från" in Inställningar deletes our copy. The calendar is the fake Calendar API.

const hourFromNow = (h: number) => {
  const d = new Date(Date.now() + h * 3600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};

test("Kalender: connect, choose the förening's calendar, see the next meetings, Förbered prefilled @phone", async ({ seedOrg, newEmail, signedIn, db }) => {
  const admin = newEmail("kal-admin");
  const member = newEmail("kal-medlem");
  const org = await seedOrg({ admin, members: [member], people: [{ name: "Erik Lund", email: "erik@e2e.test" }] });
  const shared = `c_${randomUUID().slice(0, 8)}@group.calendar.google.com`;
  const board = { id: `ev${randomUUID().slice(0, 8)}`, summary: "Styrelsemöte", start: hourFromNow(48), end: hourFromNow(49) };
  const now = { id: `ev${randomUUID().slice(0, 8)}`, summary: "Medlemsmöte", start: new Date(Date.now() + 10 * 60_000).toISOString(), end: new Date(Date.now() + 70 * 60_000).toISOString() };
  await fake.calendar(admin, { id: admin, summary: "Min kalender", primary: true });
  await fake.calendar(admin, { id: shared, summary: "Föreningens kalender" }, [
    board,
    now,
    // The soonest event, but not a meeting: the title filter leaves it out.
    { id: `ev${randomUUID().slice(0, 8)}`, summary: "Lunch", start: new Date(Date.now() + 5 * 60_000).toISOString(), end: new Date(Date.now() + 65 * 60_000).toISOString() },
  ]);

  // Inställningar → Möten; "Koppla kalender" comes back to it through /orgs/<id>/installningar
  // (the result opens the section it is about).
  const { page: adminPage } = await signedIn(admin, `${org.url}/installningar`);
  await expect(adminPage).toHaveURL(/flik=installningar/);
  await adminPage.getByRole("navigation", { name: "Inställningarnas delar" }).getByRole("link", { name: "Möten" }).click();
  const settings = adminPage.locator("section", { has: adminPage.getByRole("heading", { name: "Mötenas kalender" }) });
  await expect(settings.getByText("Koppla din kalender först")).toBeVisible();
  await settings.getByRole("button", { name: "Koppla kalender" }).click();
  await expect(adminPage.getByText("Kalendern är kopplad.")).toBeVisible();
  await expect(adminPage).toHaveURL(/flik=installningar/);
  const adminId = (await db.from("org_members").select("user_id").eq("org_id", org.id).eq("role", "admin").single()).data!.user_id as string;
  const { data: token } = await db.from("google_calendar_tokens").select("scope").eq("user_id", adminId).single();
  expect(token?.scope).toContain("https://www.googleapis.com/auth/calendar.readonly");
  expect(token?.scope).not.toContain("drive");

  await expect(adminPage.getByRole("navigation", { name: "Inställningarnas delar" }).getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "true");

  // Choose the shared calendar (saved on change), then only events whose name contains "möte" (text: Spara).
  await settings.getByLabel("Kalender", { exact: true }).selectOption({ label: "Föreningens kalender" });
  await expect(settings.getByText("Sparat")).toBeVisible();
  await expect
    .poll(async () => (await db.from("orgs").select("calendar_id").eq("id", org.id).single()).data?.calendar_id)
    .toBe(shared);
  await settings.getByLabel("Bara händelser vars namn innehåller").fill("möte");
  await settings.getByRole("button", { name: "Spara kalender" }).click();
  await expect
    .poll(async () => (await db.from("orgs").select("calendar_id, calendar_name, calendar_filter").eq("id", org.id).single()).data)
    .toEqual({ calendar_id: shared, calendar_name: "Föreningens kalender", calendar_filter: "möte" });

  // The Nästa möte card: the calendar's next meeting (the lunch is filtered out), happening now,
  // so starting comes first; nothing is prepared for it.
  await adminPage.goto(org.url);
  const card = adminPage.locator('section[data-hero="unprepared"]');
  await expect(card.getByRole("heading", { name: "Medlemsmöte" })).toBeVisible();
  await expect(card).toContainText("Pågår nu enligt kalendern. Ingen dagordning än.");
  await expect(card).toContainText("från kalendern");
  await expect(adminPage.getByText("Lunch")).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Starta möte" })).toHaveAttribute("href", `/meetings/ny/${org.id}?event=${now.id}`);
  await expectAccessible(adminPage);

  // Förbered: the event's date, time and title.
  await card.getByRole("link", { name: /^Förbered (dagens|morgondagens) möte$/ }).click();
  await expect(adminPage).toHaveURL(new RegExp(`/orgs/${org.id}/forbered\\?datum=.*&event=${now.id}`));
  await expect(adminPage.getByText("Från kalendern: Medlemsmöte")).toBeVisible();
  const when = stockholmDateTime(now.start);
  await expect(adminPage.getByLabel("Datum")).toHaveValue(when.date);
  await expect(adminPage.getByLabel("Tid")).toHaveValue(when.time);

  // "Starta" opens the consent step with the event's title.
  await adminPage.goto(`/meetings/ny/${org.id}?event=${now.id}`);
  await expect(adminPage.getByText("Från kalendern: Medlemsmöte")).toBeVisible();

  // A member who hasn't connected their calendar: a quiet hint in the card, and the card as without a calendar.
  const { page: memberPage } = await signedIn(member, org.url);
  const memberCard = memberPage.locator('section[data-hero="unprepared"]');
  await expect(memberCard.getByText("Koppla din kalender så visas föreningens kommande möten här.")).toBeVisible();
  await expect(memberCard.getByRole("heading", { name: "Ingen dagordning än" })).toBeVisible();

  // Koppla från (Inställningar): our copy is deleted.
  await adminPage.goto("/installningar");
  const panel = adminPage.locator("section", { has: adminPage.getByRole("heading", { name: "Kalender", exact: true }) });
  await expect(panel.getByText("Din Google-kalender är kopplad")).toBeVisible();
  await panel.getByRole("button", { name: "Koppla från" }).click();
  await adminPage.getByRole("dialog").getByRole("button", { name: "Koppla från" }).click();
  await expect(adminPage.getByText("Kalendern är frånkopplad.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Koppla kalender" })).toBeVisible();
  expect((await db.from("google_calendar_tokens").select("user_id").eq("user_id", adminId)).data).toEqual([]);
});
