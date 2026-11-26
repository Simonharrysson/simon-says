import { expect, expectAccessible, test } from "../fixtures";

// The start screen at the table (/meetings/ny/<orgId>): one line for the meeting it will be, one
// consent tick, Starta mötet. The tick also starts the mic check; the level, how it works and the
// format are folded away (Inställningar för mötet, Byt).

test("start screen: one line, one tick, Start; the rest folded @phone", async ({ page, seedOrg }) => {
  const org = await seedOrg();
  await page.goto(`/meetings/ny/${org.id}`);
  await expect(page.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();

  // Nothing to choose first: a new Doc in the förening's format. Start waits only for the tick.
  await expect(page.locator("p").filter({ hasText: /^Nytt dokument i / })).toBeVisible();
  await expect(page.getByText("Paus stoppar ljudet direkt.")).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Format" })).toHaveCount(0);
  const start = page.getByRole("button", { name: "Starta mötet" });
  // One screen: Start is in view without scrolling (phone width too).
  await expect(start).toBeInViewport();
  await expect(start).toBeDisabled();

  // Retried until it sticks: a click before hydration does nothing.
  const consent = page.getByRole("checkbox", { name: "Alla i rummet vet att mötet transkriberas och kan be om paus" });
  await expect(async () => {
    await consent.check({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(start).toBeEnabled();

  // Inställningar för mötet: the mic check the tick started, and how it works.
  await page.locator("summary", { hasText: "Inställningar för mötet" }).click();
  await expect(page.getByRole("meter", { name: "Ljudnivå" })).toBeVisible();
  await expect(page.getByText("Paus stoppar ljudet direkt.")).toBeHidden();
  await page.locator("summary", { hasText: "Så fungerar det" }).click();
  await expect(page.getByText("Paus stoppar ljudet direkt.")).toBeVisible();

  // Byt: the other choices, the format among them.
  const change = page.getByRole("button", { name: "Byt dokument eller format" });
  await expect(change).toHaveAttribute("aria-expanded", "false");
  await change.click();
  await expect(change).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("combobox", { name: "Format" })).toBeVisible();
  await expectAccessible(page);
});
