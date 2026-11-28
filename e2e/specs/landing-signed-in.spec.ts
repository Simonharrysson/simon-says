import { expect, test } from "../fixtures";

// Signed in (the shared admin): the landing's one action becomes "Till appen" (→ /hem) in the
// header, the hero, the price card and the closing panel; nothing asks to sign in.
test("a signed-in visitor gets Till appen instead of the sign-in @phone", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Mötet är slut. Anteckningarna är klara." })).toBeVisible();
  const toApp = page.getByRole("link", { name: "Till appen" });
  await expect(toApp.first()).toHaveAttribute("href", "/hem");
  expect(await toApp.count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("button", { name: "Kom igång gratis" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Logga in", exact: true })).toHaveCount(0);
  await expect(page.getByText("Inloggad som admin@e2e.test.")).toBeVisible();
});
