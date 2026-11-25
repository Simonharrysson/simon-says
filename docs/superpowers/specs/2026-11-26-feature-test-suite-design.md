# Feature test suite — design (todo #4, 2026-11-26)

Simon's ask: "create comprehensive test suite for the different features in the application. create for document format, transcription style, voices in each förening, dashboard with information from n meeting etc."

Written overnight without Simon; every interpretation below is marked **(my call)** and listed in ~/simon-says-private/overnight-decisions-2026-11-25.md.

## Why

Today the features are tested piecemeal: unit tests per module (vitest, ~750), DB tests in CI, and a paid notes eval over 9 fixtures. There is no single place that says, per feature, "this works" — and no test at all for some cross-cutting behaviours (two föreningar with the same first names, a chain of several meetings, every format end to end without Claude). The suite should answer "is every feature still working?" in one command, cheaply, and grow as features are added.

## Shape

One command, `npm run suite`, prints a scorecard: one row per feature, PASS/FAIL, with the tests behind it. Two tiers:

1. **Free tier (always, CI):** deterministic end-to-end tests with scripted Claude answers (no API calls) through the real code paths: start → anchor → ticks → final pass, rendered into `test/docsim` documents. Runs in `npx vitest run` under `tests/suite/`.
2. **Paid tier (on demand):** `npm run suite -- --paid --budget <usd>` adds the real-Claude eval fixtures (scripts/notes-eval) for the same features and records spend in the eval ledger. Default budget $1.50 **(my call: Anthropic headroom until Dec 1)**.

## Features covered

1. **Document formats** — for each of Veckomöte (agenda mode, human agenda Doc), Veckomöte without Må-runda, Styrelseprotokoll (with stadgar required items), Enkel (v1 layout), and a learned profile: a scripted meeting renders into a docsim Doc and the suite asserts the final Doc shape (items under the right anchors, tasks section by role/person, info table, "avslutat" line, human text untouched).
2. **Transcription style** **(my call)** — how people speak and refer to each other: full name, first name, role ("kassören", "ordföranden"), "jag"/self, someone not in the people list, mixed Swedish/English, filler and false starts. Free tier: owner resolution and the rendered owner label for each case; the Transkript tab shows what was said verbatim (speaker names, no masking of words). Paid tier: one fixture where tasks are assigned in all these ways.
3. **Voices in each förening** **(my call)** — speaker naming per förening: the name round maps speaker labels to people of that förening only; two föreningar that both have an "Anna" never mix; a test session never creates people rows; an unnamed voice stays "Vem är detta?".
4. **Information from n meetings** **(my call)** — a chain of 3–4 meetings in one förening: tasks carried week to week, closed ("✓ klart" propagates to the source), a false start in between, test and real meetings never mixed. Asserts the per-meeting open/closed task counts that a dashboard (todo #2) would show, via one pure helper `meetingChainSummary(orgId)` returning `{ meetingId, startedAt, decisions, tasksOpened, tasksClosed, tasksOpen }[]` — the seed of the dashboard data.
5. **Safety rails** — human edits win, revision conflicts retry, kill switch / day cap stop Claude, privacy (no Doc text in events/logs; learn-format sends only structure).

## Non-goals

- No browser/UI automation (no Playwright setup in the repo); UI stays covered by its unit tests and /design.
- No live ElevenLabs (credits; docs/checklist-11-28.md).
- No dashboard UI (todo #2).

## Builder notes

- Reuse: test/docsim.ts, lib/testmeeting fixtures, scripts/lib/notes-run.ts replay, the A12/A13 tick test harnesses.
- Fixtures fictional only.
- The scorecard maps test files to features by a `feature:` tag in each suite file's describe name.
