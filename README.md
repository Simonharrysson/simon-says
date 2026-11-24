# Simon Says

Live meeting notes in Google Docs for student associations in Linköping. One laptop at the table
streams the room's audio; structured notes build up live in a new Google Doc (a notes tab, and
optionally a transcript tab) in the Drive of whoever started the meeting. Free, UI in Swedish.

- Design: [docs/design.md](docs/design.md) · UI: [docs/ui.md](docs/ui.md) · Plan: [docs/plan.md](docs/plan.md) · Learnings: [docs/learnings.md](docs/learnings.md)
- Production: https://simonsays.harrysson.co (pages: `/status`, `/integritet`)
- Stack: Next.js (App Router) on Vercel (project `simon-says`, region `arn1`), Supabase (`simonsays-prod`, EU).

## Architecture

```
 laptop browser ──PCM audio──────────────▶ ElevenLabs (scribe_v3_live, WebSocket)
      │  ▲                                        │ committed + diarized text
      │  └── single-use token ──┐                 ▼
      └── committed segments ──▶ Next.js on Vercel (arn1) ──▶ Supabase (Postgres, RLS)
                                   │  notes tick (≥ 30 s apart)    transcripts, notes, usage
                                   ├──▶ Anthropic (Claude): operations on the notes
                                   └──▶ Google Docs/Drive (drive.file): notes + transcript tabs
 Vercel Cron: finalise abandoned meetings, daily summary ──▶ Resend (alarms to the operator)
```

Audio never reaches our server and is not stored. Only committed text is sent on. Usage is
counted server-side. Limits (per org, per day, kill switch) are in `lib/limits.ts`.

## Run locally

Needs Node 22+, and Docker for the local database.

```sh
npm ci
supabase start && supabase db reset   # local Postgres + auth
cp .env.example .env.local            # fill in, see below
npm run dev                           # http://localhost:3000
npm run typecheck && npm test
```

## Environment variables

Validated in `lib/env.ts` (zod) on first use. Never commit real values.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project (the service role key is server only) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth web client, also used by Supabase's Google provider |
| `TOKEN_ENC_KEY` | Encrypts Google refresh tokens: 32 random bytes, base64 (`openssl rand -base64 32`) |
| `ELEVENLABS_API_KEY` | Mints single-use realtime tokens |
| `ELEVENLABS_COMMIT_STRATEGY` | `manual`, `vad` or `turn_prediction` (default `vad`) |
| `ELEVENLABS_USD_PER_HOUR` | Cost booked per closed session (default `0.22`) |
| `ANTHROPIC_API_KEY` | Notes generation |
| `RESEND_API_KEY` | Alarm and summary email (optional) |
| `ALARM_EMAIL` | Where alarms go |
| `CRON_SECRET` | Authorises Vercel Cron requests |
| `APP_URL` | Public base URL (`http://localhost:3000` locally) |
| `GLOBAL_DAILY_HOURS`, `GLOBAL_DAILY_USD` | Global daily caps (defaults 30 h, $25) |
| `KILL_SWITCH` | `1` blocks token and tick endpoints |

## Migrations

Migrations live in `supabase/migrations` and reach `simonsays-prod` through Supabase's GitHub
integration on push to `main`. CI never runs `supabase db push`. Vercel deploys in parallel, so
**every migration must be backward compatible with the code in production**: add columns/tables
first and use them in a later deploy; never rename or drop in the same change as the code that
needs it. Automatic API grants are off, so every migration grants table access explicitly.

## CI

`.github/workflows/ci.yml`: gitleaks (full history), `supabase start` + `supabase db reset`,
`tsc --noEmit`, `vitest run`. `spike/` (Task 0 tooling) is excluded from typecheck and tests.
