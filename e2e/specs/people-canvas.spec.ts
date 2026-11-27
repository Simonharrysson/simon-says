import type { Locator, Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "../env";
import { ensureUser, expect, expectAccessible, test } from "../fixtures";

// The people tree as a canvas (0062), on a desktop: the admin adds Simon, then Adam reporting to
// Simon through the "Lägg till person" form, then Eva, and draws Eva's arrow from Simon's card by
// dragging; a reload keeps the lines and the cards' places. Visibility is the rule as before: a
// meeting for Simons team reaches Adam (in it), never an account outside the tree. A member sees
// the same canvas, read-only. On a phone the same tree is the indented list with the same actions.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function snap(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

/** A Företag owned by the shared admin (their person row at the top). */
async function company(db: SupabaseClient): Promise<{ id: string; url: string }> {
  const admin = await ensureUser(db, ADMIN_EMAIL);
  const id = must("create", await db.rpc("create_foretag", { p_user: admin, p_name: `Kartbolaget ${Date.now().toString(36)}`, p_root_name: "Ledning", p_person_name: "Admin Adminsson" })) as string;
  return { id, url: `/orgs/${id}?flik=personer` };
}

const card = (page: Page, name: string) => page.locator(`.react-flow__node:has([data-person-card="${name}"])`);

/** A real pointer drag in small steps (React Flow and d3-drag need the moves in between). */
async function drag(page: Page, from: Locator, to: Locator, offset = { x: 0, y: 0 }) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2 + offset.x, y: b.y + b.height / 2 + offset.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) await page.mouse.move(start.x + ((end.x - start.x) * i) / 15, start.y + ((end.y - start.y) * i) / 15);
  await page.mouse.up();
}

const saved = (page: Page) => expect(page.locator('.tree-canvas[data-saving="0"]')).toBeVisible({ timeout: 15_000 });

