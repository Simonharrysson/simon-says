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
  "/api/e2e/login?email=warmup%40e2e.test&next=/orgs",
  "/orgs/00000000-0000-4000-8000-000000000000",
  "/orgs/00000000-0000-4000-8000-000000000000/kom-igang",
  "/orgs/00000000-0000-4000-8000-000000000000/forbered",
  "/orgs/00000000-0000-4000-8000-000000000000/protokoll",
  "/meetings/ny/00000000-0000-4000-8000-000000000000",
  "/meetings/00000000-0000-4000-8000-000000000000",
  "/join/e2e-warmup-code",
];

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const ctx = await request.newContext({ baseURL: APP_URL });
  const started = Date.now();
  // Signed in, so the app pages compile their real code paths (not just the login redirect).
  await ctx.get(`/api/e2e/login?email=${encodeURIComponent(ADMIN_EMAIL)}&next=/orgs`, { maxRedirects: 0 });
  await Promise.all(WARM.map((path) => ctx.get(path, { timeout: 180_000, failOnStatusCode: false }).catch(() => null)));
  console.log(`e2e: routes warm in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  mkdirSync(dirname(STORAGE_ADMIN), { recursive: true });
  await ctx.storageState({ path: STORAGE_ADMIN });
  await ctx.dispose();
}
