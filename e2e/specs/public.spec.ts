import { auditBorders, formatOffenders } from "../border-audit";
import { expect, expectAccessible, test } from "../fixtures";

// The public pages: they render, have no serious accessibility problems, and fit a phone.

test.use({ storageState: { cookies: [], origins: [] } });

for (const [path, heading] of [
  ["/", "Mötet är slut. Anteckningarna är klara."],
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

// The landing at phone (390) and desktop (1440) width: every section is there, the call to action
// is "Kom igång gratis" (header, hero, price, close), the FAQ opens, and the hero's example ends on
// the sent summary (e2e runs with reduced motion: the finished meeting, still). No double borders,
// axe clean (also with the header blurred over scrolled text), and nothing wider than the screen.
for (const width of [390, 1440]) {
  test(`the landing shows every section and one call to action at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/");
    for (const name of [
      "Före, under och efter mötet",
      "I rummet eller i Google Meet",
      "Rätt person ser rätt möte",
      "Styrelsen slipper skriva protokoll",
      "Och för allt annat du vill minnas",
      "Din AI vet vad ni bestämt",
      "Ditt möte, dina ord",
      "Gratis medan vi är i beta",
      "Vanliga frågor",
      "Låt nästa möte skriva sig självt",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    // No testimonials until there are real ones.
    await expect(page.locator("#omdomen")).toHaveCount(0);
    await expect(page.getByText("Sammanfattning skickad", { exact: true })).toBeVisible();
    await expect(page.getByRole("term").filter({ hasText: "Inget ljud sparas" })).toBeVisible();
    await expect(page.getByRole("link", { name: "integritetsinformationen" }).first()).toHaveAttribute("href", "/integritet");
    await expect(page.getByRole("link", { name: "Mejla Simon" })).toHaveAttribute("href", /^mailto:simon@harrysson\.co\?subject=/);
    // Header (when it fits), hero, price card and the closing panel.
    await expect(page.getByRole("button", { name: "Kom igång gratis" })).toHaveCount(4);

    await page.getByRole("button", { name: "Vilka språk fungerar?" }).click();
    await expect(page.getByText("Svenska och engelska, även när ni byter språk mitt i en mening.")).toBeVisible();

    await expectAccessible(page);
    const offenders = formatOffenders("/", await auditBorders(page));
    expect(offenders, "double borders (box in a box, or lines that touch)").toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);

    // Scrolled: the header blurs what passes under it and stays readable.
    await page.mouse.wheel(0, 1600);
    await expect(page.locator("header[data-scrolled=true]")).toBeVisible();
    await expectAccessible(page);
  });
}

test("the landing's menu opens as a sheet on a phone and its links go to the sections", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Meny" }).click();
  const sheet = page.getByRole("dialog", { name: "Meny" });
  await expect(sheet).toBeVisible();
  await expectAccessible(page);
  await sheet.getByRole("link", { name: "Pris" }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/#pris$/);
  await expect(page.getByRole("heading", { level: 2, name: "Gratis medan vi är i beta" })).toBeInViewport();
});

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
  const jsonLd = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((s) => JSON.parse(s)["@type"]);
  expect(jsonLd).toEqual(["SoftwareApplication", "FAQPage"]);
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
