# Simon Says v1 (live notes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One laptop at a meeting table streams audio; structured notes build up live in a new Google Doc (notes tab + transcript tab) for multiple Linköping organisations.

**Architecture:** Next.js app on Vercel (Pro). The browser captures mic audio and streams it straight to ElevenLabs `scribe_v3_live` with a single-use token from our server, then posts committed, diarized segments to our API. The server runs a notes tick (≥ 30 s apart, target 45 s) triggered by segment ingest; it asks Claude for updated notes items and writes them into per-item named ranges in the Doc, guarded by the Doc revision, never touching human-edited items. Supabase (EU) holds accounts, orgs, people, meetings, segments, notes items and server-counted usage.

**Tech Stack:** Next.js (App Router) + TypeScript, Supabase (Auth with Google, Postgres, RLS, CLI for local + CI), `googleapis` (docs v1, drive v3), `@anthropic-ai/sdk`, raw browser WebSocket + AudioWorklet, zod, vitest, Resend (alarm email), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-24-simon-says-live-notes-design.md` (in `~/pocket-ai`). Copied into the new repo in Task 1.

**Ordering principle (Simon: "we discover issues later that could have been found earlier"):** every external system is touched for real in the first task that depends on it, before code is built on top. Task 0 records real ElevenLabs behaviour (commit strategy, reconnects, long sessions, label stability). Task 2 proves Google sign-in, granted scopes, token lifetime, tabs, named-range edge behaviour and revision-guarded writes on a real account — the Doc model that decides the schema in Task 3. Task 6 is a walking skeleton (audio file → ElevenLabs → our API → transcript in a real Doc) before the notes engine or UI. Each task lists its **Early check**; findings go to `docs/learnings.md` and may change later tasks before they start.

**Review history:** draft 064de99 → revised after two independent reviews (external-API risks; spec coverage/consistency), c0dee20 → revised after Fable's check (session length, ElevenLabs event model, core bet tested first, cost per hour, silent failures, consent).

**Provisional until `spike/REPORT.md`:** the ElevenLabs event shapes and everything built on them (Task 3 `segments`/`speaker_runs`, Task 5 types). Task 0 must end with these interfaces confirmed or corrected in this plan before Task 3 starts.

## Global Constraints

- New **public** GitHub repo `simon-says`, fresh history. Nothing from `pocket-ai` git history. No secret ever committed; gitleaks in CI. **No real meeting audio or transcripts in the repo** — real recordings live in a private Supabase Storage bucket `fixtures-private`; the repo holds one scripted recording of Simon + friends.
- Separate from harrysson.co: own Vercel project (on Simon's Pro team), own Supabase project (EU region), no shared keys or code.
- Transcription: ElevenLabs `model_id=scribe_v3_live` set explicitly, `diarize=true`, `multilang_mode=true`, `include_timestamps=true`, `audio_format=pcm_16000` (16-bit PCM, base64), **`commit_strategy` set explicitly** (default is `manual`; Task 0 picks it and Task 4 hardcodes it), `keyterms` = the org's people names if Task 0 shows it helps. Raw WebSocket (SDK lacks `multilang_mode`). Token: `POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe`, passed as `token` query param. The 15-min expiry is only the time to **use** the token; `max_session_duration_seconds` **closes the session**, so it is set to the remaining allowed meeting time (≤ 4 h), never to 15 min.
- ElevenLabs event model (Fable, verified in docs; confirm in Task 0): `committed_transcript` carries text but no speaker; speakers arrive **per word** in a later `diarized_transcript` keyed by `segment_index`. We store **speaker runs** (consecutive words with one speaker) keyed `(el_session_id, segment_index, run_index)`.
- Speaker labels are only meaningful **within one ElevenLabs session**: everything keyed by speaker is keyed by `(meeting_id, el_session_id, speaker_label)`. Handle `speakers_merged`. Sessions are long (whole meeting) so reconnects are rare; audio is buffered in the browser during a reconnect and sent first on the new session.
- ElevenLabs logs requests by default (`enable_logging`; zero retention is Enterprise-only) — stated on `/integritet`.
- Only committed / diarized events go to the server; partials are display-only.
- Claude: `claude-opus-5-5`, streaming, structured output via `output_config.format`, adaptive thinking (default), `output_config.effort: "medium"` set explicitly, server-side fallbacks `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`, check `stop_reason` before reading content. Transcript sent as **append-only content blocks** (one per tick) with the cache breakpoint on the newest block; label→name map and current notes go after the cached part. Every Claude call's tokens are recorded in `usage_daily`.
- Google: scopes `openid email profile https://www.googleapis.com/auth/drive.file` only. OAuth app **External, publishing status "In production"** (unverified) from Task 2 — Testing status kills refresh tokens after 7 days. Callback verifies `drive.file` was actually granted. Every Docs request sets `tabId` / `tabsCriteria`. Notes writes: **read + diff immediately before writing** (after the Claude call, not before it), then `batchUpdate` with `writeControl.requiredRevisionId` from that read; on 400 repeat read→diff→write up to 4 times. Transcript appends use `endOfSegmentLocation {tabId}`, in a separate `batchUpdate`. Shares use `sendNotificationEmail=false`.
- Service never writes outside its own named ranges in the notes tab, and only appends in the transcript tab. **Human-edited items are locked**: kept verbatim, never reworded or removed, including the final pass — except the single "Pågår nu" item, which is never locked (it always reflects the current topic). The **full notes-tab text** (incl. lines people wrote outside our ranges) is sent to Claude as read-only context so it doesn't duplicate them.
- **Consent in the room:** before Start, the runner confirms "Alla i rummet vet att mötet transkriberas och kan be om paus" (logged per meeting); a Paus button stops audio. Per-org setting `share_transcript` (default on): when off, the transcript tab is not created and only notes are shared. Personal-data controller: **Harrysson & Company AB** (decided by Simon 2026-11-24), named on `/integritet`.
- **Usage is counted on the server only** (from token mints and server time), never from client-reported numbers.
- Limits: 20 h/month per org, 4 h per meeting (warn 3 h 45, stop 4 h), **max 2 orgs created per user**, **global cap `GLOBAL_DAILY_HOURS` (default 30)**, **global dollar cap `GLOBAL_DAILY_USD` (default 25)** computed from recorded usage, **`KILL_SWITCH=1` env** blocks token and tick endpoints. Notes ticks ≥ 30 s apart per meeting. Daily summary email at 06:00 UTC; **immediate** email when the day passes 50 % of the dollar cap.
- **Cost target:** Claude ≤ $1.50 per meeting-hour (measured in Task 0.5 / Task 8; gate). Claude returns **operations** (add / change / remove item) rather than the full list each tick, to keep output tokens small.
- **Visible health:** the Doc header shows `● LIVE · uppdaterad HH:mm`; the live page shows a banner when notes are > 3 min old; every tick outcome goes to `meeting_events`; 3 failed ticks in a row → immediate email to `ALARM_EMAIL`.
- Only the person running the meeting has an account; others are names in the org's person list. New org members get access to Docs of meetings started after they joined (older Docs: shared manually — v1 call).
- v1 stores no full meeting audio. Voiceprints are v1.1, but the `people` table exists now.
- UI text in Swedish; code and comments in English.
- Retention: transcripts/notes deleted with the meeting or org (delete UI in Task 3).

