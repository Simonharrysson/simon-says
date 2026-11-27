import type { Locator, Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "../env";
import { ensureUser, expect, expectAccessible, test } from "../fixtures";

// The tree as a canvas (0055), on a desktop: the admin adds two groups with the "Ny grupp" card,
// draws the arrow parent → child by dragging from one card's bottom handle to the other's top,
// drags a person's avatar into another card, and moves a card; a reload keeps it all. A member
// sees the same canvas, read-only. On a phone the same tree is the list (no canvas at all).

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function snap(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

/** A Företag owned by the shared admin, with Pelle placed in the top group (Ledning). */
async function company(db: SupabaseClient): Promise<{ id: string; url: string; root: string }> {
  const admin = await ensureUser(db, ADMIN_EMAIL);
  const id = must("create", await db.rpc("create_foretag", { p_user: admin, p_name: `Kartbolaget ${Date.now().toString(36)}`, p_root_name: "Ledning", p_person_name: "Admin" })) as string;
  const root = (must("root", await db.from("groups").select("id").eq("org_id", id).single()) as { id: string }).id;
  must("pelle", await db.from("people").insert({ org_id: id, name: "Pelle Persson", group_id: root }));
  return { id, url: `/orgs/${id}?flik=personer`, root };
}

const card = (page: Page, name: string) => page.locator(`.react-flow__node:has([data-group-card="${name}"])`);

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

test("Canvas: two groups, an arrow parent → child, a person dragged across, positions kept after reload", async ({ page, db, signedIn, newEmail }) => {
  test.skip(test.info().project.name !== "desktop", "the canvas is the desktop view");
  test.setTimeout(180_000);
  const c = await company(db);
  const groupRow = async (name: string) =>
    must(name, await db.from("groups").select("id, parent_group_id, canvas_x, canvas_y").eq("org_id", c.id).eq("name", name).single()) as {
      id: string;
      parent_group_id: string | null;
      canvas_x: number | null;
      canvas_y: number | null;
    };

  await page.goto(c.url);
  const canvas = page.getByRole("region", { name: "Trädet som karta" });
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Ledning")).toBeVisible();
  // The list is there for "Lista" and phones, hidden here.
  await expect(page.getByRole("region", { name: "Ny grupp" })).toBeHidden();

  // Two groups from the "+ Ny grupp" card, both at the top.
  for (const name of ["Alfa", "Beta"]) {
    await canvas.getByRole("button", { name: "Ny grupp" }).click();
    const dialog = page.getByRole("dialog", { name: "Ny grupp" });
    await dialog.getByLabel("Namn").fill(name);
    await dialog.getByRole("button", { name: "Lägg till" }).click();
    await expect(card(page, name)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await groupRow(name)).parent_group_id, { timeout: 15_000 }).toBeNull();
  }
  await saved(page);
  await canvas.getByRole("button", { name: "Ordna automatiskt" }).click();
  await saved(page);

  // Alfa → Beta: from Alfa's bottom handle to Beta's top handle.
  await card(page, "Alfa").hover();
  await drag(page, card(page, "Alfa").locator(".react-flow__handle-bottom"), card(page, "Beta").locator(".react-flow__handle-top"));
  await expect(page.getByRole("status").filter({ hasText: "Beta ligger nu under Alfa." })).toBeVisible();
  await expect.poll(async () => (await groupRow("Beta")).parent_group_id, { timeout: 15_000 }).toBe((await groupRow("Alfa")).id);
  await expect(canvas.getByRole("group", { name: "Pil från Alfa till Beta" })).toBeAttached();

  // A cycle is refused before it reaches the server: Beta → Alfa draws nothing.
  await card(page, "Beta").hover();
  await drag(page, card(page, "Beta").locator(".react-flow__handle-bottom"), card(page, "Alfa").locator(".react-flow__handle-top"));
  await expect.poll(async () => (await groupRow("Alfa")).parent_group_id).toBeNull();

  // Pelle's avatar from Ledning into Beta (same database function as "Flytta till").
  await card(page, "Ledning").getByRole("button", { name: /Pelle Persson/ }).dragTo(card(page, "Beta"));
  await expect(page.getByRole("status").filter({ hasText: "Pelle Persson flyttades till Beta." })).toBeVisible();
  const beta = (await groupRow("Beta")).id;
  await expect
    .poll(async () => (must("pelle", await db.from("people").select("group_id").eq("org_id", c.id).eq("name", "Pelle Persson").single()) as { group_id: string }).group_id, {
      timeout: 15_000,
    })
    .toBe(beta);

  // Move Alfa by its title; the place is saved.
  const before = await groupRow("Alfa");
  await drag(page, card(page, "Alfa").locator("h3"), card(page, "Alfa").locator("h3"), { x: 120, y: 40 });
  await saved(page);
  await expect.poll(async () => (await groupRow("Alfa")).canvas_x, { timeout: 15_000 }).not.toBe(before.canvas_x);
  const moved = await groupRow("Alfa");
  await expectAccessible(page);
  await snap(page, "kartan");

  // Reload: positions, the arrow and Pelle's place are all still there.
  await page.reload();
  await expect(card(page, "Alfa")).toBeVisible({ timeout: 30_000 });
  // The card sits exactly where it was saved.
  expect(await groupRow("Alfa")).toMatchObject({ canvas_x: moved.canvas_x, canvas_y: moved.canvas_y });
  await expect.poll(() => card(page, "Alfa").evaluate((el) => (el as HTMLElement).style.transform)).toBe(`translate(${moved.canvas_x}px, ${moved.canvas_y}px)`);
  await expect(canvas.getByRole("group", { name: "Pil från Alfa till Beta" })).toBeAttached();
  await expect(card(page, "Beta").getByRole("button", { name: /Pelle Persson/ })).toBeVisible();

  // Removing the arrow asks first (and says who then sees more), then Beta is at the top.
  await canvas.getByRole("group", { name: "Pil från Alfa till Beta" }).focus();
  await page.keyboard.press("Delete");
  const confirm = page.getByRole("dialog", { name: "Ta bort pilen från Alfa till Beta?" });
  await expect(confirm.getByText("Personerna i Beta ser då möten i alla grupper längre ner")).toBeVisible();
  await confirm.getByRole("button", { name: "Ta bort pilen" }).click();
  await expect.poll(async () => (await groupRow("Beta")).parent_group_id, { timeout: 15_000 }).toBeNull();

  // A member sees the same canvas, read-only.
  const member = newEmail("kartmedlem");
  must("member", await db.from("org_members").insert({ org_id: c.id, user_id: await ensureUser(db, member), role: "member" }));
  const { page: m } = await signedIn(member, c.url);
  await expect(m.getByRole("region", { name: "Trädet som karta" })).toBeVisible({ timeout: 30_000 });
  await expect(card(m, "Alfa")).toBeVisible();
  await expect(m.getByRole("button", { name: "Ordna automatiskt" })).toHaveCount(0);
  await expect(m.getByRole("button", { name: "Ny grupp" })).toHaveCount(0);
  await expect(card(m, "Beta").getByRole("button", { name: /Pelle Persson/ })).toHaveCount(0);
});

test("Canvas on a phone: the same tree as the list, with its actions @phone", async ({ page, db }) => {
  test.skip(test.info().project.name !== "phone", "phone width only");
  test.setTimeout(120_000);
  const c = await company(db);
  await page.goto(c.url);
  await expect(page.getByRole("heading", { name: "Ledning", level: 3 })).toBeVisible({ timeout: 30_000 });
  // No canvas, no canvas chunk: the list with its forms.
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Karta" })).toBeHidden();
  const form = page.getByRole("region", { name: "Ny grupp" });
  await form.locator("#group-name").fill("Mobilgrupp");
  await form.getByLabel("Under").selectOption(c.root);
  await form.getByRole("button", { name: "Lägg till" }).click();
  await expect(page.getByRole("heading", { name: "Mobilgrupp", level: 3 })).toBeVisible({ timeout: 15_000 });
  const mobil = (must("mobil", await db.from("groups").select("id").eq("org_id", c.id).eq("name", "Mobilgrupp").single()) as { id: string }).id;
  await page.getByLabel("Flytta Pelle Persson till").selectOption(mobil);
  await expect
    .poll(async () => (await db.from("people").select("group_id").eq("org_id", c.id).eq("name", "Pelle Persson").single()).data?.group_id, { timeout: 15_000 })
    .toBe(mobil);
  await expectAccessible(page);
  await snap(page, "telefon-lista");
});
