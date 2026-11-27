import type { Page } from "@playwright/test";
import { ensureUser, expect, test } from "../fixtures";

// Motion (docs/ui.md "Motion", components/motion): a tab switch slides the underline and the new
// panel's cards rise in (WAAPI, id "enter"); a link between pages runs a view transition typed
// "nav" (app/(app)/layout.tsx); a task done on /hem closes out of the list. The suite runs with
// reduced motion, so these specs turn it off and check that the motion really runs, by sampling
// it frame by frame, not only that the content swaps.

type Recorded = { enters: number; vts: string[][]; vtDone: number; vtSkipped: number };

const must = <T,>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

/**
 * Samples every frame, in the page, for up to `ms`: the förening tabs' underline ([left, width])
 * or a Mina uppgifter row ([height, opacity]; stops once the row is gone).
 */
async function sample(page: Page, kind: "indicator" | "row", arg: string, ms: number): Promise<number[][]> {
  return page.evaluate(
    ({ kind, arg, ms }) =>
      new Promise<number[][]>((resolve) => {
        const out: number[][] = [];
        const start = performance.now();
        const read = (): number[] | null => {
          if (kind === "indicator") {
            const el = document.querySelector(`nav[aria-label="${arg}"] [data-slider-mark="active"]`);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return [r.left, r.width];
          }
          const row = [...document.querySelectorAll('ul[aria-label="Mina uppgifter"] > li')].find((li) => li.textContent?.includes(arg));
          if (!row) return null;
          return [row.getBoundingClientRect().height, Number(getComputedStyle(row).opacity)];
        };
        const step = () => {
          const v = read();
          if (v) out.push(v);
          if (performance.now() - start > ms || (kind === "row" && !v && out.length > 0)) resolve(out);
          else requestAnimationFrame(step);
        };
        step();
      }),
    { kind, arg, ms },
  );
}

// TEMPORARY (recordings for the PR): video on. Removed before the PR leaves draft.
test.use({ video: { mode: "on", size: { width: 1280, height: 800 } } });

test.describe("transitions", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" }, viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const rec: Recorded = { enters: 0, vts: [], vtDone: 0, vtSkipped: 0 };
      (window as unknown as { __motion: Recorded }).__motion = rec;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
        if (typeof options === "object" && options?.id === "enter") rec.enters++;
        return animate.call(this, keyframes, options);
      };
      const start = document.startViewTransition?.bind(document);
      if (start) {
        document.startViewTransition = ((arg: Parameters<typeof start>[0]) => {
          rec.vts.push(typeof arg === "object" && arg && "types" in arg ? [...(arg.types ?? [])] : []);
          const vt = start(arg);
          // A skipped transition (e.g. a view-transition-name used twice) rejects `ready`.
          vt.ready.then(
            () => rec.vtDone++,
            () => rec.vtSkipped++,
          );
          return vt;
        }) as typeof document.startViewTransition;
      }
    });
  });

  const motion = (page: Page) => page.evaluate(() => (window as unknown as { __motion: Recorded }).__motion);
  const noReducedMotion = async (page: Page) => expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);

  test("a tab switch slides the underline and the panel rises in; a page load doesn't", async ({ page, seedOrg }) => {
    const org = await seedOrg();
    await page.goto(org.url);
    await noReducedMotion(page);
    const tabs = page.getByRole("navigation", { name: "Föreningens vyer" });
    await expect(tabs.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "page");
    // Measured and in charge of the look; the page load itself animated nothing.
    await expect(tabs).toHaveAttribute("data-slider", "true");
    expect((await motion(page)).enters).toBe(0);

    const from = (await tabs.getByRole("link", { name: "Möten" }).boundingBox())!.x;
    const to = (await tabs.getByRole("link", { name: "Inställningar" }).boundingBox())!.x;
    const frames = sample(page, "indicator", "Föreningens vyer", 1200);
    await tabs.getByRole("link", { name: "Inställningar" }).click();
    const xs = (await frames).map(([x]) => x);
    const seen = xs.map(Math.round).join(",");
    // It starts under Möten, ends under Inställningar, and passes through the tab between.
    expect(Math.abs(xs[0] - from), seen).toBeLessThan(2);
    expect(Math.abs(xs.at(-1)! - to), seen).toBeLessThan(2);
    expect(xs.some((x) => x > from + 4 && x < to - 4), seen).toBe(true);

    await expect(page.getByRole("heading", { name: "Namn, logga och om oss", exact: true })).toBeVisible();
    await expect.poll(async () => (await motion(page)).enters).toBeGreaterThan(0);

    // Back to a kept tab: its cards rise in again (no new server content needed).
    const before = (await motion(page)).enters;
    await tabs.getByRole("link", { name: "Möten" }).click();
    await expect(tabs.getByRole("link", { name: "Möten" })).toHaveAttribute("aria-current", "page");
    await expect.poll(async () => (await motion(page)).enters).toBeGreaterThan(before);
  });

  test("a link between pages runs a view transition", async ({ page }) => {
    await page.goto("/hem");
    await noReducedMotion(page);
    const rail = page.getByRole("navigation", { name: "Huvudmeny" });
    await expect(rail.locator("[data-slider]")).toHaveCount(1);
    const from = (await rail.getByRole("link", { name: "Hem", exact: true }).boundingBox())!.x;
    const to = (await rail.getByRole("link", { name: "Föreningar", exact: true }).boundingBox())!.x;
    const frames = sample(page, "indicator", "Huvudmeny", 1200);
    await rail.getByRole("link", { name: "Föreningar", exact: true }).click();
    // The rail's pill slides from Hem over Privat to Föreningar.
    const xs = (await frames).map(([x]) => x);
    const seen = xs.map(Math.round).join(",");
    expect(Math.abs(xs[0] - from), seen).toBeLessThan(2);
    expect(Math.abs(xs.at(-1)! - to), seen).toBeLessThan(2);
    expect(xs.some((x) => x > from + 4 && x < to - 4), seen).toBe(true);
    await expect(page).toHaveURL(/\/orgs$/);
    await expect.poll(async () => (await motion(page)).vts.some((types) => types.includes("nav"))).toBe(true);
    // It really ran (not skipped), heading morph included.
    await expect.poll(async () => (await motion(page)).vtDone).toBeGreaterThan(0);
    expect((await motion(page)).vtSkipped).toBe(0);
    await expect(rail.getByRole("link", { name: "Föreningar", exact: true })).toHaveAttribute("aria-current", "page");
    // Let Föreningar finish arriving (streamed content, the running view transition) first: a
    // click during it can be committed together with that work rather than as its own transition.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => !document.getAnimations().some((a) => String((a.effect as KeyframeEffect | null)?.pseudoElement ?? "").startsWith("::view-transition")));
    await rail.getByRole("link", { name: "Hem", exact: true }).click();
    await expect(page).toHaveURL(/\/hem$/);
    await expect.poll(async () => (await motion(page)).vts.filter((types) => types.includes("nav")).length).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await motion(page)).vtDone).toBeGreaterThanOrEqual(2);
    expect((await motion(page)).vtSkipped).toBe(0);
  });
});

