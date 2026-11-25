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

## 2026-11-24 · Task 2 · Real Google login and the Doc model

Run with `scripts/check-google.ts` on simon.harrysson@gmail.com (signed in on the vercel.app alias).

- **Refresh token arrives** via Supabase (`provider_refresh_token`) with `access_type=offline` +
  `prompt=consent`. No separate "Koppla Google Drive" flow needed. Google's tokeninfo reports
  `email profile …/drive.file …/userinfo.email …/userinfo.profile openid`; `drive.file: true`.
- **Named ranges do not grow at their edges.** Typing at the very start of a range or right after
  its last character lands **outside** the range (range text unchanged); typing in the middle lands
  inside.
- **Enter inside a range does not split it:** the range stays one part spanning two paragraphs
  (`"Punkt två: vem\n bYokar lokalen"`).
- **`replaceNamedRangeContent`** changes only the target: neighbour ranges untouched, a human
  character just outside the target (the "X" at its start) kept, target still a named range.
- **Stale `requiredRevisionId`** → HTTP 400 `The required revision ID '…' does not match the latest
  revision.`; `isRevisionConflict` matches it.
- **Appends with `endOfSegmentLocation`** while Simon typed in the transcript tab: 25/25 OK, his text
  intact, but the first line was glued onto his paragraph (`…prata om [16:29:54] Talare 2: rad 1`)
  because he was typing on the last line.
- **Revision guard under continuous typing** (2 min, a read→write every 10 s, 4 immediate retries):
  12 ticks, 8 first try, 3 after retries, **1 failed after 4 retries** (tick 1, 5 conflicts),
  9 conflicts in total. Simon's text fully intact.
- **Share** as writer with `sendNotificationEmail=false` to simon@harrysson.co: permission created,
  **no email arrived** (checked in the inbox), and the Doc showed up in that account's Drive
  "Shared with me", shared by simon.harrysson@gmail.com.

Changed in later tasks (docs/plan.md updated):
- **Task 9:** human-edit detection compares the **whole paragraph(s)** containing an item's range with
  what we last rendered, not only the range text (edge inserts fall outside the range); a range may
  span several paragraphs after Enter, and the locked text is all of them.
- **Task 6:** `appendTranscript` prefixes `\n` when the transcript tab's last paragraph is non-empty.
- **Task 10 / Global Constraints:** a random 150–600 ms backoff before each read→write retry, rather
  than immediate retries.

## 2026-11-24 · Task 2 · Session cookie must not carry Google tokens

- `exchangeCodeForSession` returns a session with `provider_token` / `provider_refresh_token`, and
  `@supabase/ssr` saves the whole session in the `sb-…-auth-token` cookie (JS-readable by default,
  400-day max age). Changed: the callback re-saves the session with
  `setSession({access_token, refresh_token})` after storing the Google token (drops the provider
  fields), and the server client sets `cookieOptions: { httpOnly: true }` (we have no browser client).

## 2026-11-24 · Task 9 · Rendering notes items (automatic part)

Run with `scripts/check-notes-render.ts … auto` on simon.harrysson@gmail.com, 27/27 checks passed. The human part
(Simon edits, deletes and types during a render) is pending.

- Item lines with `☐`, `✓`, å/ä/ö and an emoji read back exactly as rendered (paragraph text = range text =
  `formatItem`), so a fresh render never looks like a human edit.
- **An API insert right after an item does not grow that item's range**, even with a
  `replaceNamedRangeContent` on the same item in the same batch (insert runs first, highest index first).
  New items are inserted as `"\n<line>…"` just before the previous paragraph's newline.
- Paragraphs split off a `HEADING_3` anchor inherit the heading style; one `updateParagraphStyle`
  (`NORMAL_TEXT`) on the new paragraphs fixes it. After an item they inherit the item's style.
- Deleting a paragraph plus `deleteNamedRange` leaves no range behind. The tab's last paragraph is removed
  by deleting from the newline before it; a delete and an insert at that same index work in one batch
  when the delete runs first; the heading above keeps `HEADING_3` and the new item is `NORMAL_TEXT`.
- A render with a stale revision returns `'conflict'` and writes nothing.

## 2026-11-24 · Task 9 · Rendering notes items (human part)