test("Canvas: Adam reports to Simon (form), Eva by dragging an arrow; a reload keeps it; visibility unchanged", async ({ page, db, signedIn, newEmail }) => {
  test.skip(test.info().project.name !== "desktop", "the canvas is the desktop view");
  test.setTimeout(180_000);
  const c = await company(db);
  const person = async (name: string) =>
    must(name, await db.from("people").select("id, group_id, canvas_x, canvas_y").eq("org_id", c.id).eq("name", name).single()) as {
      id: string;
      group_id: string | null;
      canvas_x: number | null;
      canvas_y: number | null;
    };
  const teamOf = async (name: string) => (await db.from("groups").select("id").eq("head_person_id", (await person(name)).id).is("archived_at", null).maybeSingle()).data?.id ?? null;

  await page.goto(c.url);
  const canvas = page.getByRole("region", { name: "Personerna som karta" });
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Admin Adminsson")).toBeVisible();
  // Never a group name, never "Ny grupp".
  await expect(page.getByText("Ledning", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Ny grupp")).toHaveCount(0);

  const addPerson = async (name: string, reportsTo: string | null, via: Locator) => {
    await via.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Namn", { exact: true }).fill(name);
    if (reportsTo) await dialog.getByLabel("Rapporterar till").selectOption((await person(reportsTo)).id);
    await dialog.getByRole("button", { name: "Lägg till" }).click();
    await expect(card(page, name)).toBeVisible({ timeout: 15_000 });
  };
  // Simon at the top, Adam reporting to Simon through the form.
  await addPerson("Simon Chef", null, canvas.getByRole("button", { name: "Lägg till person" }));
  await addPerson("Adam Ek", "Simon Chef", canvas.getByRole("button", { name: "Lägg till person" }));
  await expect.poll(() => teamOf("Simon Chef"), { timeout: 15_000 }).not.toBeNull();
  await expect.poll(async () => (await person("Adam Ek")).group_id, { timeout: 15_000 }).toBe(await teamOf("Simon Chef"));
  await expect(canvas.getByRole("group", { name: "Adam Ek rapporterar till Simon Chef" })).toBeAttached();

  // Eva at the top, then the arrow from Simon's bottom to Eva's top: Eva reports to Simon.
  await addPerson("Eva Lind", null, canvas.getByRole("button", { name: "Lägg till person" }));
  await saved(page);
  await canvas.getByRole("button", { name: "Ordna automatiskt" }).click();
  await saved(page);
  await card(page, "Simon Chef").hover();
  await drag(page, card(page, "Simon Chef").locator(".react-flow__handle-bottom"), card(page, "Eva Lind").locator(".react-flow__handle-top"));
  await expect(page.getByRole("status").filter({ hasText: "Eva Lind rapporterar nu till Simon Chef." })).toBeVisible();
  await expect.poll(async () => (await person("Eva Lind")).group_id, { timeout: 15_000 }).toBe(await teamOf("Simon Chef"));

  // Never a cycle: Simon can't report to Adam (his own report). Nothing changes.
  await card(page, "Adam Ek").hover();
  await drag(page, card(page, "Adam Ek").locator(".react-flow__handle-bottom"), card(page, "Simon Chef").locator(".react-flow__handle-top"));
  await expect.poll(async () => (await person("Simon Chef")).group_id).toBe((await person("Admin Adminsson")).group_id);

  // Move Simon's card; its place is saved.
  const before = await person("Simon Chef");
  await drag(page, card(page, "Simon Chef").locator("h3"), card(page, "Simon Chef").locator("h3"), { x: 140, y: 30 });
  await saved(page);
  await expect.poll(async () => (await person("Simon Chef")).canvas_x, { timeout: 15_000 }).not.toBe(before.canvas_x);
  const moved = await person("Simon Chef");
  await expectAccessible(page);
  await snap(page, "kartan");

  // Reload: the lines and the places are all still there.
  await page.reload();
  await expect(card(page, "Simon Chef")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => card(page, "Simon Chef").evaluate((el) => (el as HTMLElement).style.transform)).toBe(`translate(${moved.canvas_x}px, ${moved.canvas_y}px)`);
  await expect(canvas.getByRole("group", { name: "Adam Ek rapporterar till Simon Chef" })).toBeAttached();
  await expect(canvas.getByRole("group", { name: "Eva Lind rapporterar till Simon Chef" })).toBeAttached();

  // Visibility, unchanged: a meeting for Simons team reaches Adam (in it), not an account outside the tree.
  const adam = newEmail("adam");
  const outside = newEmail("utanfor");
  const [adamId, outsideId] = await Promise.all([ensureUser(db, adam), ensureUser(db, outside)]);
  must("members", await db.from("org_members").insert([adamId, outsideId].map((user_id) => ({ org_id: c.id, user_id, role: "member" }))));
  must("link adam", await db.from("people").update({ member_user_id: adamId }).eq("id", (await person("Adam Ek")).id));
  const meeting = (must(
    "meeting",
    await db
      .from("meetings")
      .insert({ org_id: c.id, started_by: (await ensureUser(db, ADMIN_EMAIL)), doc_id: "doc", notes_tab_id: "t.0", status: "done", group_id: await teamOf("Simon Chef") })
      .select("id")
      .single(),
  ) as { id: string }).id;
  const { page: a } = await signedIn(adam, `/orgs/${c.id}`);
  await expect(a.locator(`a[href*="${meeting}"]`).first()).toBeVisible({ timeout: 30_000 });
  await expect(a.getByText("Simons team").first()).toBeVisible();
  const { page: o } = await signedIn(outside, `/orgs/${c.id}`);
  await expect(o.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(o.locator(`a[href*="${meeting}"]`)).toHaveCount(0);

  // Removing an arrow asks first (and says who then sees more), then Eva is at the top.
  await canvas.getByRole("group", { name: "Eva Lind rapporterar till Simon Chef" }).focus();
  await page.keyboard.press("Delete");
  const confirm = page.getByRole("dialog", { name: "Ta bort pilen från Simon Chef till Eva Lind?" });
  await expect(confirm.getByText("Eva Lind hamnar högst upp")).toBeVisible();
  await confirm.getByRole("button", { name: "Ta bort pilen" }).click();
  await expect.poll(async () => (await person("Eva Lind")).group_id, { timeout: 15_000 }).toBe((await person("Admin Adminsson")).group_id);

  // A member (Adam) sees the same canvas, read-only.
  await a.goto(c.url);
  await expect(a.getByRole("region", { name: "Personerna som karta" })).toBeVisible({ timeout: 30_000 });
  await expect(card(a, "Simon Chef")).toBeVisible();
  await expect(a.getByRole("button", { name: "Ordna automatiskt" })).toHaveCount(0);
  await expect(a.getByRole("button", { name: "Lägg till person" })).toHaveCount(0);
});

test("People tree on a phone: the indented list, with the same actions @phone", async ({ page, db }) => {
  test.skip(test.info().project.name !== "phone", "phone width only");
  test.setTimeout(120_000);
  const c = await company(db);
  await page.goto(c.url);
  await expect(page.getByLabel("Admin Adminsson rapporterar till")).toBeVisible({ timeout: 30_000 });
  // No canvas, no canvas chunk: the list with its forms.
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Karta" })).toBeHidden();
  const add = page.getByRole("region", { name: "Lägg till person" });
  await add.getByLabel("Namn", { exact: true }).fill("Simon Mobil");
  await add.getByRole("button", { name: "Lägg till" }).click();
  await expect(page.getByLabel("Simon Mobil rapporterar till")).toBeVisible({ timeout: 15_000 });
  const simon = (must("simon", await db.from("people").select("id").eq("org_id", c.id).eq("name", "Simon Mobil").single()) as { id: string }).id;
  await add.getByLabel("Namn", { exact: true }).fill("Adam Mobil");
  await add.getByLabel("Rapporterar till").selectOption(simon);
  await add.getByRole("button", { name: "Lägg till" }).click();
  await expect(page.getByLabel("Adam Mobil rapporterar till")).toHaveValue(simon, { timeout: 15_000 });
  const team = (must("team", await db.from("groups").select("id").eq("head_person_id", simon).is("archived_at", null).single()) as { id: string }).id;
  expect((must("adam", await db.from("people").select("group_id").eq("org_id", c.id).eq("name", "Adam Mobil").single()) as { group_id: string }).group_id).toBe(team);
  await expectAccessible(page);
  await snap(page, "telefon-lista");
});
