import type { Page } from "@playwright/test";
import { auditBorders, formatOffenders } from "../border-audit";
import { expect, expectAccessible, fake, queuePick, test } from "../fixtures";

// The förening's own Drive account (0070), in Kom igång's folder step: "Använd ett annat
// Google-konto" runs Google's consent (the fake answers for styrelsen@forening.e2e.test), the
// Picker then opens THAT account's Drive with shared drives shown, and "Koppla från" removes it.
// Google refusing the account later shows "Drive-kopplingen behöver förnyas" to admins.

const ACCOUNT = "styrelsen@forening.e2e.test";

/** No double borders in the folder card's new states (docs/ui.md). */
const noDoubleBorders = async (page: Page, where: string) => expect(formatOffenders(where, await auditBorders(page))).toEqual([]);

test("folder step: connect the förening's Google account, pick its folder, disconnect @phone", async ({ page, seedOrg, db }) => {
  const org = await seedOrg();
  await page.goto(`${org.url}/kom-igang?steg=3`);
  await expect(page.getByRole("heading", { name: "Var ska mötesdokumenten ligga?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Välj mapp i Google Drive" })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Använd ett annat Google-konto" }).click();
  await expect(page).toHaveURL(/kom-igang\?steg=3&drivekonto=ok/);
  await expect(page.getByText("Kontot är kopplat. Välj mötesmappen i det kontot.")).toBeVisible();
  await expect(page.getByText(`Dokumenten ligger i ${ACCOUNT}`)).toBeVisible();
  await expectAccessible(page);
  await noDoubleBorders(page, "kom-igang connected");

  // Stored for the förening, encrypted, with the consent's account (service role only).
  const { data: row } = await db.from("org_drive_accounts").select("google_email, google_sub, refresh_token_enc, folder_id").eq("org_id", org.id).single();
  expect(row).toMatchObject({ google_email: ACCOUNT, google_sub: `e2e-sub-${ACCOUNT}`, folder_id: null });
  expect(row!.refresh_token_enc).toMatch(/^v1:/);
  expect(row!.refresh_token_enc).not.toContain("e2e-refresh");

  // The Picker opens the förening's account, shared drives included.
  const folder = await fake.createDoc({ name: `Styrelsen ${org.name}`, mimeType: "application/vnd.google-apps.folder", owner: ACCOUNT });
  await queuePick(page, [{ id: folder.id, name: folder.name, mimeType: "application/vnd.google-apps.folder" }]);
  await page.getByRole("button", { name: `Välj mapp i ${ACCOUNT}` }).click();
  // Saved first (the server's 204), then the card shows it after its refresh.
  await expect.poll(async () => (await db.from("org_drive_accounts").select("folder_id").eq("org_id", org.id).single()).data?.folder_id, { timeout: 20_000 }).toBe(folder.id);
  await expect(page.getByText(folder.name)).toBeVisible({ timeout: 20_000 });
  const opened = await page.evaluate(() => (window as unknown as { __e2ePickerOpened: { account: string; features: string[]; views: { drives: boolean }[] }[] }).__e2ePickerOpened.at(-1));
  expect(opened?.account).toBe(ACCOUNT);
  expect(opened?.features).toContain("supportDrives");
  expect(opened?.views.every((v) => v.drives)).toBe(true);
  const { data: picked } = await db.from("org_drive_accounts").select("folder_id").eq("org_id", org.id).single();
  expect(picked?.folder_id).toBe(folder.id);
  const { data: orgRow } = await db.from("orgs").select("meeting_folder_id").eq("id", org.id).single();
  expect(orgRow?.meeting_folder_id).toBe(folder.id);

  // Koppla från: confirmed, our copy removed.
  await page.getByRole("button", { name: "Koppla från" }).click();
  const dialog = page.getByRole("dialog", { name: `Koppla från ${ACCOUNT}?` });
  await expect(dialog).toContainText("Dokumenten som redan finns ligger kvar");
  await dialog.getByRole("button", { name: "Koppla från" }).click();
  await expect(page.getByText("Kontot är bortkopplat.")).toBeVisible();
  const { count } = await db.from("org_drive_accounts").select("org_id", { count: "exact", head: true }).eq("org_id", org.id);
  expect(count).toBe(0);
});

test("a refused förening account: admins see Drive-kopplingen behöver förnyas, the Picker stays shut", async ({ page, seedOrg, db }) => {
  const org = await seedOrg();
  await page.goto(`${org.url}?flik=installningar&del=moten`);
  await page.getByRole("button", { name: "Använd ett annat Google-konto" }).click();
  await expect(page).toHaveURL(/flik=installningar&del=moten&drivekonto=ok/);
  await expect(page.getByText(`Dokumenten ligger i ${ACCOUNT}`)).toBeVisible();

  // Google stops accepting it (revoked): marked lost, never replaced by anyone else's Drive.
  await db.from("org_drive_accounts").update({ lost_at: new Date().toISOString() }).eq("org_id", org.id);
  await page.goto(`${org.url}?flik=installningar&del=moten`);
  await expect(page.getByText("Drive-kopplingen behöver förnyas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Förnya" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Välj mapp i ${ACCOUNT}` })).toHaveCount(0);
  await expectAccessible(page);
  await noDoubleBorders(page, "settings lost");

  // The Möten tab tells admins too, with the way to the folder card.
  await page.goto(org.url);
  await expect(page.getByText("Drive-kopplingen behöver förnyas")).toBeVisible();

  // Förnya: the consent again clears it.
  await page.goto(`${org.url}?flik=installningar&del=moten`);
  await page.getByRole("button", { name: "Förnya" }).click();
  await expect(page).toHaveURL(/drivekonto=ok/);
  await expect(page.getByText("Drive-kopplingen behöver förnyas")).toHaveCount(0);
  const { data } = await db.from("org_drive_accounts").select("lost_at").eq("org_id", org.id).single();
  expect(data?.lost_at).toBeNull();
});
