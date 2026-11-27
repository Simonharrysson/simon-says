import type { Page } from "@playwright/test";
import { expect, expectAccessible, seedMeeting, test } from "../fixtures";

// The Möten tab's "Nästa möte" card, the weekly loop: not prepared ("Förbered nästa möte" /
// "Starta utan förberedelse") → prepared (Dagordning, "Starta mötet") → live ("Fortsätt mötet")
// → the notes being finished → just ended (recap, "Sammanfattning skickad", the meeting's page).
// Each state is seeded the way the server leaves it. The live → meeting page redirect after
// Avsluta is in live.spec.ts.

/** The card, by its state (data-hero), once the page shows it. */
const hero = (page: Page, state: string) => page.locator(`section[data-hero="${state}"]`);

/** A seed write that must land. */
function must(what: string, r: { error: { message: string } | null }) {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
}

/** Nothing wider than the screen (no sideways scrolling at 390 px). */
async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

/** Swedish local day `days` from now (YYYY-MM-DD). */
const stockholmDay = (days: number) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));

test("Nästa möte: not prepared → prepared, with Förbered and Starta @phone", async ({ page, seedOrg, db }) => {
  const org = await seedOrg();
  // An old meeting does not take the card.
  await seedMeeting(db, org, { daysAgo: 7 });

  await page.goto(org.url);
  const card = hero(page, "unprepared");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "Ingen dagordning än" })).toBeVisible();
  await expect(card.getByRole("link", { name: "Förbered nästa möte" })).toHaveAttribute("href", `/orgs/${org.id}/forbered`);
  await expect(card.getByRole("link", { name: "Starta utan förberedelse" })).toHaveAttribute("href", `/meetings/ny/${org.id}`);
  await expectNoOverflow(page);
  await expectAccessible(page);

  // An agenda prepared for a day later this week: the card says so and offers Starta mötet.
  const date = stockholmDay(4);
  must("seed agenda", await db.from("prepared_agendas").insert({ org_id: org.id, meeting_date: date, meeting_time: "18:00", kind: "veckomote", doc_id: "fkprepared00000001", tab_id: "t.0", doc_name: `Dagordning – ${org.name}` }));
  await page.reload();
  const prepared = hero(page, "prepared");
  await expect(prepared).toBeVisible();
  await expect(prepared.getByText("Nästa möte", { exact: true })).toBeVisible();
  await expect(prepared.getByRole("heading")).toContainText("Veckomöte");
  await expect(prepared).toContainText("Dagordningen är klar.");
  await expect(prepared.getByRole("link", { name: "Dagordning" })).toHaveAttribute("href", /fkprepared00000001/);
  await expect(prepared.getByRole("link", { name: "Ändra", exact: true })).toHaveAttribute("href", `/orgs/${org.id}/forbered?datum=${date}`);
  await expect(prepared.getByRole("link", { name: "Starta mötet" })).toHaveAttribute("href", `/meetings/ny/${org.id}`);
  await expect(prepared.getByRole("link", { name: "Starta utan förberedelse" })).toHaveCount(0);
  await expectNoOverflow(page);
});

test("Nästa möte: live → notes being finished → just ended, recap and the meeting's page @phone", async ({ page, seedOrg, db }) => {
  const org = await seedOrg({ people: ["Erik Lund"] });
  const { id } = await seedMeeting(db, org, {
    status: "live",
    daysAgo: 0.02,
    items: [
      { section: "decision", text: "Vi bokar Kårallen" },
      { section: "action", text: "Skicka kallelsen", owner: "Erik Lund" },
    ],
  });

  // Live: one "Fortsätt mötet" (the card's; the header doesn't repeat it on Möten).
  await page.goto(org.url);
  const live = hero(page, "live");
  await expect(live.getByRole("heading", { name: "Ett möte pågår" })).toBeVisible();
  await expect(live.getByText("Pågår", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fortsätt mötet" })).toHaveCount(1);
  await expect(live.getByRole("link", { name: "Fortsätt mötet" })).toHaveAttribute("href", `/meetings/${id}`);
  await expectAccessible(page);

  // Avsluta pressed: the notes are being finished; the card says so and refreshes by itself.
  must("ending", await db.from("meetings").update({ status: "ending" }).eq("id", id));
  await page.reload();
  const ending = hero(page, "ending");
  await expect(ending.getByRole("heading", { name: "Anteckningarna färdigställs…" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fortsätt mötet" })).toHaveCount(0);

  // The final pass is done and two people got the summary: the card turns into the recap on its own.
  const endedAt = new Date().toISOString();
  must("done", await db.from("meetings").update({ status: "done", ended_at: endedAt, summary_state: "sent", title: "Lokalen till julfesten" }).eq("id", id));
  must("summary event", await db.from("meeting_events").insert({ meeting_id: id, kind: "summary", detail: { state: "sent", mode: "missed", recipients: 2, sent: 2, failed: 0 } }));
  const ended = hero(page, "ended");
  await expect(ended).toBeVisible({ timeout: 20_000 });
  await expect(ended.getByRole("heading", { name: "Lokalen till julfesten" })).toBeVisible();
  await expect(ended).toContainText("Senaste mötet");
  await expect(ended).toContainText("1 beslut · 1 uppgift");
  await expect(ended).toContainText("Sammanfattning skickad till 2 personer");
  await expect(ended.getByRole("link", { name: "Förbered nästa möte" })).toHaveAttribute("href", `/orgs/${org.id}/forbered`);
  await expectNoOverflow(page);
  await expectAccessible(page);

  // Its page: the recap, the decisions, the tasks, the mail, the Doc second.
  await ended.getByRole("link", { name: "Se beslut och uppgifter" }).click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/mote/${id}$`));
  const recap = page.getByRole("region", { name: "Mötet är avslutat" });
  await expect(recap).toBeVisible();
  await expect(recap).toContainText("Sammanfattningen mejlades till de 2 som missade mötet.");
  await expect(page.getByRole("region", { name: "Beslut" })).toContainText("Vi bokar Kårallen");
  await expect(page.getByRole("list", { name: "Uppgifter" })).toContainText("Skicka kallelsen");
  await expect(page.getByRole("link", { name: "Öppna dokumentet" })).toBeVisible();
  await expectNoOverflow(page);
  await expectAccessible(page);
});

test("Nästa möte: a Privat möte that runs stays out of a member's card; a Testmöte never becomes the recap", async ({ seedOrg, signedIn, newEmail, db }) => {
  const admin = newEmail("ordf");
  const member = newEmail("medlem");
  const org = await seedOrg({ admin, members: [member] });
  const { id } = await seedMeeting(db, org, { startedBy: admin, status: "live", daysAgo: 0.02 });
  must("private", await db.from("meetings").update({ private: true }).eq("id", id));

  const { page: adminPage } = await signedIn(admin, org.url);
  await expect(hero(adminPage, "live")).toBeVisible();
  const { page: memberPage } = await signedIn(member, org.url);
  await expect(hero(memberPage, "unprepared")).toBeVisible();
  await expect(memberPage.getByText("Ett möte pågår")).toHaveCount(0);

  // A Testmöte that just ended: the card stays on the next meeting.
  must("test done", await db.from("meetings").update({ status: "done", ended_at: new Date().toISOString(), private: false, is_test: true }).eq("id", id));
  await adminPage.reload();
  await expect(hero(adminPage, "unprepared")).toBeVisible();
});
