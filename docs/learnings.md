# Learnings

Findings from early checks and spikes. Each entry: date, task, what we learned, what it changed.

## 2026-11-24 · Task 1 · Vercel cron and env

- A `*/5 * * * *` cron deploys and fires on the Vercel team's plan (first tick 15:35:30 UTC,
  `GET /api/health` → 200 with the `CRON_SECRET` bearer). Cron calls get through Vercel
  Authentication (`all_except_custom_domains`) without a bypass. Changed: nothing; no plan
  change needed for scheduled jobs.
- Production was first deployed from the CLI (`vercel deploy --prod` on branch `v1`), not from `main`.
- Supabase `simonsays-prod` still issues legacy `anon`/`service_role` JWT keys alongside the new
  `sb_publishable_…`/`sb_secret_…` keys; we use the legacy pair for `SUPABASE_ANON_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY` for now.

## 2026-11-24 · Task 2 · Google sign-in (setup; real-login results pending)

- Supabase's session reports no granted scopes: it carries `provider_token` and
  `provider_refresh_token` only. The callback asks Google instead
  (`POST https://oauth2.googleapis.com/tokeninfo` with the access token → `scope`) and checks
  `drive.file` there. Changed: `fetchGrantedScope` in `lib/google/scopes.ts`.
- Supabase's Google authorize URL always adds `email profile` itself; with our `scopes` it sends
  `email profile openid email profile …/drive.file` (duplicates are harmless), plus
  `access_type=offline` and `prompt=consent` from `queryParams`.
- Supabase project config: Site URL `https://simonsays.harrysson.co`; redirect allow-list =
  that domain, `simon-says-simonharryssons-projects.vercel.app`, `simon-says-five-kappa.vercel.app`,
  `localhost:3000` (each `/**`). OAuth starts in a server action, so no `NEXT_PUBLIC_` vars; the
  callback URL comes from the request's forwarded host.
- `google_tokens` was applied to simonsays-prod by hand (Management API SQL) because migrations
  only reach prod from `main`; the migration is idempotent so the GitHub integration can re-run it.
