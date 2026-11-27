import type { Page } from "@playwright/test";
import { ADMIN_EMAIL } from "../env";
import { ensureUser, expect, expectAccessible, fake, test } from "../fixtures";

// A förening with groups (0054): the admin turns groups on in Inställningar, builds Styrelsen →
// Utveckling, Kommunikation with the same tree editor as a Företag and places people. A developer
// starts a meeting "för Utveckling": the head above sees it, the Kommunikation member (a cousin)
// never does, and the Doc is shared only with those who see it. A förening that never turns groups
// on is untouched (no "Möte för" at Starta; covered here at the start and by every other spec).

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function snap(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

test("Förening: turn groups on, build the tree, a meeting for Utveckling is seen by the head, never the cousin", async ({ db, seedOrg, signedIn, newEmail }) => {
  test.setTimeout(240_000);
  const people = { dev: newEmail("utvecklare"), head: newEmail("ordf-utv"), com: newEmail("kommunikator") };
  const org = await seedOrg({ members: Object.values(people), people: ["Dev Devsson", "Hedda Head", "Kim Komm"] });
  // Each member is linked to their name in the list (as "Vem av dessa är du?" or an invite would).
  const link = async (name: string, email: string) =>
    must(name, await db.from("people").update({ member_user_id: await ensureUser(db, email) }).eq("org_id", org.id).eq("name", name));
  await link("Dev Devsson", people.dev);
  await link("Hedda Head", people.head);
  await link("Kim Komm", people.com);

  // Off by default: Starta has no "Möte för".
  const { page: dev } = await signedIn(people.dev, `/meetings/ny/${org.id}`);
  await expect(dev.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();
  await expect(dev.getByLabel("Möte för")).toHaveCount(0);

  // The admin turns groups on in Inställningar.
  const { page: admin } = await signedIn(ADMIN_EMAIL, `${org.url}?flik=installningar&del=styrelsen`);
  const groups = admin.getByRole("region", { name: "Grupper" });
  await expect(groups.getByText("Av just nu: alla medlemmar ser alla möten.")).toBeVisible();
  await groups.getByRole("button", { name: "Organisera i grupper" }).click();
  const dialog = admin.getByRole("dialog", { name: `Organisera ${org.name} i grupper?` });
  // The admin account has no name in the list: told before anything changes.
  await expect(dialog.getByText("1 medlem är inte kopplad av en admin", { exact: false })).toBeVisible();
  await expect(dialog.getByLabel("Översta gruppen")).toHaveValue("Styrelsen");
  await dialog.getByRole("button", { name: "Organisera i grupper" }).click();
  await expect(admin.getByRole("heading", { name: "Styrelsen", level: 3, exact: true })).toBeVisible({ timeout: 15_000 });
  expect((must("org", await db.from("orgs").select("groups_enabled").eq("id", org.id).single()) as { groups_enabled: boolean }).groups_enabled).toBe(true);

  const groupId = async (group: string) => (must(group, await db.from("groups").select("id").eq("org_id", org.id).eq("name", group).single()) as { id: string }).id;
  const addGroup = async (group: string) => {
    const form = admin.getByRole("region", { name: "Ny grupp" });
    await form.locator("#group-name").fill(group);
    await form.getByLabel("Under").selectOption(await groupId("Styrelsen"));
    await form.getByRole("button", { name: "Lägg till" }).click();
    await expect(admin.getByRole("heading", { name: group, level: 3, exact: true })).toBeVisible({ timeout: 15_000 });
  };
  await addGroup("Utveckling");
  await addGroup("Kommunikation");
  const move = async (name: string, group: string) => {
    const id = await groupId(group);
    await admin.getByLabel(`Flytta ${name} till`).selectOption(id);
    await expect
      .poll(async () => (must("p", await db.from("people").select("group_id").eq("org_id", org.id).eq("name", name).single()) as { group_id: string }).group_id, { timeout: 15_000 })
      .toBe(id);
  };
  await move("Dev Devsson", "Utveckling");
  await move("Kim Komm", "Kommunikation");
  await admin.reload();
  await expect(admin.locator('[data-group="Utveckling"]').getByText("Dev Devsson")).toBeVisible();
  await expect(admin.locator('[data-group="Styrelsen"]').getByText("Hedda Head")).toBeVisible();
  await expect(admin.locator('[data-group="Utveckling"]').getByText("Ses av: Styrelsen")).toBeVisible();
  await expectAccessible(admin);
  await snap(admin, "forening-grupper");

  // The developer starts a meeting: "Möte för" is their own group; the format choice stays.
  await dev.goto(`/meetings/ny/${org.id}`);
  await expect(dev.getByLabel("Möte för")).toHaveValue(await groupId("Utveckling"));
  await expect(dev.getByText("Ser mötet: Utveckling, grupperna ovanför och admins.")).toBeVisible();
  await expect(dev.getByRole("option", { name: "Hela föreningen" })).toHaveCount(1);
  await expect(dev.locator("p").filter({ hasText: /^Nytt dokument i / })).toBeVisible();
  const consent = dev.getByRole("checkbox", { name: "Alla i rummet vet att mötet transkriberas och kan be om paus" });
  await expect(async () => {
    await consent.check({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expectAccessible(dev);
  await snap(dev, "forening-mote-for");
  await dev.getByRole("button", { name: "Starta mötet" }).click();
  await expect(dev.getByRole("heading", { name: "Namnrunda" })).toBeVisible({ timeout: 30_000 });
  await expect(dev).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  const meetingId = dev.url().split("/").at(-1)!;

  const row = must("meeting", await db.from("meetings").select("group_id, private, doc_id").eq("id", meetingId).single()) as { group_id: string; private: boolean; doc_id: string };
  expect(row).toMatchObject({ group_id: await groupId("Utveckling"), private: false });
  // The Doc went only to those who see the meeting: the head and the admin, never the cousin.
  const shared = (await fake.doc(row.doc_id))?.permissions ?? [];
  expect(shared).toEqual(expect.arrayContaining([people.head, ADMIN_EMAIL]));
  expect(shared).not.toContain(people.com);
  await dev.close();
  must("end", await db.from("meetings").update({ status: "done", end_status: "done", ended_at: new Date().toISOString() }).eq("id", meetingId));

  const sees = async (email: string, yes: boolean) => {
    const { page } = await signedIn(email, org.url);
    await expect(page.getByRole("heading", { name: org.name, level: 1 })).toBeVisible();
    const meetingLink = page.locator(`a[href*="${meetingId}"]`);
    if (yes) await expect(meetingLink.first()).toBeVisible();
    else await expect(meetingLink).toHaveCount(0);
  };
  await sees(people.head, true);
  await sees(ADMIN_EMAIL, true);
  await sees(people.com, false);
});
