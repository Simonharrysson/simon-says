import type { Page, TestInfo } from "@playwright/test";
import { auditBorders, formatOffenders } from "../border-audit";
import { ensureUser, expect, seedMeeting, test } from "../fixtures";

// No double borders (docs/ui.md): inside a card, never a second full frame, and no two lines
// whose edges touch. Every main page at 1440 and 390 px is audited in the DOM (e2e/border-audit.ts);
// an offender fails the test with its text, so the fix is easy to find.

/** Desktop runs at 1440 px; the phone project is already 390 px. */
async function sizeFor(page: Page, info: TestInfo) {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
}

/** Open `path`, let it settle, audit it; collects offenders instead of failing at the first page. */
async function visit(page: Page, path: string, offenders: string[], ready?: (page: Page) => Promise<void>) {
  await page.goto(path);
  if (ready) await ready(page);
  await page.waitForLoadState("networkidle");
  const found = await auditBorders(page);
  offenders.push(...formatOffenders(path, found));
  await test.info().attach(path, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

test("no double borders: Hem, Föreningar, a förening's tabs and every settings section, Konto, the start screen @phone", async ({ page, seedOrg, db }, info) => {
  await sizeFor(page, info);
  const org = await seedOrg({ people: [{ name: "Emma Bertmar", email: "emma.bertmar@e2e.test" }, "Erik Lund"] });
  await seedMeeting(db, org, { items: [{ section: "action", text: "Boka lokal till årsmötet", owner: "Erik Lund" }, { section: "decision", text: "Årsmötet hålls i mars" }] });
  const offenders: string[] = [];

  await visit(page, "/hem", offenders);
  await visit(page, "/orgs", offenders);
  await visit(page, org.url, offenders);
  await visit(page, `${org.url}?flik=oversikt`, offenders);
  for (const del of ["foreningen", "styrelsen", "moten", "efter-motet", "radera"]) {
    await visit(page, `${org.url}?flik=installningar&del=${del}`, offenders);
  }
  await visit(page, "/installningar", offenders);
  await visit(page, `/meetings/ny/${org.id}`, offenders, async (p) => {
    await expect(p.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();
  });

  expect(offenders, "double borders (box in a box, or lines that touch)").toEqual([]);
});

test("no double borders: Företag, a company's tabs and its start screen @phone", async ({ db, signedIn, newEmail }, info) => {
  // A company of its own (create_foretag, as "Skapa företag" does), owned by a fresh account.
  const email = newEmail("vd");
  const userId = await ensureUser(db, email);
  const { data: id, error } = await db.rpc("create_foretag", { p_user: userId, p_name: `Ramlösa Bygg ${Date.now().toString(36)}`, p_root_name: "Ledning", p_person_name: "Vera Dahl" });
  if (error) throw new Error(`create_foretag: ${error.message}`);
  const { page } = await signedIn(email, "/foretag");
  await sizeFor(page, info);
  const offenders: string[] = [];

  await visit(page, "/foretag", offenders);
  for (const flik of ["", "?flik=kunder", "?flik=personer", "?flik=installningar"]) {
    await visit(page, `/orgs/${id}${flik}`, offenders);
  }
  await visit(page, `/meetings/ny/${id}`, offenders, async (p) => {
    await expect(p.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();
  });

  expect(offenders, "double borders (box in a box, or lines that touch)").toEqual([]);
});

test("no double borders: Privat @phone", async ({ signedIn, newEmail }, info) => {
  const { page } = await signedIn(newEmail("privat-kanter"), "/privat");
  await sizeFor(page, info);
  const offenders: string[] = [];
  await visit(page, "/privat", offenders);
  expect(offenders, "double borders (box in a box, or lines that touch)").toEqual([]);
});
