import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request, type FullConfig } from "@playwright/test";
import { ADMIN_EMAIL, APP_URL, STORAGE_ADMIN } from "./env";

// Before any spec: compile the routes once (next dev compiles on first request, which would
// otherwise eat the first specs' timeouts), and sign in the shared admin once (storage state).

const WARM = [
  "/",
  "/login",
  "/integritet",
  "/orgs",
  "/installningar",
  "/orgs/00000000-0000-4000-8000-000000000000",
  "/orgs/00000000-0000-4000-8000-000000000000/kom-igang",
  "/orgs/00000000-0000-4000-8000-000000000000/forbered",
  "/orgs/00000000-0000-4000-8000-000000000000/protokoll",
  "/meetings/ny/00000000-0000-4000-8000-000000000000",
  "/meetings/00000000-0000-4000-8000-000000000000",
  "/join/e2e-warmup-code",
  // API routes compile on first request too (a GET is enough: 405 or 404, but compiled). The
  // import's estimate took 14 s to compile under the parallel specs, past a 15 s expect.
  "/api/orgs/00000000-0000-4000-8000-000000000000/history/drive",
  "/api/orgs/00000000-0000-4000-8000-000000000000/history/estimate",
  "/api/orgs/00000000-0000-4000-8000-000000000000/history/import",
  "/api/orgs/00000000-0000-4000-8000-000000000000/history/jobs",
  "/api/orgs/00000000-0000-4000-8000-000000000000/goals/propose",
  "/api/orgs/00000000-0000-4000-8000-000000000000/prepare",
  // Routes the specs hit mid-run (seen compiling on demand in CI logs).
  "/auth/callback",
  "/sitemap.xml",
  "/privat",
  "/privat/00000000-0000-4000-8000-000000000000",
  "/privat/mote/00000000-0000-4000-8000-000000000000",
  "/orgs/00000000-0000-4000-8000-000000000000/mote/00000000-0000-4000-8000-000000000000",
  "/api/meetings",
  "/api/meetings/test",
  "/api/meetings/00000000-0000-4000-8000-000000000000",
  "/api/meetings/00000000-0000-4000-8000-000000000000/speakers",
  "/api/meetings/00000000-0000-4000-8000-000000000000/token",
  "/api/meetings/00000000-0000-4000-8000-000000000000/end",
  "/api/meetings/00000000-0000-4000-8000-000000000000/heartbeat",
  "/api/meetings/00000000-0000-4000-8000-000000000000/segments",
  "/api/meetings/00000000-0000-4000-8000-000000000000/tasks",
  "/api/meetings/00000000-0000-4000-8000-000000000000/pause",
  "/api/meetings/00000000-0000-4000-8000-000000000000/resume",
  "/api/meetings/00000000-0000-4000-8000-000000000000/doc-access",
  "/api/orgs/00000000-0000-4000-8000-000000000000/agenda-candidates",
  "/api/orgs/00000000-0000-4000-8000-000000000000/meeting-folder",
  "/api/mina-uppgifter/klart",
  "/api/cron/finalize",
  "/api/cron/alarm",
  "/api/cron/import",
];

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const ctx = await request.newContext({ baseURL: APP_URL });
  if (process.env.E2E_PROD) {
    // A production build (the opt-in capture spec): the test sign-in route is off there by
    // design (lib/e2e/guard.ts), so the capture signs in on its own; nothing to compile.
    mkdirSync(dirname(STORAGE_ADMIN), { recursive: true });
    await ctx.storageState({ path: STORAGE_ADMIN });
    await ctx.dispose();
    return;
  }
  const started = Date.now();
  // Signed in, so the app pages compile their real code paths (not just the login redirect).
  const login = await ctx.get(`/api/e2e/login?email=${encodeURIComponent(ADMIN_EMAIL)}&next=/orgs`, { maxRedirects: 0 });
  if (login.status() !== 307 && login.status() !== 302) throw new Error(`e2e: admin sign-in failed: ${login.status()} ${await login.text()}`);
  await Promise.all(WARM.map((path) => ctx.get(path, { timeout: 180_000, failOnStatusCode: false }).catch(() => null)));
  console.log(`e2e: routes warm in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  mkdirSync(dirname(STORAGE_ADMIN), { recursive: true });
  await ctx.storageState({ path: STORAGE_ADMIN });
  await ctx.dispose();
}