The edits were made in the Google Docs editor (in Simon's browser, at his request) on a `setup` Doc with 5 items,
followed by `inspect` → `tick` → `inflight 10` → `inspect`.

- **Edit in the middle** ("stora " in "☐ Simon: boka lokal (fre)"): the text landed inside the range, and the item was locked with the
  human text.
- **Text typed right after a line's end** (", i Kårallen"): the text landed outside the range (the range stayed `[48,88)` over the original text),
  and the whole-paragraph diff locked the item. This confirms the Task 2 edge rule.
- **Enter in the middle of a line**: one range spanned both paragraphs, and the item was locked with both
  (`"☐ Åsa: beställa 😀-tröjor i alla \nstorlekar"`).
- **Line deleted including its line break** (backspaces): the named range was **gone completely** (no entry left, not
  an empty range), so the item went to `deleted`.
- **`tick`** reworded every item it was allowed to touch: the locked items were kept verbatim (PASS ×3), and the deleted n2 was not re-added (PASS).
- **`inflight 10`** (4 sentences typed on a new line at the end while a render was in flight): attempt 1 `conflict`, attempt 2 `ok` about 2 s
  later. The typed paragraph was fully intact.
- **An edge character deleted and retyped** (the final ")" of the "now" line): the range **shrank** to `[195,230)`, one character
  short of its paragraph, and the ")" now sits outside the range. The diff did not lock the item (its paragraph is unchanged), and the shrunk-range guard
  skipped it, so the "now" item is **frozen**: the ticks did not add their " · t1"/" · t2" to it. This is the
  documented fail-safe. Consequence for Task 8/10: a frozen "now" item only updates if Claude makes a new "now" item.
  Task 10 could detect `rangeText ≠ paraText` on the "now" item and, for example, retire it, so that Claude gets a new id.

## TODO: retention cleanup job (privacy page promise)

/integritet says usage records (`usage_daily`) and the org-creations log (`org_creations`) are kept 24 months to prevent abuse.
Nothing enforces that yet: a scheduled cleanup (e.g. in the daily cron) must delete rows older than 24 months, or the page must be changed.

## 2026-11-24 · Task 6 · Starting a meeting (createMeetingDoc, appendTranscript)

Run with `npm run check-start-meeting` on simon.harrysson@gmail.com, member simon@harrysson.co.

- `drive.files.create` with the Doc mime type and `parents: [folder]` creates the Doc inside the org
  folder in one call (no separate move). The folder lookup `name=… and 'me' in owners and trashed=false`
  under drive.file finds the folder the app made earlier: a second run reused it (exactly one folder).
- The new Doc's one tab is `t.0`; `addDocumentTab` as the last request of the same batchUpdate returns
  its tab id in `replies.at(-1)`. Header range text equals `header_rendered` exactly; four HEADING_3.
- Share as writer with `sendNotificationEmail=false`: permission list shows owner + writer, no email.
- `appendTranscript` after a person typed on the last line (`jag skriver här`) puts our line on its own
  line (the `\n` prefix); in an empty tab no prefix. Our own appends end in `\n`, so the tab's last
  paragraph is empty for the next append.
- `meeting_events.kind` needed `'started'` (migration 0007, widening only).
- No DB unique index for "one live meeting per org": existing DB tests seed several live meetings per
  org. The route checks first (409); two simultaneous starts could both pass (Doc orphaned, two rows).

## 2026-11-24 · Goal "Starta möte end to end" · first Testmöte on prod

Hook & Look Golf → "Testmöte" on simonsays.harrysson.co (deploy 6b87e51): the fictional 10-min board meeting
(`fixtures/notes/synthetic.jsonl`) replayed at 4× through the real ingest → tick → Doc path.

- **Timeline:** started 22:32:30, ticks ok at ~22:33, 22:34, 22:34:50, status `ending` 22:35:30, `done` by 22:35:59 —
  **≈ 3.5 min** end to end, inside one 300 s function (no cron rescue needed). 70/70 segments written to the
  Transkript tab, 17 notes items, events `test_started, tick_ok ×4, ended`.
- **Doc:** header `Avslutat 22:35`; Närvarande 4 names (seeded speaker_map → names, not labels); 5 decisions (✓),
  8 to-dos with owner and due; transcript lines `Karin Ek 00:00:06: …`.
- **Quality:** the fixture's trap "Daniel watches the grant — no promises" became a to-do ("Bevaka när kommunens
  ansökan om bidrag för bryggor öppnar"). Prompt tuning item (Task 8 real-data gate / AMI tuning).
- **Ticks are sparse at 4×:** the 45 s real-time tick floor means ~3 ticks for 10 min of meeting; in a real-time
  meeting there are ~13. Fine for the test; not representative of churn.
- **UI:** the "Ett möte pågår" banner on the org page wraps the Doc link onto its own line with the trailing "."
  orphaned on the next line (inline link rendered as a block).

## 2026-11-25 · Task 7 · Verify on 11-28 (real ElevenLabs)

The live page, `LiveStream` and the parser were built against `scripts/fake-elevenlabs.ts` (`npm run fake-el`),
which speaks the plan's provisional event model. Every line below is an assumption to check against the first
real session (Task 0 spike); fix `lib/elevenlabs/events.ts`, `fixtures/elevenlabs/provisional.jsonl` and the fake
together when one is wrong.

- [ ] **Token as query param:** `wss://api.elevenlabs.io/v1/speech-to-text/realtime?…&token=<single-use>` is accepted (no header needed).
- [ ] **URL settings accepted:** `model_id=scribe_v3_live`, `diarize`, `multilang_mode`, `include_timestamps`, `include_language_detection`, `audio_format=pcm_16000`, `commit_strategy` — no `input_error` on connect.
- [ ] **Audio format:** `{message_type:"input_audio_chunk", audio_base_64, commit:false, sample_rate:16000}` with 100 ms chunks (1600 samples, 3200 bytes, little-endian) is accepted; `commit:true` on a 100 ms silence chunk commits (pause, stop).
- [ ] **Burst replay:** up to 60 s of held audio (600 chunks) sent at once right after a reconnect is accepted (no `rate_limited`, `queue_overflow` or `chunk_size_exceeded`) and transcribed in order.
- [ ] **First message:** `session_started {session_id, config}`.
- [ ] **Partials:** `partial_transcript {text}` (display only; we ignore any `words` on it).
- [ ] **Commits:** `committed_transcript {segment_index, text}` with no speaker; `segment_index` counts from 0 per session.
- [ ] **Timestamps event:** `committed_transcript_with_timestamps {segment_index, text, language_code, words[]}` — we read only `language_code` from it (per segment).
- [ ] **Diarization per word:** `diarized_transcript {segment_index, words:[{text, start, end, type:"word"|"spacing", speaker_id}]}` arrives after the commit, keyed by the same `segment_index`; times in **seconds**, session-relative; spacing tokens carry the whitespace. Measure the diarized latency after the last audio (Stopp waits 3 s: `STOP_DRAIN_MS`).
- [ ] **Speaker label format:** `speaker_id` like `"speaker_0"`, stable within one session, restarting on a new session.
- [ ] **Merges:** `speakers_merged {from_speaker_id, to_speaker_id}` (the parser also takes `from_speaker_ids[]` / `into_speaker_id`). Does it appear at all?
- [ ] **Session end:** `session_time_limit_exceeded {error}` then the socket closes when `max_session_duration_seconds` is reached; does any other "session ended" message exist?
- [ ] **Errors:** error messages are `{message_type:"<kind>", error}` (`auth_error`, `quota_exceeded`, `commit_throttled`, `insufficient_audio_activity`, …) and fatal ones close the socket.
- [ ] **Idle while paused:** Paus sends no audio but keeps the socket open. Does ElevenLabs close an idle session (and after how long)? The page reconnects on Fortsätt, so a close is harmless; note the time.
- [ ] **Reconnect behaviour:** a socket killed mid-run (Wi-Fi off 10 s) — does a new session with a new token work immediately (server mints with `closingSessionId`), and do labels restart?
- [ ] **Commit timing with `commit_strategy=vad`:** how long are segments; are partials frequent enough for the strip?
- [ ] **Browser audio:** Chrome and Safari give the AudioWorklet 48 kHz (or 44.1 kHz) and the 100 ms blocks resample to exactly 1600 samples; Safari's AudioContext runs when started from the Start/Fortsätt click.
- [ ] **Hidden tab / lid closed:** segments keep arriving while the tab is hidden for 10 min (flush and heartbeat are also driven from the audio callback), and the screen wake lock is re-acquired on return.

How to try the page against the fake (no credits): `npm run fake-el` in one terminal,
`ELEVENLABS_WS_URL=ws://localhost:8787/v1/speech-to-text/realtime npm run dev` in another (the override is ignored when
`NODE_ENV` or `VERCEL_ENV` is production, and the token route then skips the real mint). `curl localhost:8787/drop`
simulates a network drop; `npm run fake-el -- --session-limit 60` ends every session after a minute.
