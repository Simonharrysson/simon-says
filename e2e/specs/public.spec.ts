import { expect, expectAccessible, test } from "../fixtures";

// The public pages: they render, have no serious accessibility problems, and fit a phone.

test.use({ storageState: { cookies: [], origins: [] } });

for (const [path, heading] of [
  ["/", "Anteckningarna skriver sig själva."],
  ["/login", "Logga in"],
  ["/integritet", null],
] as const) {
  test(`${path} renders and passes axe @phone`, async ({ page }) => {
    await page.goto(path);
    if (heading) await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    else await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectAccessible(page);
    // Nothing wider than the screen (no sideways scrolling at 390 px).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
  });
}

// The landing at phone (390) and desktop (1440) width: föreningar first, Privat second, how it
// works, the trust points, and one call to action (top and bottom).
for (const width of [390, 1440]) {
  test(`the landing shows both audiences and one call to action at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: "Före, under och efter mötet" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Spela in föreläsningen. Få sammanfattningen på mejlen." })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Så funkar det" })).toBeVisible();
    await expect(page.getByRole("term").filter({ hasText: "Inget ljud sparas" })).toBeVisible();
    await expect(page.getByRole("link", { name: "integritetsinformationen" })).toHaveAttribute("href", "/integritet");
    await expect(page.getByRole("button", { name: "Kom igång med Google" })).toHaveCount(2);
    await expectAccessible(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
  });
}

test("the login no longer says only the starter needs an account", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("Alla i rummet kan vara med utan konto.")).toBeVisible();
  await expect(page.getByText("Bara den som startar mötet")).toHaveCount(0);
});

test("public pages have a description, a canonical URL and share cards", async ({ page, baseURL }) => {
  await page.goto("/");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /Google-dokument/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`^${baseURL}/?$`));
  await expect(page.locator('meta[property="og:image"]').first()).toHaveAttribute("content", /opengraph-image/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  const jsonLd = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}");
  expect(jsonLd["@type"]).toBe("SoftwareApplication");
  await expect(page.locator("html")).toHaveAttribute("lang", "sv");

  await page.goto("/integritet");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${baseURL}/integritet`);
});

test("robots.txt keeps crawlers out of the app and the sitemap lists the public pages", async ({ request, baseURL }) => {
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /orgs");
  expect(robots).toContain("Disallow: /api/");
  expect(robots).not.toMatch(/Disallow: \/integritet/);
  // Invite links stay crawlable so their noindex header is seen.
  expect(robots).not.toMatch(/Disallow: \/join/);
  expect((await request.get("/join/e2e-no-such-code", { maxRedirects: 0 })).headers()["x-robots-tag"]).toBe("noindex, nofollow");
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const path of ["/", "/login", "/integritet", "/status"]) expect(sitemap).toContain(`<loc>${baseURL}${path}</loc>`);
  expect(sitemap).not.toContain("/orgs");
  const og = await request.get("/opengraph-image");
  expect(og.ok()).toBe(true);
  expect(og.headers()["content-type"]).toContain("image/png");
});