## Review Focus

1. **Laptop sleeps, tab hidden, closed or crashes mid-meeting** → ticks keep running server-side as long as segments arrive; on close, everything already transcribed reaches the Doc and cron finalizes within 15 min; reopening offers "Fortsätt mötet" and continues without overwriting earlier segments (keys come from ElevenLabs, not a client counter). (Tasks 5, 7, 10)
2. **A secretary types in the notes tab throughout the meeting** → their edits win and notes still update: read+diff right before each write, up to 4 revision-guarded retries; their own lines are seen by Claude and not duplicated. (Tasks 2, 8, 9, 10)
3. **ElevenLabs socket drops or hits its session limit** → page gets a new token at once (the closing session id frees the lock), reconnects within seconds, labels from the new session are treated as new speakers ("Vem är detta?"), no duplicated or overwritten segments. (Tasks 4, 5, 7, 11)
4. **Someone tries to burn money** (many orgs, fake heartbeats, flooding segments or ticks) → server-side usage, org-per-user limit, global cap, kill switch, segment size/rate limits, tick spacing. (Tasks 3, 4, 5, 10, 12)
5. **Google token revoked or scope unticked** → caught at sign-in (scope) or at write (`invalid_grant`): transcription continues, page shows "Dokumentet pausat — logga in igen", backlog is written after re-login. (Tasks 2, 10)

---

### Task 0: Spike — real ElevenLabs behaviour on one laptop mic (throwaway, gating)

