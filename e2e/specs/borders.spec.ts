import type { Locator, Page, TestInfo } from "@playwright/test";
import { auditBorders, formatOffenders } from "../border-audit";
import { ensureUser, expect, seedMeeting, test } from "../fixtures";

// No double borders (docs/ui.md): inside a card, never a second full frame, and no two lines
// whose edges touch. Every main page at 1440 and 390 px is audited in the DOM (e2e/border-audit.ts);
// an offender fails the test with its text, so the fix is easy to find.

/** Desktop runs at 1440 px; the phone project is already 390 px. */
async function sizeFor(page: Page, info: TestInfo) {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
}

/** Open `path`, wait for its real content (`ready`, a heading or landmark of that page), audit it;
 * collects offenders instead of failing at the first page. */
async function visit(page: Page, path: string, offenders: string[], ready: (page: Page) => Locator) {
  await page.goto(path);
  await expect(ready(page)).toBeVisible();
  const found = await auditBorders(page);
  offenders.push(...formatOffenders(path, found));
  await test.info().attach(path, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

test("no double borders: Hem, Föreningar, a förening's tabs, a meeting's page, every settings section, Konto, the start screen @phone", async ({ page, seedOrg, db }, info) => {
  await sizeFor(page, info);
  const org = await seedOrg({ people: [{ name: "Emma Bertmar", email: "emma.bertmar@e2e.test" }, "Erik Lund"] });
  const meeting = await seedMeeting(db, org, { items: [{ section: "action", text: "Boka lokal till årsmötet", owner: "Erik Lund" }, { section: "decision", text: "Årsmötet hålls i mars" }] });
  const offenders: string[] = [];

  await visit(page, "/hem", offenders, (p) => p.getByRole("heading", { name: "Hem", level: 1 }));
  await visit(page, "/orgs", offenders, (p) => p.getByRole("heading", { name: "Föreningar", level: 1 }));
  // The tab (or section) marked current: that view's content is the one on screen.
  const tab = (name: string) => (p: Page) => p.getByRole("navigation", { name: "Föreningens vyer" }).getByRole("link", { name, exact: true }).and(p.locator('[aria-current="page"]'));
  await visit(page, org.url, offenders, tab("Möten"));
  await visit(page, `${org.url}?flik=oversikt`, offenders, tab("Översikt"));
  // A meeting's page: the recap, decisions and tasks.
  await visit(page, `${org.url}/mote/${meeting.id}`, offenders, (p) => p.getByRole("heading", { name: "Uppgifter", exact: true }));
  const sections: Record<string, (p: Page) => Locator> = {
    foreningen: (p) => p.getByRole("heading", { name: "Namn, logga och om oss", exact: true }),
    styrelsen: (p) => p.getByRole("list", { name: "Styrelsen" }),
    moten: (p) => p.getByRole("heading", { name: "Röster", exact: true }),
    "efter-motet": (p) => p.getByRole("group", { name: "Sammanfattning efter mötet" }),
    claude: (p) => p.getByRole("heading", { name: "Vad Claude ska veta", exact: true }),
    radera: (p) => p.getByRole("heading", { name: "Radera föreningen" }),
  };
  for (const [del, ready] of Object.entries(sections)) {
    await visit(page, `${org.url}?flik=installningar&del=${del}`, offenders, ready);
  }
  await visit(page, "/installningar", offenders, (p) => p.getByRole("heading", { name: "Ditt konto", level: 1 }));
  await visit(page, `/meetings/ny/${org.id}`, offenders, (p) => p.getByRole("checkbox", { name: "Alla i rummet vet att mötet transkriberas och kan be om paus" }));

  expect(offenders, "double borders (box in a box, or lines that touch)").toEqual([]);
});

test("no double borders: Företag, a company's tabs and its start screen @phone", async ({ db, signedIn, newEmail }, info) => {
  // A company of its own (create_foretag, as "Skapa företag" does), owned by a fresh account.
  const email = newEmail("vd");
  const userId = await ensureUser(db, email);
  const name = `Ramlösa Bygg ${Date.now().toString(36)}`;
  const { data: id, error } = await db.rpc("create_foretag", { p_user: userId, p_name: name, p_root_name: "Ledning", p_person_name: "Vera Dahl" });
  if (error) throw new Error(`create_foretag: ${error.message}`);
  const { page } = await signedIn(email, "/foretag");
  await sizeFor(page, info);
  const offenders: string[] = [];

  await visit(page, "/foretag", offenders, (p) => p.getByRole("region", { name: "Dina företag" }).getByRole("link", { name }));
  const tab = (label: string) => (p: Page) => p.getByRole("navigation", { name: "Företagets flikar" }).getByRole("link", { name: label, exact: true }).and(p.locator('[aria-current="page"]'));
  await visit(page, `/orgs/${id}`, offenders, tab("Möten"));
  await visit(page, `/orgs/${id}?flik=kunder`, offenders, tab("Kunder"));
  // People first (0062): the canvas card on a desktop, the list row on a phone; never a group name.
  await visit(page, `/orgs/${id}?flik=personer`, offenders, (p) =>
    p.locator('[data-person-card="Vera Dahl"], [data-person-row="Vera Dahl"]').filter({ visible: true }).first(),
  );
  await visit(page, `/orgs/${id}?flik=installningar`, offenders, tab("Inställningar"));
  await visit(page, `/meetings/ny/${id}`, offenders, (p) => p.getByRole("heading", { name: "Innan ni börjar" }));

  expect(offenders, "double borders (box in a box, or lines that touch)").toEqual([]);
});

test("no double borders: Privat @phone", async ({ signedIn, newEmail }, info) => {
  const { page } = await signedIn(newEmail("privat-kanter"), "/privat");
  await sizeFor(page, info);
  const offenders: string[] = [];
  await visit(page, "/privat", offenders, (p) => p.getByRole("heading", { name: "Privat", level: 1 }));
  expect(offenders, "double borders (box in a box, or lines that touch)").toEqual([]);
});
