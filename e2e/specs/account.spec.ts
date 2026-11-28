import type { Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { auditBorders, formatOffenders } from "../border-audit";
import { APP_URL } from "../env";
import { ensureUser, expect, expectAccessible, test } from "../fixtures";

// Konto (/installningar): collapsible sections (all closed, a summary in each header, remembered
// per account, opened by a deep link) and "Koppla till din AI" (tiles, steps, copy, Koppla från).

const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const toggle = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

test("Konto: sections start closed with a summary, open and are remembered, #ai opens its section; copy the address @phone", async ({ signedIn, newEmail }, info) => {
  const { page, context } = await signedIn(newEmail("konto-sektioner"), "/installningar");
  if (info.project.name === "phone") await page.setViewportSize({ width: 390, height: 844 });
  else await page.setViewportSize({ width: 1440, height: 900 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP_URL });

  // All closed; the headers say the state.
  await expect(page.getByRole("heading", { name: "Ditt konto", level: 1 })).toBeVisible();
  await expect(page.locator('[data-section-trigger][aria-expanded="true"]')).toHaveCount(0);
  await expect(section(page, "Mejl från Simon Says").getByText(/^\d av \d på$/)).toBeVisible();
  await expect(section(page, "Kalender").getByText("Inte kopplad")).toBeVisible();
  await expect(section(page, "Koppla till din AI").getByText("Inte kopplad")).toBeVisible();
  await expect(page.getByRole("switch", { name: /^Inbjudningar/ })).toBeHidden();

  // Open Mejl: the switches show; the choice survives a reload; closing hides them again.
  await toggle(page, "Mejl från Simon Says").click();
  await expect(toggle(page, "Mejl från Simon Says")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("switch", { name: /^Inbjudningar/ })).toBeVisible();
  await expectAccessible(page);
  await page.reload();
  await expect(toggle(page, "Mejl från Simon Says")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("switch", { name: /^Inbjudningar/ })).toBeVisible();
  await expect(toggle(page, "Kalender")).toHaveAttribute("aria-expanded", "false");
  // Keyboard: Enter on the focused header closes it.
  await toggle(page, "Mejl från Simon Says").focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page, "Mejl från Simon Says")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("switch", { name: /^Inbjudningar/ })).toBeHidden();

  // A link to #ai opens that section on a fresh load.
  await page.goto("/orgs");
  await page.goto("/installningar#ai");
  const ai = section(page, "Koppla till din AI");
  await expect(toggle(page, "Koppla till din AI")).toHaveAttribute("aria-expanded", "true");
  await expect(ai.getByText("Inget kopplat än.")).toBeVisible();

  // Claude is chosen first: its steps (under its row on a phone, beside the tiles on a desktop),
  // "Öppna Claude" in a new tab, the official guide, and the address to copy.
  const tile = (name: string) => ai.getByRole("button", { name, exact: true });
  await expect(tile("Claude")).toHaveAttribute("aria-expanded", "true");
  await expect(ai.getByRole("link", { name: /Officiell guide från Claude/ })).toHaveAttribute("href", "https://support.claude.com/en/articles/11175166");
  const open = ai.getByRole("link", { name: /Öppna Claude/ });
  await expect(open).toHaveAttribute("href", "https://claude.ai/customize/connectors");
  await expect(open).toHaveAttribute("target", "_blank");
  await ai.getByRole("button", { name: "Kopiera" }).first().click();
  await expect(ai.getByRole("button", { name: /Kopierad/ })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${APP_URL}/api/mcp`);

  // Keyboard: Tab to the next tile, Enter chooses it. Cursor and VS Code get one-click install links.
  await tile("Claude").focus();
  await page.keyboard.press("Tab");
  await expect(tile("ChatGPT")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tile("ChatGPT")).toHaveAttribute("aria-expanded", "true");
  await expect(tile("Claude")).toHaveAttribute("aria-expanded", "false");
  await tile("Cursor").click();
  await expect(ai.getByRole("link", { name: /Lägg till i Cursor/ })).toHaveAttribute("href", /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=simon-says&config=/);
  await tile("VS Code").click();
  await expect(ai.getByRole("link", { name: /Lägg till i VS Code/ })).toHaveAttribute("href", /^vscode:mcp\/install\?/);
  await tile("Claude Code").click();
  await expect(ai.getByText(`claude mcp add --transport http simon-says ${APP_URL}/api/mcp`)).toBeVisible();
  await expectAccessible(page);

  // No double borders with every section open.
  const closed = page.locator('[data-section-trigger][aria-expanded="false"]');
  for (let n = await closed.count(); n > 0; n--) await closed.first().click();
  await expect(closed).toHaveCount(0);
  expect(formatOffenders("/installningar (open)", await auditBorders(page)), "double borders").toEqual([]);
});

test("Konto: a connected assistant is listed with its summary, and Koppla från disconnects it", async ({ signedIn, newEmail, db }) => {
  const email = newEmail("konto-ai");
  const userId = await ensureUser(db, email);
  const clientId = `ssk_${randomBytes(12).toString("base64url")}`;
  expect((await db.from("mcp_clients").insert({ id: clientId, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).error).toBeNull();
  // Named from the redirect URI it was approved for (0068), not from the name the client chose.
  const { data: grant, error } = await db
    .from("mcp_grants")
    .insert({ user_id: userId, client_id: clientId, client_name: "Claude", resource: `${APP_URL}/api/mcp`, redirect_uri: "https://claude.ai/api/mcp/auth_callback" })
    .select("id")
    .single();
  expect(error).toBeNull();

  const { page } = await signedIn(email, "/installningar");
  const ai = section(page, "Koppla till din AI");
  await expect(ai.getByText("1 kopplad")).toBeVisible();
  await toggle(page, "Koppla till din AI").click();
  const row = ai.getByRole("list", { name: "Kopplat nu" }).getByRole("listitem").filter({ hasText: "Claude" });
  await expect(row).toContainText("inte använd än");
  await expect(row).toContainText("Kallar sig ”Claude”");
  // Connected: the tiles wait behind "Koppla en till".
  await expect(ai.getByRole("button", { name: "Cursor", exact: true })).toBeHidden();
  await ai.getByRole("button", { name: "Koppla en till" }).click();
  await expect(ai.getByRole("button", { name: "Cursor", exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Koppla från" }).click();
  const dialog = page.getByRole("dialog", { name: "Koppla från Claude?" });
  await dialog.getByRole("button", { name: "Koppla från" }).click();
  await expect(ai.getByText("Inget kopplat än.")).toBeVisible();
  await expect(ai.getByText("Inte kopplad")).toBeAttached();
  const { data } = await db.from("mcp_grants").select("revoked_at").eq("id", grant!.id).single();
  expect(data?.revoked_at).not.toBeNull();
});