test("Mina uppgifter: a done task closes out of the list and the rows below follow", async ({ db, signedIn, newEmail }) => {
  test.setTimeout(120_000);
  // Privat tasks: no Doc line to tick, so once saved they need nothing more and close out.
  const email = newEmail("motion");
  const me = await ensureUser(db, email);
  const space = must("privat", await db.from("orgs").insert({ name: "Privat", kind: "privat", created_by: me, share_transcript: false, summary_mode: "off" }).select("id").single()) as { id: string };
  const ctx = must("context", await db.from("contexts").insert({ org_id: space.id, name: "TDDE15" }).select("id").single()) as { id: string };
  const rec = must(
    "meeting",
    await db.from("meetings").insert({ org_id: space.id, started_by: me, status: "done", context_id: ctx.id, ended_at: new Date().toISOString() }).select("id").single(),
  ) as { id: string };
  must("tasks", await db.from("context_tasks").insert(["Läsa kap 4", "Skriva labbrapporten", "Boka handledning"].map((text) => ({ context_id: ctx.id, meeting_id: rec.id, text }))));

  // signedIn's own context has no reduced motion: the animations run.
  const { page } = await signedIn(email, "/hem");
  const list = page.getByRole("list", { name: "Mina uppgifter" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  const full = (await list.getByRole("listitem").filter({ hasText: "Läsa kap 4" }).boundingBox())!.height;

  const frames = sample(page, "row", "Läsa kap 4", 20_000);
  await page.getByRole("checkbox", { name: "Läsa kap 4" }).check();
  await expect(page.getByText("Markerad som klar.")).toBeVisible();
  // Saved after the 5 s undo, "Klar" for a moment, then it closes: height and opacity run down
  // through values in between (an animation, not a removal), and the row is gone.
  const rows = await frames;
  const closing = rows.filter(([h]) => h > 2 && h < full - 2);
  expect(closing.length, `heights: ${rows.map(([h]) => Math.round(h)).join(",")}`).toBeGreaterThan(1);
  expect(closing.some(([, o]) => o > 0.05 && o < 0.95)).toBe(true);
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).not.toContainText("Läsa kap 4");
  await expect(page.getByText("2 öppna uppgifter")).toBeVisible();

  // "Visa klara" has it, among the done ones.
  await page.getByRole("switch", { name: "Visa klara" }).click();
  await expect(list).toContainText("Läsa kap 4");
});

test("reduced motion: a tab switch changes at once", async ({ page, seedOrg }) => {
  const org = await seedOrg();
  await page.goto(org.url);
  const tabs = page.getByRole("navigation", { name: "Föreningens vyer" });
  await expect(tabs).toHaveAttribute("data-slider", "true");
  await tabs.getByRole("link", { name: "Översikt" }).click();
  await expect(tabs.getByRole("link", { name: "Översikt" })).toHaveAttribute("aria-current", "page");
  // No entrance ran, and the underline moves without a transition.
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.id === "enter").length)).toBe(0);
  const durations = await tabs.locator('[data-slider-mark="active"]').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(durations.split(",").every((d) => parseFloat(d) < 0.01), durations).toBe(true);
});
