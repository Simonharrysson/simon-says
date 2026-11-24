# Simon Says

Live meeting notes in Google Docs. Work in progress.

- Spec: [docs/design.md](docs/design.md) · Plan: [docs/plan.md](docs/plan.md) · Learnings: [docs/learnings.md](docs/learnings.md)
- Stack: Next.js (App Router) on Vercel (project `simon-says`, region `arn1`), Supabase (`simonsays-prod`, EU).
- Production: https://simonsays.harrysson.co

## Develop

```sh
npm ci
cp .env.example .env.local   # fill in; see lib/env.ts for what each key must be
npm run dev
npm run typecheck && npm test
supabase start && supabase db reset   # local database (needs Docker)
```

## Environment

All server env is validated in `lib/env.ts` (zod) on first use. `TOKEN_ENC_KEY` is 32 random
bytes, base64 (`openssl rand -base64 32`). `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Task 2) and
`RESEND_API_KEY` (Task 12) are optional until those tasks land.

## Migrations

Migrations live in `supabase/migrations` and reach `simonsays-prod` through Supabase's GitHub
integration on push to `main`. CI never runs `supabase db push`. Vercel deploys in parallel, so
**every migration must be backward compatible with the code in production**: add columns/tables
first and use them in a later deploy; never rename or drop in the same change as the code that
needs it. Automatic API grants are off, so every migration grants table access explicitly.

## CI

`.github/workflows/ci.yml`: gitleaks (full history), `supabase start` + `supabase db reset`,
`tsc --noEmit`, `vitest run`. `spike/` (Task 0 tooling) is excluded from typecheck and tests.
