import type { Page } from "@playwright/test";
import { expect, expectAccessible, seedMeeting, test } from "../fixtures";

/** Nothing wider than the screen (no sideways scrolling at 390 px). */
async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

// The förening page's tabs (Möten, Översikt; admins also Inställningar) and the meeting list:
// titles as the main line with the date and "n beslut · n uppgifter" under it, newest first, five
// shown and the rest under "Visa fler", Testmöten folded away under "Visa testmöten".

test("tabs: a member sees Möten and Översikt, an admin also Inställningar @phone", async ({ page, seedOrg, newEmail, signedIn }) => {
  const member = newEmail("medlem");
  const org = await seedOrg({ members: [member], people: ["Erik Lund"] });

  await page.goto(org.url);
  const tabs = page.getByRole("navigation", { name: "Föreningens vyer" });
  await expect(tabs.getByRole("link")).toHaveText(["Möten", "Översikt", "Inställningar"]);
  await expect(tabs.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "page");
  // Möten holds the meetings only: no admin panels.
  await expect(page.getByRole("heading", { name: "Radera föreningen" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Mötesformat" })).toHaveCount(0);

  await tabs.getByRole("link", { name: "Inställningar" }).click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}\\?flik=installningar$`));
  await expect(tabs.getByRole("link", { name: "Inställningar" })).toHaveAttribute("aria-current", "page");
  // The sections' sub-nav; Föreningen opens first.
  const sections = page.getByRole("navigation", { name: "Inställningarnas delar" });
  await expect(sections.getByRole("link")).toHaveText(["Föreningen", "Styrelsen och medlemmar", "Möten", "Efter mötet", "Radera"]);
  await expect(sections.getByRole("link", { name: "Föreningen" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "Namn, logga och om oss", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mötesformat", exact: true })).toHaveCount(0);
  await expectNoOverflow(page);

  await sections.getByRole("link", { name: "Styrelsen och medlemmar" }).click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}\\?flik=installningar&del=styrelsen$`));
  await expect(page.getByRole("heading", { name: "Styrelsen och medlemmar", exact: true })).toBeVisible();
  // Back to the tab as first opened (no `del`): Föreningen again, then forward to the board.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}\\?flik=installningar$`));
  await expect(sections.getByRole("link", { name: "Föreningen" })).toHaveAttribute("aria-current", "true");
  await page.goForward();
  await expect(sections.getByRole("link", { name: "Styrelsen och medlemmar" })).toHaveAttribute("aria-current", "true");
  // One board list: the named person and the two accounts (nobody has named them yet).
  const board = page.getByRole("list", { name: "Styrelsen" });
  await expect(board.getByRole("listitem")).toHaveCount(3);
  await expect(board.getByRole("listitem").filter({ hasText: member }).getByRole("button", { name: "Gör till admin" })).toBeVisible();
  await expectAccessible(page);
  await expectNoOverflow(page);

  // An old link to the settings' place on the long page lands on the section that holds it now.
  await page.goto(`${org.url}#sammanfattning`);
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}\\?flik=installningar&del=efter-motet$`));
  await expect(page.getByRole("group", { name: "Sammanfattning efter mötet" })).toBeVisible();

  // A member: two tabs; ?flik=installningar is the Möten tab for them.
  const other = await signedIn(member, org.url);
  const theirTabs = other.page.getByRole("navigation", { name: "Föreningens vyer" });
  await expect(theirTabs.getByRole("link")).toHaveText(["Möten", "Översikt"]);
  await expect(other.page.getByRole("heading", { name: "Personer" })).toBeVisible();
  await expect(other.page.getByRole("button", { name: "Lämna föreningen" })).toBeVisible();
  await other.page.goto(`${org.url}?flik=installningar`);
  await expect(theirTabs.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "page");
  await expect(other.page.getByRole("heading", { name: "Radera föreningen" })).toHaveCount(0);
  await expectAccessible(other.page);
});

test("Inställningar's sections: a deep link opens one, the sub-nav switches at once, back and the tab keep it @phone", async ({ page, seedOrg }) => {
  const org = await seedOrg({ people: ["Erik Lund"] });

  // A deep link to a section.
  await page.goto(`${org.url}?flik=installningar&del=moten`);
  const tabs = page.getByRole("navigation", { name: "Föreningens vyer" });
  const sections = page.getByRole("navigation", { name: "Inställningarnas delar" });
  await expect(tabs.getByRole("link", { name: "Inställningar" })).toHaveAttribute("aria-current", "page");
  await expect(sections.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "true");
  for (const name of ["Mötesformat", "Mötesmapp", "Under mötet", "Röster"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Radera föreningen" })).toHaveCount(0);
  await expectAccessible(page);

  // A click shows another section and records it in the URL; back returns.
  await sections.getByRole("link", { name: "Radera" }).click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}\\?flik=installningar&del=radera$`));
  await expect(page.getByRole("heading", { name: "Radera föreningen" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mötesformat" })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/del=moten$/);
  await expect(sections.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "Mötesformat", exact: true })).toBeVisible();

  // Reloadable.
  await page.reload();
  await expect(sections.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "true");

  // Away to Möten and back by the tab: the section is kept.
  await tabs.getByRole("link", { name: "Möten" }).click();
  await expect(tabs.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Inställningar" }).click();
  await expect(tabs.getByRole("link", { name: "Inställningar" })).toHaveAttribute("aria-current", "page");
  await expect(sections.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "Mötesformat", exact: true })).toBeVisible();
});

