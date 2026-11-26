# Testing

| Layer | Command | What it covers |
| --- | --- | --- |
| Unit and API | `npm test` (vitest) | Pure logic, route handlers with mocks; DB tests against the local Supabase (skipped without it, required in CI) |
| Feature suite | `npm run suite` | Scripted Claude through the real engine into `test/docsim` Docs, one scorecard row per feature |
| E2E | `npm run e2e` (Playwright) | Real user flows clicked through in Chromium against the real app |

## E2E

The real app runs under `next dev` on `http://127.0.0.1:3100` against the **local Supabase**.
Every external service is faked; nothing reaches Google, Anthropic or ElevenLabs.

### Run it

```sh
supabase start && supabase db reset      # needs Docker
npx playwright install chromium          # once (or E2E_CHANNEL=chrome to use installed Chrome)
npm run e2e                              # whole suite, desktop + phone (390 px)
npx playwright test live --project=desktop --headed   # one file, watching
npx playwright show-report               # after a failure: traces, screenshots, page snapshots
```

Playwright starts both servers (`playwright.config.ts` → `webServer`). The local stack's
sign-in rate limits (`[auth.rate_limit]` in `supabase/config.toml`, 30 per 5 min) are lower
than a full run needs; CI lifts them for its own stack (`sed` in the `e2e` job). Locally, raise
`token_verifications` and `sign_in_sign_ups` before `supabase start` if a run hits them.
Pages without a database (landing, login, integritet) run without the stack:
`E2E_NO_DB=1 npx playwright test public`.

CI: the `e2e` job in `.github/workflows/ci.yml` starts its own Supabase, runs the suite with 4
workers and uploads `playwright-report/` and `test-results/` (traces) as an artifact.

### How the fakes work

`e2e/fakes/server.ts` is one process (port 4010, ElevenLabs on 4011), started by Playwright:

- **Google** (`E2E_GOOGLE_ROOT`): the OAuth token endpoint, Docs v1 (`documents.get`,
  `batchUpdate`) and the Drive v3 calls the app makes (files create/get/list/update/export,
  permissions). Each Doc tab is a `test/docsim` Doc, so the measured Docs behaviour applies;
  `writeControl.requiredRevisionId` is enforced; an unmodelled request is a 400 like Google's.
  The app's Docs/Drive clients and the token refresh use this root only in the e2e mode.
- **Claude** (`ANTHROPIC_BASE_URL`): `/v1/messages`, streamed as SSE. Calls are recognised by
  their system prompt and answered with fixed schema-valid JSON (`SCRIPTED` in
  `e2e/fakes/claude.ts`: the notes decision/action, goals, names, protocol extracts). An
  unknown prompt is a 500 and is logged.
- **ElevenLabs** (`ELEVENLABS_WS_URL`): `scripts/fake-elevenlabs.ts`, one scripted line per
  second of audio. Chromium's fake microphone (`--use-fake-device-for-media-stream`) plays a
  tone, so the live page really records and streams.
- **Mail** (`E2E_MAIL_URL`): a Resend-shaped `POST /resend/emails` that records every mail
  (`fake.mail(to)`); an address with `+fail` is refused (422), `+slow` gets a 500 (uncertain).
  `defaultMailer()` uses it only in the e2e mode, so no real provider is ever called.
- Fake ElevenLabs sessions are stored as `kind = 'test'` (the token route's dev path), so their
  name round never reads the förening's people list; summary specs take attendance from seeded
  Närvarande lines instead.
- **Sign-in**: "Logga in med Google" runs the real server action; the browser's request to
  Supabase's `/auth/v1/authorize` is answered by the spec (`e2e/fixtures.ts`) with a redirect
  to `GET /api/e2e/login?email=…@e2e.test&next=…`, which signs the user in with a magic link
  and stores a fake Google refresh token. `nextLogin.cancel = true` instead returns Google's
  "cancelled" to the real `/auth/callback`.
- **Google Picker**: `https://apis.google.com/js/api.js` is answered with `e2e/fakes/picker.js`;
  `queuePick(page, files)` sets what the next Picker "picks".
- **Control API** (`http://127.0.0.1:4010/__e2e/…`): create Drive files and Docs, read a Doc's
  text, list Claude calls. Wrapped by `fake` in `e2e/fixtures.ts`.
- **No real internet**: every request from the browser to a non-loopback host is aborted and
  fails the test.

### The test mode can never run in production

`/api/e2e/login`, `E2E_GOOGLE_ROOT` and `E2E_MAIL_URL` work only when `lib/e2e/guard.ts` `e2eMode()` holds:
`E2E_TEST_MODE=1`, `NODE_ENV` not `production` (every `next build`/`next start` and Vercel
deployment), not on Vercel (`VERCEL`/`VERCEL_ENV` unset), and `SUPABASE_URL` a loopback host
(the hosted project is refused). Otherwise the route is a 404 and the root is ignored.
`lib/e2e/guard.test.ts` covers the matrix.

### Add a spec

1. Create `e2e/specs/<flow>.spec.ts` and import `test`, `expect` from `../fixtures`.
2. Seed what the flow needs with the service role, never through another flow's UI:
   `seedOrg({ people, members })` (a fresh förening per test, the shared admin as admin),
   `seedMeeting(db, org, { items })`, `fake.createDoc(...)`.
3. Tests run as the shared admin (`admin@e2e.test`, storage state from `e2e/global-setup.ts`).
   For someone else: `signedIn(email, path)` (a second browser) or
   `test.use({ storageState: { cookies: [], origins: [] } })` plus `nextLogin.email`.
4. Use roles and Swedish labels (`getByRole("button", { name: "Starta mötet" })`), assert
   what the user sees, and check the Doc through `fake.docText(id)`.
5. Call `expectAccessible(page)` on new pages and dialogs (fails on serious/critical axe).
6. Tag the title `@phone` to also run it at 390 px.
7. A test that fails because the app is wrong is a bug: report it, don't bend the test.
