import type { Page } from "@playwright/test";
import { ADMIN_EMAIL } from "../env";
import { ensureUser, expect, expectAccessible, fake, test, treeAsList } from "../fixtures";

// A förening with the tree (0054, people first since 0062): the admin turns it on in Inställningar
// and draws who reports to whom with the same editor as a Företag: Dev reports to Hedda, Kim to
// Kalle (both at the top). Dev starts a meeting "för Heddas team": Hedda sees it, Kim (a cousin)
// never does, and the Doc is shared only with those who see it. A förening that never turns groups
// on is untouched (no "Möte för" at Starta; covered here at the start and by every other spec).

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function snap(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

test("Förening: turn the tree on, draw who reports to whom, a meeting for Heddas team is seen by Hedda, never the cousin", async ({ db, seedOrg, signedIn, newEmail }) => {
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

  const personId = async (orgId: string, name: string) => (must(name, await db.from("people").select("id").eq("org_id", orgId).eq("name", name).single()) as { id: string }).id;

  // The admin turns the tree on in Inställningar.
  const { page: admin } = await signedIn(ADMIN_EMAIL, `${org.url}?flik=installningar&del=styrelsen`);
  // This spec drives the list's forms (the canvas: people-canvas.spec.ts).
  await treeAsList(admin);
  const section = admin.getByRole("region", { name: "Vem rapporterar till vem" });
  await expect(section.getByText("Av just nu: alla medlemmar ser alla möten.")).toBeVisible();
  await section.getByRole("button", { name: "Organisera i ett träd" }).click();
  const dialog = admin.getByRole("dialog", { name: `Organisera ${org.name} i ett träd?` });
  // The admin account has no name in the list: told before anything changes. No team names asked for.
  await expect(dialog.getByText("1 medlem är inte kopplad av en admin", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Organisera i ett träd" }).click();
  await expect(admin.getByLabel("Hedda Head rapporterar till")).toBeVisible({ timeout: 15_000 });
  expect((must("org", await db.from("orgs").select("groups_enabled").eq("id", org.id).single()) as { groups_enabled: boolean }).groups_enabled).toBe(true);

  // People, not groups: Kalle (no account) at the top beside Hedda; Dev reports to Hedda, Kim to Kalle.
  const add = admin.getByRole("region", { name: "Lägg till person" });
  await add.getByLabel("Namn", { exact: true }).fill("Kalle Chef");
  await add.getByRole("button", { name: "Lägg till" }).click();
  await expect(admin.getByLabel("Kalle Chef rapporterar till")).toBeVisible({ timeout: 15_000 });
  const reportTo = async (name: string, manager: string) => {
    const managerId = await personId(org.id, manager);
    await admin.getByLabel(`${name} rapporterar till`).selectOption(managerId);
    await expect.poll(async () => (await db.from("people").select("group_id").eq("org_id", org.id).eq("name", name).single()).data?.group_id, { timeout: 15_000 }).toBe(await teamOf(manager));
  };
  const teamOf = async (manager: string) =>
    (await db.from("groups").select("id").eq("head_person_id", await personId(org.id, manager)).is("archived_at", null).maybeSingle()).data?.id ?? "none";
  await reportTo("Dev Devsson", "Hedda Head");
  await reportTo("Kim Komm", "Kalle Chef");
  await admin.reload();
  // Indented under their manager; never a group name anywhere.
  await expect(admin.getByLabel("Dev Devsson rapporterar till")).toHaveValue(await personId(org.id, "Hedda Head"));
  await expect(admin.locator('[data-groups="on"]').getByText("Styrelsen", { exact: true })).toHaveCount(0);
  await expectAccessible(admin);
  await snap(admin, "forening-trad");

  // The developer starts a meeting: "Möte för" is their own group; the format choice stays.
  await dev.goto(`/meetings/ny/${org.id}`);
  await expect(dev.getByLabel("Möte för")).toHaveValue(await teamOf("Hedda Head"));
  await expect(dev.getByText("Ser mötet: Heddas team, cheferna ovanför och admins.")).toBeVisible();
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
  expect(row).toMatchObject({ group_id: await teamOf("Hedda Head"), private: false });
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