**Files:** `spike/` in the new repo (or a scratch folder if Task 1 isn't done). Not production code, no tests.

- [ ] **Step 1:** Minimal page `spike/index.html`: `getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:true}})` → AudioWorklet to 16 kHz PCM16 → WebSocket `wss://…/v1/speech-to-text/realtime?model_id=scribe_v3_live&diarize=true&multilang_mode=true&audio_format=pcm_16000&commit_strategy=<under test>&token=…`; token from a 10-line local Node script. Log **every** message (JSON lines) and keep the raw 16 kHz audio.
- [ ] **Step 2:** Short runs (5 min each, 2–3 people) comparing `commit_strategy=vad` vs `manual` (+ a commit every N s) and `turn_prediction` on/off; try `infer_speaker_names=true`. Record segment length, label stability between partial and committed, and whether `speakers_merged` / `speaker_names` events appear.
- [ ] **Step 3:** Force one reconnect mid-run (kill Wi-Fi 10 s) and note whether labels restart. Run one session **> 2 h** with `max_session_duration_seconds=14400` (radio/podcast audio is fine) to find any real session limit. Confirm the event model: `committed_transcript` vs `diarized_transcript`, per-word speaker ids, `segment_index`, timestamps with `include_timestamps=true`. Try `keyterms` with 5 Swedish names.
- [ ] **Step 3b:** Type continuously on the capture laptop for 2 min during a run — does the keyboard noise wreck transcription or diarization?
- [ ] **Step 3c (for v1.1, cheap now):** on the same recording, enrol each speaker from their first sentence with one candidate voiceprint provider and record how often later turns match. Result → `REPORT.md`.
- [ ] **Step 4:** Record one real table meeting (≥ 20 min, ≥ 4 people, Swedish + English) with the built-in mic in the middle of the table; 5 min with the Electrokit mini USB mic for comparison. Upload audio + logs to private bucket `fixtures-private` (participants' consent).
- [ ] **Step 5:** Make a **synthetic 5-min meeting** for the public repo: a Swedish/English script (name round, one decision, two action items, a language switch) voiced by 4 different ElevenLabs TTS voices, mixed with light room noise, played through a speaker and recorded by the laptop mic → `fixtures/elevenlabs/scripted.{wav,jsonl}` + `scripted.expected.json` (the decisions/actions). No real person's voice in git history.
- [ ] **Step 6:** `spike/REPORT.md`: chosen `commit_strategy` and settings, speaker accuracy (spot-check 50 runs), latency, reconnect behaviour, real session limit, keyboard-noise result, exact JSON of every event type. **Update this plan's Task 3 and Task 5 interfaces** to match. **Gate:** speaker labels wrong > ~30 % with the built-in mic → decide with Simon (USB mic / placement) before continuing.

### Task 0.5: Spike — the core bet: live notes a human reads and edits (throwaway, gating)

**Files:** `spike/notes/` — plain Node scripts, no app, no tests. Uses Simon's Google token from a local OAuth flow and the Task 0 jsonl files.

- [ ] **Step 1:** Loop over the private meeting's events at 4× speed; every 45 s of meeting time send the new transcript chunk + current notes text to `claude-opus-5-5` (operations format: add/change/remove item) and write the result into a real Doc, one paragraph per item.
- [ ] **Step 2:** Two people read the Doc live on their laptops while it fills and one of them edits/deletes items and types own lines; the script respects edits naively (skip changed paragraphs).
- [ ] **Step 3:** Measure and write `spike/notes/REPORT.md`: **churn** = share of existing, unedited items whose text changed per tick (bar: median ≤ 15 %); recall of the decisions/actions in `scripted.expected.json` (bar: all found by the end); **Claude $ per meeting-hour** (bar: ≤ $1.50); cache hit rate; what the readers found confusing. **Gate:** if a bar is missed, change prompt/format/tick length here, before any app code. The churn metric and bars are reused in Task 8.

### Task 1: Repo, skeleton, CI with Supabase, environments

**Files:** `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.github/workflows/ci.yml`, `.gitleaks.toml`, `lib/env.ts`, `docs/design.md` (spec copy), `docs/learnings.md`, `README.md`, `.env.example`, `vercel.json`, `app/api/health/route.ts`.

**Interfaces:** `env` (zod, server-only): `SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENC_KEY (32-byte base64), ELEVENLABS_API_KEY, ELEVENLABS_COMMIT_STRATEGY, ANTHROPIC_API_KEY, RESEND_API_KEY, ALARM_EMAIL, CRON_SECRET, APP_URL, GLOBAL_DAILY_HOURS (default 30), GLOBAL_DAILY_USD (default 25), KILL_SWITCH (default 0)`.

- [ ] **Step 1:** Test `lib/env.test.ts`: missing `TOKEN_ENC_KEY` throws naming the key; 16-byte key throws "must be 32 bytes"; `GLOBAL_DAILY_HOURS` defaults to 30.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** CI: `supabase start` (CLI + Docker on the runner), `supabase db reset`, `tsc --noEmit`, `vitest run`, gitleaks. Deploy workflow on `main`: `supabase db push` to the remote project before Vercel deploys.
- [ ] **Step 4 (Early check):** Create Vercel project on the Pro team, Supabase project (EU), Google Cloud OAuth client (Web). Deploy with a dummy `*/5 * * * *` cron in `vercel.json` hitting `/api/health` with `CRON_SECRET`; confirm it deploys and fires. `GET /api/health` → `{ok:true}`.
- [ ] **Step 5:** Commit `chore: skeleton, env, CI`.

### Task 2: Google sign-in, granted scopes, tokens, and the real Doc model

**Files:** `app/login/page.tsx`, `app/auth/callback/route.ts`, `lib/crypto.ts`, `lib/google/client.ts`, `lib/google/scopes.ts`, `supabase/migrations/0001_google_tokens.sql`, tests `lib/crypto.test.ts`, `lib/google/scopes.test.ts`, script `scripts/check-google.ts`.

**Interfaces:** `encrypt(plain: string): string`, `decrypt(blob: string): string` (AES-256-GCM). `hasDriveFile(grantedScope: string): boolean`. `getGoogleAuth(userId: string): Promise<OAuth2Client>` throws `GoogleAuthLostError` on missing token or `invalid_grant`. Table `google_tokens(user_id pk, refresh_token_enc, scope, updated_at)` — service role only.

- [ ] **Step 1 (Early check, before code):** OAuth consent screen: External, scopes above, **publish to "In production"**. Real login via Supabase with `scopes` incl. `drive.file` and `queryParams {access_type:'offline', prompt:'consent'}`: confirm `provider_refresh_token` arrives in the callback and see which field reports granted scopes. If no refresh token: switch to a separate "Koppla Google Drive" code flow (our own OAuth client) and note it in `docs/learnings.md`.
- [ ] **Step 2:** Tests: crypto round-trip, tamper throws, two encryptions differ; `hasDriveFile("openid email https://www.googleapis.com/auth/drive.file") === true`, without it `false`.
- [ ] **Step 3:** Implement. Callback: if `drive.file` not granted → page "Du behöver ge Simon Says tillgång till filer den skapar" with a retry button; else store encrypted token + scope.
- [ ] **Step 4 (Early check — the Doc model):** `scripts/check-google.ts <userId>` on a real account, results in `docs/learnings.md`:
  - create Doc, `addDocumentTab` "Transkript", note both `tabId`s;
  - in the notes tab, insert 3 paragraphs and one named range per paragraph (`tabsCriteria`); Simon then types at the **start, middle and end** of a range and presses Enter inside one — record whether the range grows, splits or keeps its text;
  - `replaceNamedRangeContent` on one range; confirm neighbours untouched;
  - `batchUpdate` with a stale `requiredRevisionId` → confirm 400;
  - append to the transcript tab with `endOfSegmentLocation {tabId}` while Simon types in it;
  - **Simon types continuously for 2 min** in the notes tab while the script does read→write cycles every 10 s: count how often the revision guard rejects and whether 4 immediate retries get through;
  - share with a second account with `sendNotificationEmail=false` and confirm no email arrives.
  The findings fix the item format and the diff rule used in Tasks 3 and 9.
- [ ] **Step 5:** Commit `feat: google sign-in, scope check, stored refresh token`.

### Task 3: Schema, RLS, orgs, people, deletion

**Files:** `supabase/migrations/0002_core.sql`, `lib/db/types.ts`, `lib/db/*.ts`, `app/(app)/orgs/*`, `app/join/[code]/page.tsx`, `app/api/orgs/[id]/route.ts` (DELETE), `app/api/meetings/[id]/route.ts` (DELETE), tests `tests/db/rls.test.ts`, `tests/api/delete.test.ts`.

**Tables:**
- `orgs(id, name, invite_code unique, show_on_status bool default false, share_transcript bool default true, created_by, created_at)` — insert trigger rejects a 3rd org by the same `created_by`.
- `org_members(org_id, user_id, role 'admin'|'member', joined_at)`.
- `people(id, org_id, name, member_user_id null)`.
- `meetings(id, org_id, started_by, doc_id, notes_tab_id, transcript_tab_id null, header_range, section_ranges jsonb, status 'live'|'ending'|'done'|'abandoned', consent_confirmed_at, started_at, ended_at, last_heartbeat_at, last_tick_at, last_tick_ok_at, failed_ticks int default 0, tick_lease_until, doc_paused_at null, current_el_session_id null)`.
- `el_sessions(id text primary key, meeting_id, started_at, max_seconds int, closed_at null)` — the server's record of every minted session; usage = `least(coalesce(closed_at, now()), started_at + max_seconds) - started_at`.
- `segments(meeting_id, el_session_id, segment_index int, run_index int, speaker_label, text, start_ms, end_ms, lang, tick_no int null, written_to_doc bool, primary key (el_session_id, segment_index, run_index))` — one row per speaker run (**provisional**, per Task 0). `start_ms`/`end_ms` are meeting-relative (`el_sessions.started_at - meetings.started_at` + event offset). `tick_no` is set when a tick takes the run into a transcript block and never changes.
- `meeting_events(id, meeting_id, at, kind 'tick_ok'|'tick_failed'|'tick_conflict'|'doc_paused'|'reconnect'|'consent'|'alarm', detail jsonb)`.
- `speaker_map(meeting_id, el_session_id, speaker_label, person_id null, display_name, needs_confirm bool, primary key (meeting_id, el_session_id, speaker_label))`.
- `note_items(meeting_id, id text, section 'decision'|'action'|'now'|'attendees', text, owner, due, locked bool, deleted_by_human bool, last_rendered_text, range_name, position int, primary key (meeting_id, id))`.
- `usage_daily(org_id, day, seconds int, claude_input_tokens, claude_output_tokens, cache_read_tokens, cache_write_tokens, usd numeric, primary key (org_id, day))` — `seconds` and `usd` updated when a session closes and after every Claude call.

**Interfaces:** `lib/db/types.ts` exports row types incl. `NoteItemRow` (mirrors `note_items`), `SegmentRow`, `MeetingRow`, `ElSessionRow`. `orgMonthSeconds(orgId): Promise<number>` = closed sessions' seconds from `usage_daily` this month + open sessions' elapsed seconds (the single source for caps). `dayUsd(): Promise<number>` across all orgs. `memberEmails(orgId): Promise<string[]>` via service role on `auth.users`. `logEvent(meetingId, kind, detail)`.

- [ ] **Step 1:** RLS tests: member of org A cannot read org B's meetings/segments/people/note_items; join by invite code works; `google_tokens` unreadable by any client role; 3rd org by same user rejected.
- [ ] **Step 2:** Delete tests: deleting a meeting removes its segments, speaker_map, note_items (cascade); deleting an org removes everything under it; only admins can delete an org; the Google Doc itself is left in Drive (stated in the UI).
- [ ] **Step 3:** FAIL → write migration → PASS.
- [ ] **Step 4:** Pages: create org, invite link, person list add/rename/delete, delete meeting, delete org (confirm by typing the org name). Server-side data access only.
- [ ] **Step 5:** Commit `feat: schema, orgs, people, deletion with RLS`.

### Task 4: ElevenLabs token endpoint (server-counted usage)

**Files:** `app/api/meetings/[id]/token/route.ts`, `lib/elevenlabs/token.ts`, `lib/limits.ts`, tests `tests/api/token.test.ts`, `lib/limits.test.ts`.

**Interfaces:** `POST /api/meetings/:id/token` body `{closingSessionId?: string}` → `{token, wsUrl, sessionId}`; `wsUrl` contains `model_id=scribe_v3_live&diarize=true&multilang_mode=true&audio_format=pcm_16000&commit_strategy=${ELEVENLABS_COMMIT_STRATEGY}` (+ any other Task 0 settings). `mintToken(maxSessionSeconds: number): Promise<string>`. `checkLimits(orgId, meetingId): {ok, warn, stop, reason?: 'org_month'|'meeting_length'|'global_day'|'global_usd'|'kill_switch'|'no_consent'}`.

Usage rule: on each mint the server sets `closed_at = now()` on the previous `el_sessions` row (if `closingSessionId` matches `current_el_session_id`), adds its seconds to `usage_daily`, and inserts a new `el_sessions` row with `max_seconds = min(remaining meeting of 4 h, remaining org month, remaining global day hours)` — passed as `max_session_duration_seconds`, so one session normally covers the whole meeting. A new token is allowed if `closingSessionId == current_el_session_id`, or the current session's `started_at + max_seconds < now`, or `last_heartbeat_at` is > 60 s old; otherwise 409. Also refused when `dayUsd() ≥ GLOBAL_DAILY_USD` or `consent_confirmed_at` is null.

- [ ] **Step 1:** Tests (ElevenLabs mocked): 401 signed out; 403 not the starter; 403 without consent; 409 second token while a session is open and no `closingSessionId`; **reconnect: socket drops, request 1 s later with `closingSessionId` succeeds**; `max_session_duration_seconds` = remaining meeting time (e.g. 14 400 at start), never 900; 429 at org 20 h, meeting 4 h, global hours, global dollars; 503 with `KILL_SWITCH=1`; usage computed from `el_sessions` server times only.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3 (Early check):** real mint + Node connection with the exact `wsUrl`; no `invalid_request`.
- [ ] **Step 4:** Commit `feat: guarded token endpoint with server-side usage`.

### Task 5: Event parser, segment ingest, heartbeat

**Files:** `lib/elevenlabs/events.ts`, `app/api/meetings/[id]/segments/route.ts`, `app/api/meetings/[id]/heartbeat/route.ts`, tests `lib/elevenlabs/events.test.ts`, `tests/api/segments.test.ts`.

**Interfaces:**
*(Provisional — rewrite from `spike/REPORT.md` before starting.)*
- `parseEvent(raw: string): ParsedEvent` where `ParsedEvent = {kind:'partial', text} | {kind:'committed', segmentIndex, text} | {kind:'diarized', segmentIndex, words: {text, speaker, startMs, endMs}[]} | {kind:'merged', from: string[], into: string} | {kind:'session_end', reason} | {kind:'error', code}`.
- `toRuns(ev: DiarizedEvent): Run[]` — groups consecutive words with the same speaker: `Run = {segmentIndex, runIndex, speaker, text, startMs, endMs}` (session-relative ms).
- `SegmentIn = Run & {elSessionId: string, lang?: string}`. The key is `(elSessionId, segmentIndex, runIndex)` — all from ElevenLabs, nothing client-counted, so a crash/resume can never collide.
- `POST /segments {segments: SegmentIn[], merges?}`: insert `on conflict do nothing`; accept any `elSessionId` that exists in `el_sessions` for this meeting **including closed ones** (so the last batch of a closed session is not lost); converts to meeting-relative ms; reject text > 2 000 chars, > 120 runs/min, or meeting `done`/`abandoned` (409). After insert, `after(() => maybeTick(meetingId))` (Task 10).
- `POST /heartbeat` → updates only `last_heartbeat_at`; returns `{warn, stop}` from `checkLimits`. Merged speakers: `{kind:'merged'}` events are posted as `POST /segments` side field `merges: {elSessionId, from, into}[]` and applied to `speaker_map` / future segments.

- [ ] **Step 1:** Parser tests on `fixtures/elevenlabs/scripted.jsonl`: diarized count equals the report's; runs split exactly where the speaker changes; session-limit message → `session_end`; merge event parsed.
- [ ] **Step 2:** Ingest tests: same batch twice stored once; a resent batch with different text for an existing key does **not** overwrite; a batch for a session closed 5 s ago is accepted; session of another meeting 409; rate limit 429; `done` meeting 409; meeting-relative times correct across two sessions.
- [ ] **Step 3:** FAIL → implement → PASS. Commit `feat: event parser, idempotent ingest, heartbeat`.

### Task 6: Walking skeleton — audio file → ElevenLabs → API → real Doc

**Files:** `lib/docs/create.ts`, `lib/docs/transcript.ts`, `app/api/meetings/route.ts`, `scripts/replay.ts`, `scripts/test-session.ts`, test `tests/docs/transcript.test.ts`.

**Interfaces:**
- `createMeetingDoc(auth, {orgName, startedAt, memberEmails, shareTranscript: boolean}): Promise<{docId, notesTabId, transcriptTabId: string | null, headerRange, sectionRanges: Record<'attendees'|'decision'|'action'|'now', string>}>` — finds/creates Drive folder `Simon Says – <orgName>` (owned by the starter), creates the Doc there titled `"<Org> möte <YYYY-MM-DD HH:mm>"`, adds tab "Transkript" only if `shareTranscript`, writes header `● LIVE · uppdaterad –` (named range `ss-<meetingId>-header`) and headings Närvarande / Beslut / Att göra / Pågår nu, each with an anchor named range `ss-<meetingId>-sec-<section>` (format per Task 2 Step 4 learnings), shares writer with `memberEmails` using `sendNotificationEmail=false`. The transcript is always stored in our DB (needed for notes) even when not written to the Doc.
- `appendTranscript(auth, docId, tabId, lines: {speaker: string, atMs: number, text: string}[]): Promise<void>` — one `batchUpdate`, `insertText` at `endOfSegmentLocation {tabId}`, line format `Anna 00:41:52: text`.
- `POST /api/meetings {orgId}` → `{meetingId, docUrl}`.
- `scripts/test-session.ts <email>` prints a Supabase access token for a dedicated test user (service role); `scripts/replay.ts <wav> <meetingId> [--speed N]` uses it as `Authorization: Bearer`, streams the WAV to ElevenLabs via the token endpoint, parses events, posts segments/heartbeats.

- [ ] **Step 1:** Unit test: `appendTranscript` sends one `insertText` with `endOfSegmentLocation.tabId` and the formatted lines.
- [ ] **Step 2:** FAIL → implement → PASS. Temporary `POST /api/meetings/:id/flush-transcript` writes pending lines (removed in Task 10).
- [ ] **Step 3 (Early check):** `replay.ts fixtures/elevenlabs/scripted.wav` against the preview deployment, then the private 20-min meeting. Expected: Doc in the org folder, shared with the second test account, transcript tab filling. Surprises → `docs/learnings.md`, adjust later tasks before continuing.
- [ ] **Step 4:** Commit `feat: walking skeleton`.

### Task 7: Browser capture and live page

**Files:** `app/(app)/meetings/[id]/page.tsx`, `components/live/*`, `public/pcm-worklet.js`, `lib/audio/resample.ts`, `lib/audio/stream.ts`, tests `lib/audio/resample.test.ts`, `lib/audio/stream.test.ts`.

**Interfaces:** `resampleTo16kPcm16(input: Float32Array, inRate: number): Int16Array`. `class LiveStream { start(): Promise<void>; pause(): void; resume(): void; stop(): Promise<void>; on(event: 'partial'|'runs'|'merged'|'state', cb) }` — token fetch (passing `closingSessionId` on reconnect), WebSocket, reconnect backoff 1 s/2 s/5 s then every 5 s, **audio ring buffer (up to 60 s) kept during a reconnect and sent first on the new session**, batch runs every 3 s with retry (a closed session's pending batch is still sent), heartbeat every 10 s, Screen Wake Lock re-acquired on `visibilitychange`. Pause stops sending audio (and is logged).

- [ ] **Step 1:** Tests: 48 kHz 1 s sine → 16 000 samples, amplitude within 1 %; on socket close a new token is requested with `closingSessionId`, buffered audio is sent first on the new socket, and the old session's pending runs are still posted; failed POST is retried, not dropped; 3 failed token requests → state `'error'`; pause sends no audio.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** Page: consent checkbox "Alla i rummet vet att mötet transkriberas och kan be om paus" required before Start (sets `consent_confirmed_at`); Start / Paus / Stopp; Swedish mic-permission-denied message; live partial text; timer; Doc link; banners (`Ansluter igen…`, `Dokumentet pausat — logga in igen`, `Anteckningarna har inte uppdaterats på N min`, 3 h 45 warning). An unfinished meeting (`live` or `abandoned` < 2 h old) shows "Fortsätt mötet", which sets it back to `live`.
- [ ] **Step 4 (Early check):** 15 min on Simon's laptop in Chrome and Safari: tab hidden for 10 min, lid closed 30 s, Wi-Fi off 10 s. Confirm segments keep arriving while hidden and notes keep updating (server-side ticks). Results → `docs/learnings.md`.
- [ ] **Step 5:** Commit `feat: live capture page`.

### Task 8: Notes engine (Claude)

**Files:** `lib/notes/schema.ts`, `lib/notes/prompt.ts`, `lib/notes/engine.ts`, test `lib/notes/engine.test.ts`, script `scripts/notes-replay.ts`.

**Interfaces:** `NotesItem = {id: string, section: 'decision'|'action'|'now'|'attendees', text: string, owner?: string, due?: string}`. `NotesOp = {op:'add', item: NotesItem} | {op:'change', id: string, text?: string, owner?: string, due?: string} | {op:'remove', id: string}`. `updateNotes(input: {orgName: string, transcriptBlocks: string[], speakerNames: Record<string, string>, notesTabText: string, items: NotesItem[], locked: NotesItem[], deletedIds: string[], final: boolean}): Promise<{ops: NotesOp[], items: NotesItem[], usage: {input, output, cacheRead, cacheWrite, usd}}>` — `items` = previous items with valid ops applied. `churn(prev: NotesItem[], next: NotesItem[], locked: string[]): number` (same metric as Task 0.5).

Message layout: system prompt (stable) → one user content block per earlier tick (built from segments with that `tick_no`; labels `S<session>-<label>`, never rewritten), `cache_control` on the newest block → final block with speaker-name map, the full notes-tab text as read-only context, current items, locked items, deleted ids, instruction. Prompt rules (from Task 0.5): meeting's main language; change as little as possible; output only ops; never touch locked/deleted ids; don't duplicate lines people wrote themselves; new ids `n<counter>`; exactly one "now" item; owners from the name map. On `final: true` a full tidy-up is allowed except locked items.

- [ ] **Step 1:** Tests (mocked client): ops on locked/deleted ids are dropped; `remove` of a locked item ignored; `refusal` → no ops; malformed output → no ops + log; request uses `claude-opus-5-5`, effort `medium`, fallbacks `default`, cache breakpoint on the newest transcript block; `usage.usd` computed with $4 / $20 / $0.20 per MTok (+ cache-write rate); `churn` on a fixed pair.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3 (Early check, gate):** `scripts/notes-replay.ts` on the scripted and the private meeting at real tick spacing against the real API; prints ops per tick, `cache_read_input_tokens` (**> 0 from tick 2**), churn, $ per meeting-hour. **Gate: Task 0.5 bars (median churn ≤ 15 %, all expected items found, ≤ $1.50/h).** Simon reads the output before Task 9.
- [ ] **Step 4:** Commit `feat: notes engine`.

### Task 9: Render notes into the Doc + human-edit detection

**Files:** `lib/docs/notes.ts`, test `lib/docs/notes.test.ts` (fixture Doc JSON captured in Task 2), script `scripts/check-notes-render.ts`.

**Interfaces:**
- `readItems(auth, docId, tabId, rows: NoteItemRow[]): Promise<{revisionId: string, current: Map<string, string | null>}>` (null = range gone).
- `diffHumanEdits(rows: NoteItemRow[], current: Map<string, string|null>): {locked: NotesItem[], deletedIds: string[], rows: NoteItemRow[]}` — text ≠ `last_rendered_text` → locked with the human text; null → `deleted_by_human`.
- `toNotesItem(row: NoteItemRow): NotesItem`.
- `renderItems(auth, meeting: MeetingRow, rows: NoteItemRow[], desired: NotesItem[], revisionId: string): Promise<'ok'|'conflict'>` — one `batchUpdate` with `writeControl.requiredRevisionId = revisionId`: `replaceNamedRangeContent` for changed unlocked items; new items inserted after their section anchor's last item with range `ss-<meetingId>-<itemId>`; removed unlocked items deleted with their range. Requests ordered from highest index to lowest. Formats: action `☐ Owner: text (due)`, decision `✓ text` (adjusted by Task 2 learnings). 400 on revision mismatch → `'conflict'`.

- [ ] **Step 1:** Tests on fixture Doc JSON: edited item → locked; deleted range → in `deletedIds`, never re-added; unchanged items → no request; requests sorted descending by index; every request has `tabId`; revision mismatch → `'conflict'`.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3 (Early check):** `check-notes-render.ts` on a real Doc: render 5 items; Simon edits one, deletes one, and types while a render is in flight; render again. Expected: edit and deletion survive; in-flight typing causes `'conflict'`, not an overwrite.
- [ ] **Step 4:** Commit `feat: revision-guarded notes rendering`.

### Task 10: Tick, end, finalize

**Files:** `lib/meetings/tick.ts`, `app/api/meetings/[id]/end/route.ts`, `app/api/cron/finalize/route.ts`, `vercel.json` (cron `*/5 * * * *`, `maxDuration` 300 for end/cron/segments), tests `tests/meetings/tick.test.ts`.

**Interfaces:** `maybeTick(meetingId): Promise<void>` — runs `runTick` only if `now - last_tick_at ≥ 45 s` (hard floor 30 s), `KILL_SWITCH` is off and `dayUsd() < GLOBAL_DAILY_USD`. `runTick(meetingId, {final}): Promise<'ok'|'busy'|'doc_paused'|'conflict'|'failed'>`. Lease: `update meetings set tick_lease_until = now()+interval '4 minutes' where id=$1 and (tick_lease_until is null or tick_lease_until < now()) returning id`; **released in `finally`** (`tick_lease_until = null`). Order: assign `tick_no` to unassigned segments → read notes-tab text + items → diff → `updateNotes` → **read + diff again immediately before writing** → `renderItems` with that revision (on `'conflict'`: re-read, re-diff, drop ops on newly locked items, retry; max 4) + header range → `● LIVE · uppdaterad HH:mm` → `appendTranscript` (separate call, only if transcript tab) → mark written → `last_tick_at`, `last_tick_ok_at`, `failed_ticks=0`, `usage_daily` → `logEvent`. Failure: `failed_ticks += 1`, `logEvent('tick_failed')`; at 3 in a row email `ALARM_EMAIL` (once per meeting per hour). `GoogleAuthLostError` → `doc_paused_at=now()`. End: final tick, header → `Avslutat HH:mm`, status `done`, close the open `el_sessions` row. Cron: `live` meetings with `last_heartbeat_at` older than 15 min → final tick → `abandoned`; `doc_paused_at` meetings where `google_tokens.updated_at > doc_paused_at` → run tick, clear pause; close `el_sessions` rows past `started_at + max_seconds`.

- [ ] **Step 1:** Tests: concurrent `runTick` → one `'ok'`, one `'busy'`; **two sequential ticks 45 s apart both run (lease released)**; tick within 30 s → skipped; conflict path retries up to 4 times then skips with `tick_conflict` event; 3 failed ticks → one alarm email; `GoogleAuthLostError` → paused, segments untouched, resumed by cron after token update; abandoned finalized once; ending twice is a no-op; kill switch or dollar cap → no Claude call; late segments get the next `tick_no`, earlier blocks unchanged.
- [ ] **Step 2:** FAIL → implement → PASS. Remove the temporary flush endpoint.
- [ ] **Step 3 (Early check):** replay the 20-min private meeting at `--speed 4` on preview: notes update, transcript fills; kill the replay midway → finalized within 15 min.
- [ ] **Step 4:** Commit `feat: server-driven ticks, end and finalize`.

### Task 11: Name round + speaker list

**Files:** `components/live/NameRound.tsx`, `components/live/SpeakerList.tsx`, `app/api/meetings/[id]/speakers/route.ts`, `lib/names/extract.ts`, tests `lib/names/extract.test.ts`, `tests/api/speakers.test.ts`.

**Interfaces:** `extractNames(segments: SegmentRow[], knownPeople: string[]): Promise<{elSessionId, speakerLabel, name, needsConfirm}[]>` (Claude, same settings, structured output, tokens recorded; if Task 0 showed `infer_speaker_names` works, use its `speaker_names` events first and Claude only as fallback). `PATCH /speakers {elSessionId, speakerLabel, personId?, displayName}`.

Flow: after Start, "Namnrunda: säg 'Jag heter …' en i taget" + "Klar"; results fill `speaker_map` and add new names to `people`. After a reconnect, labels of the new session are unmapped: the speaker list shows "Vem är detta?" for each with the meeting's names as one-tap choices. Renames apply to transcript lines written afterwards and to notes owners from the next tick.

- [ ] **Step 1:** Tests: "Jag heter Erik" + known "Eric" → "Eric"; two labels claiming the same name → both `needs_confirm`; new session labels unmapped until chosen; rename persists.
- [ ] **Step 2:** FAIL → implement → PASS. Commit `feat: name round and speaker list`.

### Task 12: Warnings, stop and spend alarm

**Files:** `app/api/cron/alarm/route.ts`, `vercel.json` (cron `0 6 * * *` UTC), tests `tests/api/alarm.test.ts`.

Heartbeat `{warn, stop}` (from Task 4's `checkLimits`) drives the page: warning banner at 3 h 45, automatic end at 4 h. Daily summary (06:00 UTC) to `ALARM_EMAIL` via Resend: yesterday's hours per org and total, ElevenLabs cost (hours × $0.22), Claude cost from `usage_daily.usd`, $ per meeting-hour, failed ticks; subject starts `⚠️` if the day exceeded 50 % of `GLOBAL_DAILY_USD`. Immediate email (from the usage update path) the first time a day crosses 50 % of `GLOBAL_DAILY_USD`.

- [ ] **Step 1:** Tests: page stops at 4 h via heartbeat `stop`; cost math on a fixed `usage_daily` row; ⚠️ threshold; immediate email sent once per day at 50 %.
- [ ] **Step 2:** FAIL → implement → PASS. Commit `feat: warnings and spend alarm`.

### Task 13: Status page, privacy page, README

**Files:** `app/status/page.tsx`, `app/integritet/page.tsx`, `README.md`.

- [ ] **Step 1:** `/status` (no auth): live meetings now, minutes this week, org names only where `show_on_status`. Test: non-opted-in org name absent from HTML.
- [ ] **Step 2:** `/integritet`: controller (Harrysson & Company AB), processors (ElevenLabs — logs requests by default, Anthropic, Google, Supabase, Vercel, Resend), what is stored, retention, the in-room consent step and Paus, the per-org transcript-sharing setting, how to delete meeting/org, contact. Linked from login and live page.
- [ ] **Step 3:** README: what it is, text architecture diagram, local run, env vars. (Showcase polish = project 3.)
- [ ] **Step 4:** Commit `feat: status and privacy pages, README`.

### Task 14: First real meeting (dogfood)

- [ ] **Step 1:** Simon sets the ElevenLabs spend cap in the dashboard; confirms the OAuth app is "In production".
- [ ] **Step 2:** One LiU AI Society meeting end to end. Because v1 stores no audio, the runner also records the meeting separately (phone or the Pocket AI Mac app) **with everyone's spoken OK**; that audio + the secretary's minutes + our transcript go to `fixtures-private` (input for project 2).
- [ ] **Step 3:** `docs/learnings.md`: what broke, what the notes got wrong, meeting cost from the alarm email; file follow-ups.
