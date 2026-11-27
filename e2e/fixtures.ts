import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL, APP_URL, FAKE_URL } from "./env";
export { STORAGE_ADMIN } from "./env";

// Shared fixtures for the e2e specs (docs/testing.md "E2E").
//
// - Every context blocks the real internet: a request to a non-loopback host is aborted and fails
//   the test (the app must only talk to the fakes), except Google's Picker script, answered by a
//   stub (e2e/fakes/picker.js) that "picks" what the spec queued with `queuePick`.
// - "Logga in med Google" really runs (server action → Supabase authorize URL); the authorize
//   request is answered with a redirect to the test sign-in (/api/e2e/login) as `nextLogin.email`,
//   or with Google's "cancelled" back to /auth/callback when `nextLogin.cancel` is set.
// - `seedOrg` makes a fresh förening per test with the service role (no org limit, namespaced by
//   a random suffix), so parallel specs never share state.

const PICKER_STUB = readFileSync(fileURLToPath(new URL("./fakes/picker.js", import.meta.url)), "utf8");
const PICKER_SRC = "https://apis.google.com/js/api.js";

const isLoopback = (u: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.protocol === "data:" || u.protocol === "blob:";

export interface NextLogin {
  email?: string;
  /** Answer the authorize step like a user who cancelled at Google. */
  cancel?: boolean;
}

/** Wire a context: the network guard, the Picker stub, the sign-in redirect. */
export async function guardContext(context: BrowserContext, blocked: string[], nextLogin: NextLogin): Promise<void> {
  await context.addInitScript(() => {
    (window as unknown as { __e2ePicks: unknown[] }).__e2ePicks ??= [];
  });
  await context.route(
    (url) => !isLoopback(url),
    async (route) => {
      const url = route.request().url();
      if (url === PICKER_SRC) return route.fulfill({ status: 200, contentType: "text/javascript", body: PICKER_STUB });
      blocked.push(url);
      return route.abort("blockedbyclient");
    },
  );
  // Where the browser goes instead of Supabase's Google authorize URL.
  const instead = (authorizeUrl: string): string => {
    const url = new URL(authorizeUrl);
    const redirectTo = new URL(url.searchParams.get("redirect_to") ?? `${APP_URL}/auth/callback`);
    const next = redirectTo.searchParams.get("next") ?? "/";
    if (redirectTo.searchParams.get("atkomst") === "drive") {
      // The protocol import's drive.readonly consent, as the signed-in admin (login_hint).
      const email = url.searchParams.get("login_hint") ?? nextLogin.email ?? "";
      return `${APP_URL}/api/e2e/login?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}&drive=1`;
    }
    if (redirectTo.searchParams.get("atkomst") === "kalender") {
      // "Koppla kalender": the calendar.readonly consent, as the signed-in user (login_hint).
      const email = url.searchParams.get("login_hint") ?? nextLogin.email ?? "";
      return `${APP_URL}/api/e2e/login?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}&kalender=1`;
    }
    if (nextLogin.cancel) {
      redirectTo.searchParams.set("error", "access_denied");
      return redirectTo.toString();
    }
    if (!nextLogin.email) throw new Error("e2e: set nextLogin.email before pressing Logga in med Google");
    return `${APP_URL}/api/e2e/login?email=${encodeURIComponent(nextLogin.email)}&next=${encodeURIComponent(next)}`;
  };
  const isAuthorize = (u: string) => /\/auth\/v1\/authorize\?/.test(u);
  await context.route("**/auth/v1/authorize**", (route) => route.fulfill({ status: 302, headers: { location: instead(route.request().url()) } }));
  // A sign-in form submitted before hydration posts natively and gets a 303 straight to Supabase;
  // Playwright never routes a redirect's target, so rewrite that 303 here.
  await context.route(
    (url) => url.origin === APP_URL,
    async (route) => {
      const req = route.request();
      if (req.method() !== "POST" || !req.isNavigationRequest()) return route.fallback();
      const res = await route.fetch({ maxRedirects: 0 });
      const location = res.headers()["location"];
      if (res.status() >= 300 && res.status() < 400 && location && isAuthorize(location)) {
        return route.fulfill({ status: 303, headers: { location: instead(location) } });
      }
      return route.fulfill({ response: res });
    },
  );
}

export function adminDb(): SupabaseClient {
  return createClient(process.env.LOCAL_SUPABASE_API_URL!, process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The user's id, creating a confirmed user without a password if needed (the test sign-in sets one). */
export async function ensureUser(db: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (data.user) return data.user.id;
  for (let page = 1; page < 50; page++) {
    const list = await db.auth.admin.listUsers({ page, perPage: 1000 });
    const hit = list.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (list.data.users.length < 1000) break;
  }
  throw new Error(`ensureUser ${email}: ${error?.message}`);
}

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

export interface SeededOrg {
  id: string;
  name: string;
  inviteCode: string;
  url: string;
}

/**
 * A finished (or live) meeting written as the server would leave it, with its Doc in the fake and
 * the given note rows (e.g. an open task for "Från förra veckan").
 */
export async function seedMeeting(
  db: SupabaseClient,
  org: SeededOrg,
  opts: { startedBy?: string; status?: "live" | "ending" | "done" | "abandoned"; daysAgo?: number; items?: { section: "decision" | "action"; text: string; owner?: string }[] } = {},
): Promise<{ id: string; docId: string }> {
  const startedBy = await ensureUser(db, opts.startedBy ?? ADMIN_EMAIL);
  const started = new Date(Date.now() - (opts.daysAgo ?? 7) * 86_400_000);
  const doc = await fake.createDoc({ name: `${started.toISOString().slice(0, 10)} Mötesprotokoll – ${org.name}`, owner: opts.startedBy ?? ADMIN_EMAIL });
  const status = opts.status ?? "done";
  const meeting = must(
    "seed meeting",
    await db
      .from("meetings")
      .insert({
        org_id: org.id,
        started_by: startedBy,
        doc_id: doc.id,
        notes_tab_id: "t.0",
        status,
        started_at: started.toISOString(),
        consent_confirmed_at: started.toISOString(),
        ...(status === "done" || status === "abandoned" ? { ended_at: new Date(started.getTime() + 3_600_000).toISOString() } : {}),
        ...(status === "live" ? { last_heartbeat_at: new Date().toISOString() } : {}),
      })
      .select("id")
      .single(),
  ) as { id: string };
  if (opts.items?.length) {
    must(
      "seed items",
      await db.from("note_items").insert(opts.items.map((it, i) => ({ meeting_id: meeting.id, id: `n${i + 1}`, section: it.section, text: it.text, owner: it.owner ?? null, position: i }))),
    );
  }
  return { id: meeting.id, docId: doc.id };
}

/** The fake services' control API. */
export const fake = {
  async createDoc(input: { name: string; paragraphs?: { text: string; style?: string }[]; parents?: string[]; owner?: string; mimeType?: string; modifiedTime?: string; createdTime?: string; content?: string }) {
    const res = await fetch(`${FAKE_URL}/__e2e/google/files`, { method: "POST", body: JSON.stringify(input) });
    if (!res.ok) throw new Error(`fake createDoc: ${res.status}`);
    return (await res.json()) as { id: string; name: string; mimeType: string };
  },
  async doc(id: string) {
    const res = await fetch(`${FAKE_URL}/__e2e/google/docs/${id}`);
    if (!res.ok) return null;
    return (await res.json()) as { id: string; name: string; parents: string[]; owner: string; trashed: boolean; permissions: string[]; tabs: { tabId: string; title: string; text: string }[] };
  },
  /** The Doc's text, all tabs joined. */
  async docText(id: string): Promise<string> {
    const d = await fake.doc(id);
    return d ? d.tabs.map((t) => t.text).join("\n") : "";
  },
  async files(nameContains: string) {
    const res = await fetch(`${FAKE_URL}/__e2e/google/files?nameContains=${encodeURIComponent(nameContains)}`);
    return (await res.json()) as { id: string; name: string; mimeType: string; parents: string[]; owner: string; trashed: boolean }[];
  },
  async claudeCalls(kind?: string, contains?: string) {
    const q = new URLSearchParams({ ...(kind ? { kind } : {}), ...(contains ? { contains } : {}) });
    return (await (await fetch(`${FAKE_URL}/__e2e/claude/calls?${q}`)).json()) as { kind: string; text: string }[];
  },
  /** Mail sent through the fake provider, optionally to one address. */
  async mail(to?: string) {
    const q = to ? `?to=${encodeURIComponent(to)}` : "";
    return (await (await fetch(`${FAKE_URL}/__e2e/mail${q}`)).json()) as { to: string[]; subject: string; text: string; html?: string; reply_to?: string; headers?: Record<string, string> }[];
  },
  /** Give `email` a Google calendar (and events) in the fake Calendar API. */
  async calendar(email: string, calendar: { id: string; summary: string; primary?: boolean }, events: { id: string; summary: string; start: string; end: string; organizer?: { email: string }; attendees?: { email?: string; displayName?: string; responseStatus?: string }[] }[] = []) {
    const res = await fetch(`${FAKE_URL}/__e2e/google/calendar`, { method: "POST", body: JSON.stringify({ email, calendar, events }) });
    if (!res.ok) throw new Error(`fake calendar: ${res.status}`);
  },
  async problems() {
    return (await (await fetch(`${FAKE_URL}/__e2e/problems`)).json()) as { at: string; what: string }[];
  },
};

/** Queue what the stub Picker returns on its next open (one entry per open). */
export async function queuePick(page: Page, files: { id: string; name: string; mimeType: string; parentId?: string }[] | null): Promise<void> {
  await page.evaluate((f) => (window as unknown as { __e2ePicks: unknown[] }).__e2ePicks.push(f), files);
}

/** Fail on serious or critical axe violations (WCAG 2.x A/AA rules). */
export async function expectAccessible(page: Page, opts: { exclude?: string[] } = {}): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  // The dev server's own overlay is not the app.
  builder = builder.exclude("nextjs-portal");
  for (const sel of opts.exclude ?? []) builder = builder.exclude(sel);
  const { violations } = await builder.analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    bad.map((v) => `${v.impact} ${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`),
    `axe on ${page.url()}`,
  ).toEqual([]);
}

/**
 * The tree editor as the list (0055: a desktop gets the canvas by default; "Lista" is remembered
 * per browser). For specs that drive the list's forms; the canvas has its own spec.
 */
export async function treeAsList(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("tree-view", "list"));
  if (page.url().startsWith("http")) await page.evaluate(() => window.localStorage.setItem("tree-view", "list"));
}

