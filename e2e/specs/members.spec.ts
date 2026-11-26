import { ADMIN_EMAIL } from "../env";
import { expect, expectAccessible, test } from "../fixtures";

// Invite links, roles and admin handover.

test.describe("invite link", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a cancelled Google sign-in keeps the invite; the second try joins @phone", async ({ page, nextLogin, newEmail, seedOrg, db }) => {
    const org = await seedOrg();
    const member = newEmail("medlem");

    await page.goto(`/join/${org.inviteCode}`);
    await expect(page.getByRole("heading", { name: "Du är inbjuden" })).toBeVisible();
    await expectAccessible(page);

    // Google says "cancelled": back on the login page, still on the way to the invite.
    nextLogin.cancel = true;
    await page.getByRole("button", { name: "Logga in med Google" }).click();
    await expect(page).toHaveURL(new RegExp(`/login\\?fel=avbrutet&next=${encodeURIComponent(`/join/${org.inviteCode}`)}`));
    await expect(page.getByRole("heading", { name: "Försök en gång till" })).toBeVisible();
    await expect(page.getByText("Inloggningen avbröts")).toBeVisible();
    await expect(page.getByText("Logga in för att gå med i föreningen")).toBeVisible();

    nextLogin.cancel = false;
    nextLogin.email = member;
    await page.getByRole("button", { name: "Försök igen med Google" }).click();
    await expect(page).toHaveURL(new RegExp(`/join/${org.inviteCode}$`));
    await expect(page.getByRole("heading", { name: org.name })).toBeVisible();
    await expect(page.getByText(member)).toBeVisible();
    await page.getByRole("button", { name: `Gå med i ${org.name}` }).click();

    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}$`));
    await expect(page.getByText("Du är medlem")).toBeVisible();
    const { data } = await db.from("org_members").select("role").eq("org_id", org.id);
    expect(data?.map((r) => r.role).sort()).toEqual(["admin", "member"]);
  });

  test("an old invite link says it no longer works", async ({ page, nextLogin, newEmail }) => {
    nextLogin.email = newEmail("gammal");
    await page.goto("/join/finnsinte123");
    await page.getByRole("button", { name: "Logga in med Google" }).click();
    await expect(page.getByRole("heading", { name: "Länken fungerar inte längre" })).toBeVisible();
  });
});

test("admin handover: make a member admin, then step down", async ({ page, seedOrg, newEmail, signedIn }) => {
  const member = newEmail("blivande");
  const org = await seedOrg({ members: [member], people: ["Anna Berg"] });

  await page.goto(org.url);
  await expect(page.getByText("Du är admin")).toBeVisible();
  const members = page.getByRole("list", { name: "Medlemmar" });
  const memberRow = members.getByRole("listitem").filter({ hasText: member });
  const meRow = members.getByRole("listitem").filter({ hasText: ADMIN_EMAIL });

  // The only admin can neither step down nor leave.
  await expect(meRow.getByRole("button", { name: "Sluta vara admin" })).toHaveCount(0);

  await memberRow.getByRole("button", { name: "Gör till admin" }).click();
  const dialog = page.getByRole("dialog", { name: `Gör ${member} till admin?` });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Gör till admin" }).click();
  await expect(page.getByText("Medlemmen är nu admin.")).toBeVisible();
  await expect(memberRow).toContainText("admin");

  // Two admins now: the shared admin can step down.
  await meRow.getByRole("button", { name: "Sluta vara admin" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sluta vara admin" }).click();
  await expect(page.getByText("Du är medlem")).toBeVisible();
  // A member sees no admin panels.
  await expect(page.getByRole("heading", { name: "Radera föreningen" })).toHaveCount(0);

  // The new admin sees it from their own account.
  const other = await signedIn(member, org.url);
  await expect(other.page.getByText("Du är admin")).toBeVisible();
  await expect(other.page.getByRole("heading", { name: "Radera föreningen" })).toBeVisible();
});

test("person roles: the admin sets a role on a person", async ({ page, seedOrg }) => {
  const org = await seedOrg({ people: ["Erik Lund"] });
  await page.goto(org.url);
  const people = page.getByRole("list", { name: "Personer" });
  const row = people.getByRole("listitem").filter({ hasText: "Erik Lund" });
  await row.getByRole("button", { name: "Lägg till roll" }).click();
  await page.getByLabel("Roll för Erik Lund").fill("Kassör");
  await row.getByRole("button", { name: "Spara", exact: true }).click();
  await expect(people.getByRole("listitem").filter({ hasText: "Erik Lund" })).toContainText("Kassör");
  await expect(people.getByRole("button", { name: "Ändra roll" })).toBeVisible();
});
