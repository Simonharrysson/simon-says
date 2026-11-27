import { ADMIN_EMAIL } from "../env";
import { ensureUser, expect, expectAccessible, test } from "../fixtures";
import { FAKE_BOARD, FAKE_SITE_HOST } from "../fakes/website";

// "Hämta styrelsen från webbplatsen" (0061): the admin saves the förening's website; the app reads
// the fake site (e2e/fakes/website.ts: robots.txt, the start page, the board page in ISO-8859-1),
// asks the fake Claude once and suggests the board. Nothing is saved until the admin confirms; a
// name the fake Claude made up (not on the site) is never offered; someone already on the board is
// marked. Företag (0050) gets the logo and the website field, nothing more.

test("Hämta styrelsen: suggestions from the website, added only after confirming @phone", async ({ page, seedOrg, db }) => {
  const org = await seedOrg({ people: ["Karin Ekholm"] });
  await page.goto(`${org.url}?flik=installningar`);
  const form = page.locator("section", { has: page.getByRole("heading", { name: "Namn, logga och om oss" }) });

  await form.getByLabel("Webbplats").fill(FAKE_SITE_HOST);
  await form.getByRole("button", { name: "Spara", exact: true }).click();
  await expect(form.getByText("Sparat")).toBeVisible();

  // Saving a new website starts the fetch by itself.
  const card = form.getByRole("region", { name: "Styrelsen från webbplatsen" });
  await expect(card.getByText("Vi hittade på er webbplats:")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(`${FAKE_BOARD.length} personer i styrelsen – lägg till?`)).toBeVisible();
  const list = card.getByRole("list", { name: "Föreslagna personer i styrelsen" });
  await expect(list.getByRole("listitem")).toHaveCount(FAKE_BOARD.length);
  // å/ä/ö survive the ISO-8859-1 page; the made-up name is not offered.
  await expect(list.getByRole("textbox", { name: "Namn" }).nth(2)).toHaveValue("Åsa Lindqvist");
  await expect(card.getByText("Påhittad Persson")).toHaveCount(0);
  // Valberedningen (Per Sand) is not the board: the fake Claude leaves it out, and so does the list.
  const offered = await list.getByRole("textbox", { name: "Namn" }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(offered).toEqual(FAKE_BOARD.map((p) => p.name));
  // Karin is already on the board: marked, not ticked.
  await expect(card.getByRole("checkbox", { name: "Lägg till Karin Ekholm" })).not.toBeChecked();
  await expect(card.getByText("Finns redan")).toBeVisible();
  await expectAccessible(page);

  // Nothing saved yet.
  const names = async () => ((await db.from("people").select("name, role").eq("org_id", org.id)).data ?? []) as { name: string; role: string | null }[];
  expect(await names()).toHaveLength(1);

  // Untick one, fix a role, add the rest.
  await card.getByRole("checkbox", { name: "Lägg till Nora Vik" }).click();
  await card.getByRole("textbox", { name: "Roll för Mikael Strand" }).fill("Vice ordförande");
  await card.getByRole("button", { name: "Lägg till 4 personer" }).click();
  await expect(card.getByText("4 personer lades till i styrelsen.")).toBeVisible({ timeout: 15_000 });

  const saved = await names();
  expect(saved.map((p) => p.name).sort()).toEqual(["Jonas Åberg", "Karin Ekholm", "Leila Haddad", "Mikael Strand", "Åsa Lindqvist"].sort());
  expect(saved.find((p) => p.name === "Mikael Strand")?.role).toBe("Vice ordförande");
  expect(saved.find((p) => p.name === "Jonas Åberg")?.role).toBe("Kassör");
  const { data: people } = await db.from("people").select("email").eq("org_id", org.id);
  expect((people ?? []).every((p) => p.email === null)).toBe(true);

  const { data: log } = await db.from("website_fetches").select("outcome, found").eq("org_id", org.id);
  expect(log).toEqual([{ outcome: "ok", found: FAKE_BOARD.length }]);
});

test("Hämta styrelsen: an unreadable website fails softly and saving still works", async ({ page, seedOrg, db }) => {
  const org = await seedOrg();
  await page.goto(`${org.url}?flik=installningar`);
  const form = page.locator("section", { has: page.getByRole("heading", { name: "Namn, logga och om oss" }) });
  await form.getByLabel("Webbplats").fill("finns-inte-alls.example");
  await form.getByRole("button", { name: "Spara", exact: true }).click();
  await expect(form.getByText("Sparat")).toBeVisible();
  await expect(form.getByText("Vi kunde inte läsa webbplatsen just nu.")).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole("button", { name: "Försök igen" })).toBeVisible();
  const { data } = await db.from("orgs").select("website_url").eq("id", org.id).single();
  expect(data?.website_url).toBe("https://finns-inte-alls.example/");
  const { data: log } = await db.from("website_fetches").select("outcome").eq("org_id", org.id);
  expect(log).toEqual([{ outcome: "http_status" }]);
});

test("Företag: the admin sets the website; it shows in the header, no board fetch", async ({ page, db }) => {
  const userId = await ensureUser(db, ADMIN_EMAIL);
  const name = `Webbbolaget ${Date.now().toString(36)}`;
  const { data: id, error } = await db.rpc("create_foretag", { p_user: userId, p_name: name, p_root_name: "Ledning", p_person_name: "Admin" });
  if (error) throw new Error(error.message);
  await page.goto(`/orgs/${id}?flik=installningar`);
  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Logga och webbplats" }) });
  await expect(panel.getByRole("button", { name: "Ladda upp logga", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Facebook")).toHaveCount(0);
  await expect(panel.getByLabel("Om oss")).toHaveCount(0);
  await panel.getByLabel("Webbplats").fill("bolaget-exempel.example");
  await panel.getByRole("button", { name: "Spara", exact: true }).click();
  await expect(panel.getByText("Sparat")).toBeVisible();
  await expect(page.getByRole("region", { name: "Styrelsen från webbplatsen" })).toHaveCount(0);
  await expectAccessible(page);

  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  await expect(header.getByRole("list", { name: "Företaget på nätet" }).getByRole("link", { name: /bolaget-exempel\.example/ })).toHaveAttribute("href", "https://bolaget-exempel.example/");
  const { data } = await db.from("orgs").select("website_url, about").eq("id", id).single();
  expect(data).toEqual({ website_url: "https://bolaget-exempel.example/", about: null });
});
