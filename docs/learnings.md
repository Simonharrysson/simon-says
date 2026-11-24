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