test("meeting list: titles, counts, five shown, Testmöten folded @phone", async ({ page, seedOrg, db }) => {
  const org = await seedOrg();
  const ids: string[] = [];
  // Seven real meetings, a day apart (newest first: m0 … m6), and two Testmöten.
  for (let i = 0; i < 7; i++) {
    const items = i === 0 ? [{ section: "decision" as const, text: "Budgeten är 5 000 kr" }, { section: "action" as const, text: "Boka lokalen" }, { section: "action" as const, text: "Skicka inbjudan" }] : [];
    ids.push((await seedMeeting(db, org, { daysAgo: i + 1, items })).id);
  }
  const tests = [await seedMeeting(db, org, { daysAgo: 0.5 }), await seedMeeting(db, org, { daysAgo: 9 })];
  await db.from("meetings").update({ is_test: true }).in("id", tests.map((m) => m.id));
  await db.from("meetings").update({ title: "Budget och prova-på-kväll" }).eq("id", ids[0]);
  // The calendar event's title wins over a generated one; an agenda gives a fallback title.
  await db.from("meetings").update({ title: "Något annat", calendar_event: { title: "Styrelsemöte november", expected: [], declined: [] } }).eq("id", ids[1]);
  await db.from("meetings").update({ agenda_labels: { "ag-1": "Må-runda", "ag-2": "Ekonomi", "ag-3": "Spelkväll" }, agenda_roles: { "ag-1": "checkin", "ag-2": "topic", "ag-3": "topic" } }).eq("id", ids[2]);

  await page.goto(org.url);
  const list = page.getByRole("list", { name: "Möten" });
  await expect(list.getByRole("listitem")).toHaveCount(5);
  const first = list.getByRole("listitem").nth(0);
  await expect(first).toContainText("Budget och prova-på-kväll");
  await expect(first).toContainText("1 beslut · 2 uppgifter");
  // A finished meeting's title opens its page in the app.
  await expect(first.getByRole("link", { name: "Budget och prova-på-kväll" })).toHaveAttribute("href", `/orgs/${org.id}/mote/${ids[0]}`);
  await expect(list.getByRole("listitem").nth(1)).toContainText("Styrelsemöte november");
  await expect(list.getByRole("listitem").nth(2)).toContainText("Ekonomi och spelkväll");
  // No Testmöte among them.
  await expect(list.getByText("Testmöte")).toHaveCount(0);

  await page.getByText("Visa fler (2)").click();
  await expect(page.getByRole("list", { name: "Äldre möten" }).getByRole("listitem")).toHaveCount(2);

  await page.getByText("Visa testmöten (2)").click();
  const testList = page.getByRole("list", { name: "Testmöten" });
  await expect(testList.getByRole("listitem")).toHaveCount(2);
  await expect(testList.getByRole("listitem").first()).toContainText("Testmöte");
  await expectAccessible(page);
  await expectNoOverflow(page);
});

test("tabs switch in place: the URL follows ?flik=, a visited tab keeps its state, back works", async ({ page, seedOrg, db }) => {
  const org = await seedOrg();
  for (let i = 0; i < 7; i++) await seedMeeting(db, org, { daysAgo: i + 1 });

  await page.goto(org.url);
  const tabs = page.getByRole("navigation", { name: "Föreningens vyer" });
  // State on Möten: the older meetings unfolded.
  await page.getByText("Visa fler (2)").click();
  const older = page.getByRole("list", { name: "Äldre möten" });
  await expect(older).toBeVisible();

  await tabs.getByRole("link", { name: "Översikt" }).click();
  await expect(tabs.getByRole("link", { name: "Översikt" })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}\\?flik=oversikt$`));
  await expect(older).toBeHidden();

  // Back on Möten: the same list, still unfolded (kept, not re-rendered from scratch).
  await tabs.getByRole("link", { name: "Möten" }).click();
  await expect(tabs.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}$`));
  await expect(older).toBeVisible();
  await expect(older.getByRole("listitem")).toHaveCount(2);

  // Browser back returns to Översikt.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}\\?flik=oversikt$`));
  await expect(tabs.getByRole("link", { name: "Översikt" })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page);
});