export interface Fixtures {
  /** Non-loopback requests this test's pages tried (aborted); must stay empty. */
  blocked: string[];
  nextLogin: NextLogin;
  db: SupabaseClient;
  /** A fresh förening with the given admin (default: the shared signed-in admin) and members. */
  seedOrg: (opts?: { name?: string; admin?: string; members?: string[]; people?: (string | { name: string; email?: string })[] }) => Promise<SeededOrg>;
  /** A unique test address. */
  newEmail: (label: string) => string;
  /** A second browser (own cookies) signed in as `email`, guarded like the main one. */
  signedIn: (email: string, next?: string) => Promise<{ context: BrowserContext; page: Page }>;
}

export const test = base.extend<Fixtures>({
  blocked: async ({}, use) => {
    const list: string[] = [];
    await use(list);
    expect(list, "requests to the real internet (must go to the fakes)").toEqual([]);
  },
  nextLogin: async ({}, use) => {
    await use({});
  },
  context: async ({ context, blocked, nextLogin }, use) => {
    await guardContext(context, blocked, nextLogin);
    await use(context);
  },
  db: async ({}, use) => {
    await use(adminDb());
  },
  newEmail: async ({}, use) => {
    await use((label) => `${label}-${randomUUID().slice(0, 8)}@e2e.test`);
  },
  seedOrg: async ({ db }, use) => {
    await use(async (opts = {}) => {
      const name = opts.name ?? `Förening ${randomUUID().slice(0, 6)}`;
      const org = must("seed org", await db.from("orgs").insert({ name, created_by: null }).select("id, invite_code").single()) as { id: string; invite_code: string };
      const adminId = await ensureUser(db, opts.admin ?? ADMIN_EMAIL);
      const rows = [{ org_id: org.id, user_id: adminId, role: "admin" }];
      for (const m of opts.members ?? []) rows.push({ org_id: org.id, user_id: await ensureUser(db, m), role: "member" });
      must("seed members", await db.from("org_members").insert(rows));
      if (opts.people?.length) must("seed people", await db.from("people").insert(opts.people.map((p) => (typeof p === "string" ? { org_id: org.id, name: p } : { org_id: org.id, name: p.name, email: p.email ?? null }))));
      return { id: org.id, name, inviteCode: org.invite_code, url: `/orgs/${org.id}` };
    });
  },
  signedIn: async ({ browser, blocked }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (email, next = "/orgs") => {
      const { context, page } = await signedInContext(browser, blocked, email, next);
      opened.push(context);
      return { context, page };
    });
    for (const c of opened) await c.close();
  },
});

export async function signedInContext(browser: Browser, blocked: string[], email: string, next = "/orgs") {
  const context = await browser.newContext({
    baseURL: APP_URL,
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    permissions: ["microphone"],
    storageState: { cookies: [], origins: [] },
  });
  await guardContext(context, blocked, { email });
  const page = await context.newPage();
  await page.goto(`/api/e2e/login?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
  return { context, page };
}

export { expect };
