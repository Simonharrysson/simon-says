import { mkdirSync, writeFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { APP_URL, e2eEnv } from "../env";
import { adminDb, ensureUser, expect, seedMeeting, test } from "../fixtures";

// Opt-in capture (E2E_CAPTURE=1), not a check: screenshots of the main surfaces at 390 and
// 1440 px plus LCP / CLS and tab/nav switch timings, written to test-results/capture/ for the
// polish notes (.superpowers/polish/). Run against a production build (E2E_PROD=1) so
// prefetching and the client cache behave as in production.

const OUT = "test-results/capture";
const WIDTHS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
];

test.skip(!process.env.E2E_CAPTURE, "capture only (E2E_CAPTURE=1)");

/** LCP and CLS observers, installed before any page script. */
const VITALS = () => {
  const w = window as unknown as { __vitals: { lcp: number; cls: number } };
  w.__vitals = { lcp: 0, cls: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__vitals.lcp = Math.max(w.__vitals.lcp, e.startTime);
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__vitals.cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
};

/**
 * Signed in without the test route (off in a production build, lib/e2e/guard.ts): a magic link
 * verified here, its session written into the browser the way @supabase/ssr stores it.
 */
async function signedInProd(browser: Browser, email: string, next: string) {
  const env = e2eEnv();
  const admin = adminDb();
  await ensureUser(admin, email);
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const jar: { name: string; value: string }[] = [];
  const sb = createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (set) => {
        for (const c of set) {
          const i = jar.findIndex((x) => x.name === c.name);
          if (i >= 0) jar.splice(i, 1);
          if (c.value) jar.push({ name: c.name, value: c.value });
        }
      },
    },
  });
  const { error } = await sb.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties!.hashed_token });
  if (error) throw new Error(`capture sign-in: ${error.message}`);
  const context = await browser.newContext({ baseURL: APP_URL, locale: "sv-SE", timezoneId: "Europe/Stockholm", storageState: { cookies: [], origins: [] } });
  const host = new URL(APP_URL).hostname;
  await context.addCookies(jar.map((c) => ({ ...c, domain: host, path: "/", httpOnly: true, secure: false, sameSite: "Lax" as const })));
  const page = await context.newPage();
  await page.goto(next);
  return { context, page };
}

const vitals = (page: Page) => page.evaluate(() => (window as unknown as { __vitals: { lcp: number; cls: number } }).__vitals);
const resetCls = (page: Page) => page.evaluate(() => ((window as unknown as { __vitals: { cls: number } }).__vitals.cls = 0));

test("capture: surfaces, vitals, switch timings", async ({ browser, db, seedOrg, signedIn, newEmail }) => {
  test.setTimeout(600_000);
  const email = newEmail("polish");
  const me = await ensureUser(db, email);
  const org = await seedOrg({ name: "Paddelklubben", admin: email, people: ["Anna Berg", "Erik Lund"] });
  await db.from("people").insert({ org_id: org.id, name: "Testa Testsson", role: "Kassör", member_user_id: me });
  for (let i = 0; i < 6; i++) {
    await seedMeeting(db, org, {
      startedBy: email,
      daysAgo: i * 7 + 1,
      items:
        i < 2
          ? [
              { section: "decision", text: "Vi paddlar i maj" },
              { section: "action", text: i === 0 ? "Boka lokalen" : "Skicka budget", owner: "Kassör" },
            ]
          : [],
    });
  }
  const space = (await db.from("orgs").insert({ name: "Privat", kind: "privat", created_by: me, share_transcript: false, summary_mode: "off" }).select("id").single()).data as { id: string };
  await db.from("org_members").insert({ org_id: space.id, user_id: me, role: "admin" });
  const ctx = (await db.from("contexts").insert({ org_id: space.id, name: "TDDE15" }).select("id").single()).data as { id: string };
  const rec = (await db.from("meetings").insert({ org_id: space.id, started_by: me, status: "done", context_id: ctx.id, ended_at: new Date().toISOString() }).select("id").single()).data as { id: string };
  await db.from("context_tasks").insert({ context_id: ctx.id, meeting_id: rec.id, text: "Läsa kap 4" });

  const { page, context } = process.env.E2E_PROD ? await signedInProd(browser, email, "/hem") : await signedIn(email, "/hem");
  await context.addInitScript(VITALS);
  mkdirSync(OUT, { recursive: true });
  const label = process.env.E2E_CAPTURE ?? "run";
  const report: Record<string, unknown> = { label, prod: Boolean(process.env.E2E_PROD) };

  const surfaces: [string, string][] = [
    ["hem", "/hem"],
    ["orgs", "/orgs"],
    ["org-moten", org.url],
    ["org-oversikt", `${org.url}?flik=oversikt`],
    ["org-installningar", `${org.url}?flik=installningar`],
    ["meeting-new", `/meetings/ny/${org.id}`],
    ["privat", "/privat"],
    ["konto", "/installningar"],
  ];
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    for (const [name, url] of surfaces) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(800);
      report[`${name}@${w.name}`] = await vitals(page);
      await page.screenshot({ path: `${OUT}/${name}-${w.name}.png`, fullPage: true });
    }
  }

  // Switch timings at 1440: förening tabs (first visit and revisit) and the top rail.
  await page.setViewportSize({ width: 1440, height: 900 });
  const tabs = page.getByRole("navigation", { name: "Föreningens vyer" });
  const timeTab = async (name: string, flik: string) => {
    await tabs.getByRole("link", { name }).hover();
    await page.waitForTimeout(300);
    await resetCls(page);
    const t0 = Date.now();
    await tabs.getByRole("link", { name }).click();
    await expect(tabs.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    const marked = Date.now() - t0;
    await expect(page).toHaveURL(flik ? new RegExp(`flik=${flik}`) : new RegExp(`/orgs/${org.id}$`));
    await page.waitForLoadState("networkidle");
    return { markedMs: marked, settledMs: Date.now() - t0, cls: (await vitals(page)).cls };
  };
  await page.goto(org.url);
  await page.waitForLoadState("networkidle");
  report["tab:oversikt(first)"] = await timeTab("Översikt", "oversikt");
  report["tab:installningar(first)"] = await timeTab("Inställningar", "installningar");
  report["tab:moten(revisit)"] = await timeTab("Möten", "");
  report["tab:oversikt(revisit)"] = await timeTab("Översikt", "oversikt");

  const rail = page.getByRole("navigation", { name: "Huvudmeny" });
  const timeNav = async (name: string, heading: string) => {
    await rail.getByRole("link", { name }).hover();
    await page.waitForTimeout(300);
    const t0 = Date.now();
    await rail.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    return { visibleMs: Date.now() - t0 };
  };
  report["nav:hem"] = await timeNav("Hem", "Mina uppgifter");
  report["nav:foreningar"] = await timeNav("Föreningar", "Föreningar");

  writeFileSync(`${OUT}/vitals.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
