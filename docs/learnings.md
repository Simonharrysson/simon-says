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

## Retention: usage records are kept (decision 2026-11-25)

Simon, 2026-11-25: "dont delete records older than 2 years". `usage_daily` and `org_creations` are kept as long as the
service runs; /integritet says so. Migration 0015 and `cleanup_retention()` (and `lib/retention.ts`) still exist but
nothing calls them, so the daily alarm cron only sends the summary email. `usage_daily` has no FK to `orgs` (dropped in
0003), so a deleted org's rows keep a dangling `org_id`; it is not set to null. Do not wire the cleanup back in without
changing /integritet first.

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
- [ ] **Stalled socket watchdog (`SILENT_SOCKET_MS` = 60 s, final fix wave C3):** a socket that sends nothing for 60 s
  while we sent ≥ 5 s of speech-level audio (rms > 0.15) *within those 60 s* is treated as dropped and reconnected.
  Every message gap > 10 s is logged in the console (`[live] socket: message gap N ms`): read them on 11-28 to see the
  real partial cadence, whether there is a keepalive, and whether Chrome/Safari fire `close` after a lid close; tune
  the 60 s and the 0.15 level. (Each reconnect books a full session hour since Ruling 39, so storms are expensive.)
- [ ] **session_started before audio (C12):** held audio is sent only after `session_started` (or the first message, or
  3 s after open). Check that `session_started` really is the first message.
- [ ] **Fatal errors (C5):** which `message_type` does ElevenLabs send when the quota is used up, the API key is bad or
  terms are unaccepted? The page stops on quota/terms/billing-like types at once and on `auth_error` twice in a row.
- [ ] **Undiarized fallback:** a committed segment whose `diarized_transcript` never arrives (drop, session end, Stopp
  after the 3 s drain) is posted as one run with speaker `unknown`. Check how often that happens with real latency.
- [ ] **Mic recovery:** after sleep, Safari reports the AudioContext as `interrupted`/`suspended`; the watchdog resumes
  it after 5 s of no audio, then reopens the mic. Check that a reopen outside a click works in Safari and Chrome.
- [ ] **Hidden tab / lid closed:** segments keep arriving while the tab is hidden for 10 min (flush and heartbeat are also driven from the audio callback), and the screen wake lock is re-acquired on return.
- [ ] **Can ElevenLabs end a session server-side?** (Ruling 39, final fix wave A1.) Today a session closed early (reconnect,
  Avsluta, sweep) is booked at its FULL granted length (`max_seconds`, ≤ 1 h), because the old socket could keep
  streaming — and billing — until then. Every meeting therefore books whole granted hours against the 20 h/month (a
  10-minute meeting costs 60 minutes of it). If ElevenLabs has an API to terminate a realtime session (or a single-use
  token's session), call it on close and revert `close_el_session` to booking actual seconds (migration 0017).
- [ ] **Hourly rollover:** sessions are granted at most 1 h, so every hour `session_time_limit_exceeded` closes the socket
  and the page mints a new session: check the gap (audio is held in the ring buffer and replayed) and that the new
  labels show as "Vem är detta?" in the list without reopening the name round.

How to try the page against the fake (no credits): `npm run fake-el` in one terminal,
`ELEVENLABS_WS_URL=ws://localhost:8787/v1/speech-to-text/realtime npm run dev` in another (the override is ignored when
`NODE_ENV` or `VERCEL_ENV` is production, and the token route then skips the real mint). `curl localhost:8787/drop`
simulates a network drop; `npm run fake-el -- --session-limit 60` ends every session after a minute.

## Name round (Task 11, 2026-11-25)

- [ ] **Verify on 11-28:** does ElevenLabs' `infer_speaker_names` (Task 0) send `speaker_names` events we could use
  before Claude? v1 uses Claude only (`lib/names/extract.ts`); if EL's names are good, use them first and Claude as
  the fallback for labels it didn't name.
- Real check (`npm run check-names`, synthetic fixture's first 2 min): 4/4 names right in 2.5–3 s, ~1 600 input /
  155 output tokens, ≈ $0.01 per round. The tick gives the call 30 s.
- Known people win over what was heard: with "Leila Nassar" in the list, "Leila Nasser" is returned as "Leila
  Nassar" (one letter off, unique candidate). Intended (the list is the förening's spelling), but a wrong list entry
  wins too — rename in the speaker list.


## 2026-11-25 · Goal 2 · Testmöte with the name round on prod (deploy f6bc2e4)

- Two Testmöten after the final deploy (15:33 and 15:44): both `done` with "Avslutat", 70/70 transcript lines,
  16 notes items, ≈ 3.5 min end to end. The name round (Claude, 2.9 s) named all four fictional speakers from the
  transcript itself — no seeded names; the transcript tab waits for it, so every line carries a name.
- The tuned prompt (Task Q) held on prod: the "no promises" grant item no longer becomes a to-do.
- Claude per Testmöte ≈ $0.07 (4 ticks + name round).
- Prod migrations 0014–0022 applied the same day; the first `vercel deploy --prod` after them answered
  "Not authorized" once (CLI still logged in) and the retry worked — retry once before investigating.
- The checklist for the day ElevenLabs credits return is `docs/checklist-11-28.md`.

## 2026-11-25 · Meeting formats A1 · The agenda Doc model

Measured with `npm run check-agenda-render -- simon.harrysson@gmail.com build|auto` (`scripts/check-agenda-render.ts`) on a fictional
Veckomöte Doc, each measurement on a fresh Drive copy. A measurement script, not a test. Fixtures:
`fixtures/agenda/veckomote.doc.json` (item 5 "Ekonomi" is a list item) and `veckomote-h3.doc.json` (item 5 is a
`HEADING_3` "5. Banbokning", not a list item). Both are `documents.get` dumps (`includeTabsContent`, `SUGGESTIONS_INLINE`).
The human-editor stage is at the end of this entry. Glyphs/numbers quoted below ("6.", "c.") are computed by the script from list order, level and the list's glyph format (same `listId`); the API returns no rendered number.

**Doc shape.** The list is one list: `NUMBERED_DECIMAL_ALPHA_ROMAN`, level 0 `DECIMAL "%0."` (indentStart 36, firstLine 18), level 1
`ALPHA "%1."` (72/54), level 2 `ROMAN "%2."` (108/90). Items 1-6 level 0, "Kommande event" has two level-1 sub-bullets (a., b.), same
`listId` for all eight paragraphs. Info table is a real table (4 rows x 2 columns: label | value). `lists[id].listProperties.nestingLevels`
is on `lists[id]` directly (not under `.list`, which is the Schema type's name). Numbers/glyphs are never in the text: they are computed
from the list order and level.

- **M1 insert `"\n<line>"` before item 5's newline:** the new paragraph is in the same `listId`, `nestingLevel` 0, `NORMAL_TEXT`. Everything
  after it renumbers (Övrigt 6. becomes 7.). The text read back is the label only.
- **M2a (`"\n\t<line>"` then `createParagraphBullets` on the new paragraph) FAILS on an already-bulleted paragraph.** The inserted paragraph is
  already a level-0 item of the human list, and `createParagraphBullets` on it changes nothing: the `\t` stays as literal text
  (`"\tM2a rad"`), level 0, same list, so it is a new numbered top-level item and renumbers the rest. No index shift (nothing removed).
- **M2b (insert after the item's last nested sub-bullet) WORKS:** new paragraph inherits level 1, same `listId`, glyph `c.`, top-level numbering
  unchanged (Ekonomi 5., Övrigt 6.).
- **M2c (`deleteParagraphBullets` + `updateParagraphStyle indentStart 54 / indentFirstLine 36` + `"– "` prefix) WORKS:** non-list paragraph, top-level
  numbering unchanged, and Övrigt keeps the human `listId`. The `deleteParagraphBullets` + style + insert sequence needs no index
  adjustment as long as the `"– "` insert goes last.
- **Decision (NESTED_INSERT):** (b) when the item already has a nested sub-bullet (insert after the last one, text = `"\n<line>"`, no tabs, no
  bullet request); (a) never works on a bulleted paragraph, so skip it; (c) for an item with no sub-bullet (for those the line is a plain
  paragraph with a `"– "` prefix and indent 54/36, written as the sequence above). Once our first line exists under an item via (c), the next
  line goes after it the same way (the item then has no list sub-bullet). No request that changes the `nestingLevel` of an existing
  list paragraph was found (only M2a was tried; not exhaustively searched).
- **Tab handling elsewhere:** `createParagraphBullets` on a **non-list** paragraph does remove leading tabs and uses them as the nesting level
  (`"\t\tdjup"` after `"rot"` gave `rot` level 0 and `djup` level 2: N tabs = level N), but it always makes a
  **new list** (different `listId`, glyph `1.`). That is useless for joining the human's list.
- **M3 insert after a `HEADING_3` item:** `"\n<line>"` gives a paragraph that inherits `HEADING_3` (not a list item, no run overrides: `bold`/`fontSize`
  absent). After `updateParagraphStyle NORMAL_TEXT` + `createParagraphBullets BULLET_DISC_CIRCLE_SQUARE` it is level 0 of a **new list**
  (`●`, indentStart 36), different `listId` from the numbered list; the heading stays `HEADING_3`. Note in the variant Doc the numbered
  list continues across the heading: Övrigt shows `5.` there (same `listId`, the heading is not a list item).
- **M4:** paragraph text of every list item (levels 0 and 1) equals its label exactly: no glyph, no number, no leading tab. `parseNotesTab`
  reports the same texts, so `last_rendered_text` comparisons are safe.
- **M5 named range over a list item:** after typing `XX` in the middle the range grows with it (`"Må-XXrunda"`, paragraph text equal); deleting only
  the text (newline kept) removes the range entirely; deleting the paragraph including its newline removes it too, and the numbers after it
  close up (3. becomes 2. ...). In both cases `itemSpan` returns null and no range entry is left.
- **M6 table cells:** `insertTable` (rows 4, columns 2) at an empty paragraph puts an extra empty paragraph **before** the table that cannot be
  deleted (`Invalid deletion range`), and keeps one empty paragraph after it. Cell paragraphs: first cell paragraph starts at tableStart+3;
  inside a row the next cell's paragraph starts at the previous cell paragraph's end + 1; the next row's first cell starts at the previous
  row's last cell paragraph end + 2. An empty cell's paragraph is `[s, s+1)` (just the newline). `insertText` at `s` + `createNamedRange [s, s+len)`
  in the same batch works; the range text equals the cell text; `replaceNamedRangeContent` replaces it and the range follows (`[51,71)`,
  cell text updated). All indices after an insert shift by the inserted length (the Sekreterare cell moved 67 to 93). `parseNotesTab` **skips**
  `el.table` (cell text absent from `paragraphs`; the range itself is listed in `ranges`, but `itemSpan` for it is null: there is no paragraph).
  A5/A7 must read cells from the `table` element, not from `paragraphs`.
- **M7 one batch** (`insertText`, `createParagraphBullets`, `createNamedRange`, `writeControl.requiredRevisionId` from a fresh `get`): accepted, all
  replies returned. Requests apply in order: a range created **after** `createParagraphBullets` uses post-removal indices (a range
  `[ns, ns+len)` computed with the tab ended on the paragraph's newline: `"M7c rad\n"`; `[ns, ns+len-1)` was the exact label), a range
  created **before** it follows the tab removal (label-only range `[ns+1, ns+1+len)` ended up exactly on the label after the tab was gone).
  On a list paragraph (M7a) no tab is removed at all, as in M2a.
- **M8 headings:** `"\n<text>"` at the end of a `HEADING_1` gives a `HEADING_1` paragraph (inherits); a new paragraph after an explicit `HEADING_2` is
  `HEADING_2` too. So every appended heading and every body line needs an explicit `updateParagraphStyle` (headings `HEADING_n`, text
  `NORMAL_TEXT`). `"<text>\n"` inserted at the **start** of the NORMAL_TEXT paragraph that follows a `HEADING_1` gets `NORMAL_TEXT` (so the LIVE
  line directly after "Anteckningar:" can be written that way, if there is a paragraph after the heading; at the end of the tab, insert
  `"\n<line>"` and reset to `NORMAL_TEXT`). No run-level bold/fontSize overrides appear in any of these.

**What this changes in the plan:** A6's nested insert must not use tabs + `createParagraphBullets` on a list paragraph; use (b) / (c) above. A7's
info-table prefill must read cell indices from the table element and re-read between inserts (or fill from the last cell backwards).
A5's `Paragraph`-based scan needs table cell paragraphs separately; cell anchors need a whole-cell text diff and a cell-aware span reader. Sub-items in a skeleton need tabs + ONE `createParagraphBullets` (removes the tabs, one new list; create ranges after it, M7c). `insertTable` leaves an undeletable empty paragraph before the table. Our `"– "` lines (c): range covers the whole paragraph including the prefix (Ruling R-A1); a human re-indent changes no text, so never re-apply levels; find "after the item's last paragraph" by list position/level.

**Human stage (controller typed in the Docs editor, 2026-11-25):**
- **Enter at the end of our bullet + typing** ("Manniska 1" after "Claude A"): the new paragraph is a human sibling at the same level
  (list1/lvl1, next letter); our range `ss-a1-A` stays exactly "Claude A" and `itemSpan` is unchanged (rangeText = paraText) — not locked.
- **Tab on our bullet** ("Claude B"): nesting level 1 → 2, text, range and `itemSpan` unchanged. **The text diff does not see indent
  changes**, so a human re-indent does not lock the item — the renderer must never re-apply or "fix" a level on an existing item
  (only new inserts choose a level).
- **New line typed after another of ours** ("Manniska 2" after "Claude C"): human sibling after our item; our range unchanged.
  → v1's rule holds in lists: text typed at a range's edge or on a new line lands **outside** the range. For "ours go after the human's
  last paragraph of the item", A6 must find the item's last paragraph by list level/position, not by our last range.
- **Table cell edited at both edges** (", Cecilia" at the end, "X" at the start of the filled Närvarande cell): range `ss-a1-cell`
  stays "Anna Svensson, Bo Karlsson"; the cell text is "XAnna Svensson, Bo Karlsson, Cecilia". Same edge rule as paragraphs →
  cell anchors need a **whole-cell text diff** against what we rendered (lock on any difference); `itemSpan`/`parseNotesTab` skip
  tables, so A5/A7 need a cell-aware span reader.
- One list id throughout (`distinct listIds: 1`): human Enter and Tab stay in the ordförande's list.

**Task A6 render check (automated part, 2026-11-25; `check-agenda-render … render` then `tick`, fresh copies of the A1 Doc):**
One `planFormatRender` batch through `renderItems` (revision-guarded), 9 rows (2 notes, a decision, 2 Kassör tasks + 2 `-t` copies,
a note in `notes`, Närvarande in the empty cell):
- (b) under "Kommande event" (has sub-bullets): our three lines became `list1/lvl1` c., d., e. in the human list, indent 72/54
  like the human's a./b. (c) under "Ekonomi" (no sub-bullets): plain paragraphs, no list, indent 54/36, `"– "` inside our range.
  Copies: plain `NORMAL_TEXT` after "Ordförande: Boka lokal.", the two Kassör copies together. Närvarande cell filled, range = cell.
- Top-level numbering unchanged (1.–6.), one `listId` in the whole Doc, every row `ownedSpan` non-null, and an immediate re-plan
  gives **0 requests**. The header replace worked.
- `tick` without human edits (rewording every item, one new note under ag-4 and ag-5): all replaced in place (levels and the
  `"– "` prefix kept), the new ag-4 line became f. after our e., the new ag-5 line a third `"– "` line; numbering unchanged,
  0 requests on re-plan.
- (b) inherits the level of the block's LAST paragraph, so (fix round 1) it is used only when that paragraph is exactly one level
  below the item; after a deeper point (a human's sub-sub-point, or ours after a human Tab) the line is written (c)-style instead.
  Every new line of ours also gets an `updateTextStyle` clearing bold/italic/underline/strikethrough/link (inserted text inherits
  the previous character's style), and a run of ours deleted at the end of the tab after a human paragraph keeps that newline.
- Human stage (sub-bullet under ag-5, edit a copy, Tab on one of ours, then `tick`): run by the controller — result below.

**A6 human stage (controller typed in the Docs editor, 2026-11-25):** on the A6 render Doc — Enter+Tab after "Ekonomi" (human
sub-point lands *before* our "– " lines), " Klart!" appended to our tasks-section copy of a task, Tab on our nested line under
"Kommande event" — then `tick`: only the edited tasks copy (`n4-t`) locked; the same task's copy under Ekonomi kept updating
(one copy locks, the other follows); the human sub-point intact and our new line went **after** everything in the item's block
(human + ours); the Tabbed line stayed at level 2, unlocked and reworded; numbering 1–6 unchanged, one listId, re-render 0 requests.

**Task A7 fallback check (2026-11-25; `check-agenda-render … fallback veckomote|styrelseprotokoll|bare`, new Docs via
`createFormatDoc` in the folder "Simon Says – Fiktiv förening A7", then `anchorAgenda` with `rolesFromSkeleton`, then one render):**
- Skeleton: one text insert at 1, paragraph styles, ONE `createParagraphBullets NUMBERED_DECIMAL_ALPHA_ROMAN` (Veckomöte) and
  `insertTable` last; the cells filled in a second batch from a fresh read. As M6 says, the table gets an empty paragraph before
  and after it. Veckomöte: H1 title, 4×2 table, H2 "Agenda", items 1.–5. in one list (Godkänn dagordning, Må-runda, Från förra
  veckan, Övriga punkter, Övrigt), H2 tasks, H2 "Anteckningar". Styrelseprotokoll: H2 "Dagordning", 9 `HEADING_3` "§1 …"–"§9 …"
  items, H2 "Att göra", the three signature lines.
- `scanAgenda` finds 5 (resp. 9) items with keys matching `rolesFromSkeleton` (checkin = Må-runda, followup = Från förra veckan /
  Föregående protokoll, topic = Övriga punkter). Every anchor range's text is exactly the item line ("§7 Övriga punkter" for
  paragraph numbering: the range covers the typed "§n", the scan label drops it). The returned `revisionId` equals a fresh read's.
- LIVE line: NORMAL_TEXT directly under "Anteckningar" (Veckomöte), or at the end after the signatures (Styrelseprotokoll, no notes
  section); never inside an agenda item. Datum/Tid filled (Stockholm), Tid in `ss-<m>-info-tid`; other cells untouched.
- `bare` (Doc ends in the numbered list item "Övrigt"): the appended "Vad ska vi göra till nästa gång?" + "Anteckningar" (+ LIVE)
  come out `HEADING_2`/NORMAL_TEXT with **no** listId (`deleteParagraphBullets` on our new paragraphs; the human list keeps 1.–5.).
- Render on the anchored Doc: (c) lines under "Övriga punkter" in the list Doc; under a `HEADING_3` item a new bullet list (●);
  task copies in the tasks section — in Styrelseprotokoll **above** the signature lines (the `signatures` anchor ends the tasks
  block); Närvarande in the empty cell; one listId, every row owned, re-render 0 requests.
- `fallback testmote` (A13's shape: own items, "Kommande event" with two sub-items, Datum + Sekreterare pre-filled, transcript tab):
  sub-items `list1/lvl1` a./b. in the items' list, no tab left in any text, read as the item's humanText; the pre-filled Datum and
  Sekreterare untouched by anchoring (Tid filled); transcript tab created; render under "Kommande event" went (b): our lines carry no "– " prefix (joined the sub-item list).
- Fix round 1 (`reanchor veckomote|styrelseprotokoll`: `anchorAgenda` again on the rendered fallback Docs, as a new meeting and then
  again as the same meeting): one status line each time (the old "uppdaterad 19:24" line reused and reset to "uppdaterad –" in the
  new range), Tid "19:24" ranged again as `info-tid`, no ambiguous range, Styrelseprotokoll signatures still anchored on
  "Mötesordförande: ____" with our task copies above them.
- Fix round 2 (`reanchor` again, real Docs): Tid is ours only when one of our `ss-*-info-tid` ranges covers exactly the cell text;
  then it is rewritten at anchoring (here "19:24" → "19:48"). The status line is replaced through its `ss-*-header` range only;
  one status line, no ambiguous range, signatures still anchored.

## 2026-11-25 · Meeting formats A10 · Starting in an agenda Doc or a format Doc

- **Order of a start (F14).** Org checks, `already_live`, the per-starter limits, then the format (read only), Google auth, and
  in agenda mode `checkAgendaDoc` → `agenda_used` (any org's live/ending meeting on that Doc, service role) → `anchorAgenda`
  (its scan throws `AgendaShapeError` before its batch, so "no items" writes nothing). Then the meetings insert (with
  `format_profile_id` null when a standard `formatKind` was asked for) and `guard_meeting_start`. Only after the guard passed:
  `ensureStandardRow` + an update of `format_profile_id` (on failure the row is deleted and the start answers `save_failed`:
  a meeting never runs under the wrong format), then the optional Transkript tab + an update of `transcript_tab_id` (soft: a
  failure is logged, the transcript stays in the DB). No refusal writes to the DB or the Doc; anchoring is the one Doc write
  before the guard.
- **Accepted race (F14).** The route-level pre-check runs before anchoring, as in v1, but the atomic check is the guard after
  the insert. When two starts by the same person race (or the hourly limit is hit in between), the guard deletes the losing
  row **after** its Doc was anchored: the förening's agenda Doc keeps our LIVE line, any appended headings, the filled
  Datum/Tid cells and `ss-<lostId>-…` named ranges (invisible). A later meeting on the same Doc reuses the status line and
  rewrites our Tid (A7's idempotent re-anchoring), so the leftovers are harmless; low probability (one person, two starts
  within seconds). Not fixed on purpose: moving the guard before anchoring would need a reserved row and a second cleanup path.
- **Guard RPC error (pre-existing in v1).** If the `guard_meeting_start` call itself errors after the insert, the start throws
  (500) but the inserted row stays `live`, and in format layout the Doc is already anchored. The starter then hits
  `already_live`/`starter_busy` until that meeting is ended; v1 had the same gap with its new Doc.
- **Från förra veckan at start (answer 3).** After the guard, `info-tid` (from anchoring, with its range) and the carried rows
  (`c1…`, `range_name null`, `meeting_id` set by us) are inserted with a plain service-role insert (no tick lease yet, so not
  `save_note_rows`), rendered with `renderItems(…, { plan: planFormatRender, profile, ownerLabel })` against a fresh read
  (anchoring and the Transkript tab moved the revision), conflicts retried 4×, and only `range_name`, `last_rendered_text`,
  `position` written back. A failure there is logged and the meeting goes on: the first tick renders unrendered rows.
  The event is `followup_prefilled { count, rendered }` (`rendered: false` = saved but left for the first tick).
- **Privacy.** `agenda_anchored` logs `{ items, appended, roles }` as counts and `ItemRole` values; the appended labels go
  only into the API response (a learned profile's labels are the förening's text).
- **Old Testmöten (0026).** `meetings.is_test` came in 0023 with default false; 0026 backfills it from `test_started` events
  and test ElevenLabs sessions (`backfill_test_meetings()`, service role, idempotent) so a pre-0023 Testmöte is never the
  "previous meeting" of a real one.
- **Drive 403s.** `checkAgendaDoc` maps a 403 to "pick it again" only for access reasons (forbidden, notFound,
  insufficient(File)Permissions, appNotAuthorizedToFile, or no reason); a rate-limit 403 (`userRateLimitExceeded`,
  `rateLimitExceeded`) or any other reason goes to `google_unavailable` ("try again").
- **Testmöte med dagordning (A13).** The fictional test agenda Doc goes into the org meeting folder when the starter's
  grant can write there, so it inherits the folder's sharing: the förening's members can see the fictional test Doc
  (Ekdala Padelklubb). We add no permissions ourselves. Its title ends "(Testmöte)" and `listCandidates` skips such
  titles, so an orphaned one is never offered as a real meeting's agenda.
- **Vitest trap.** `beforeEach(() => m.fn.mockReset())` returns the mock, which vitest runs as a teardown after each test: a
  mock left rejecting then fails the test with its own error. Use a block body.

## Meeting formats A13 — agenda Testmöte on prod (2026-11-25, controller)

- Migrations: prod already had 0023–0025; 0026 (is_test backfill) dry-run flipped 4/5 meetings (all earlier Testmöten), applied via the Management API. Preview deploys use the same database (no Supabase branch).
- Deployed v1 62e298a to prod and ran "Testmöte med dagordning" twice in Simon's own test förening. Each run ≈ 1–2 min wall time, 3 ticks + end pass.
- Run A: notes under the right items; under an item with prepared sub-bullets ours nest at level 2 after them, elsewhere our "– " lines; Må-runda shows only "Må-runda genomförd." (no personal-plan traps became tasks); four tasks by role under the item and in "Vad ska vi göra till nästa gång?"; Närvarande filled from the name round, Sekreterare untouched; Tid "22:38–22:39"; LIVE line → "Simon Says · avslutat 22:39".
- Run B: event `followup_prefilled` before the first tick; "Från förra veckan" pre-filled with run A's four open tasks by role; the two reported done got "✓ klart" in B and `done = true` on run A's source rows (propagateDone); new decisions/tasks under Ekonomi and Övrigt; tasks section lists only B's new tasks (open carried tasks carry again next week).
- Observed: a task reported "not done" gets no note of its own; acceptable for now.

## Meeting formats A14 — agenda-mode notes eval (2026-11-25)

- `notes-eval` replays a fixture with an `agenda` in its expected file (veckomote-a/-b) the way `lib/meetings/tick.ts` does: the tab is the agenda Doc's lines (labels + sub lines) plus our items as `formatLine` writes them (owner shown by role), `ownLines` are those lines, last meeting's tasks are pre-filled as `c1…`, `updateNotes` gets `agenda` from the fixture. Må-runda: the detector (`detectCheckin`, `checkSpend: false`) reads each tick's unsent lines while the window is open, `nextWindow` counts failures, `maskCheckin` masks per tick; start unknown and no answer holds the notes call, the end pass over-masks with `endPassWindow`; a tick without new lines makes no call. Detector cost is part of the run's `$` and the ledger. v1 fixtures replay exactly as before.
- New bars (agenda fixtures only): placement ≥ 90 % (decision/task under its expected agenda key), roles exact (owner's role label), followup exact (carried `done` flags), no Må-runda leaks (final or live item matching `checkin.match`, or anything not carried under a checkin/followup item). `--check` also rejects an expected anchor missing from `agenda.items` (or on a checkin/followup item), an `ownerLabel` the `people` do not give, and a `checkin.match` that hits an expected item.
- `--ledger <file>` keeps the spend ledger per eval (A14 uses `.notes-replay/spend-formats.json`).
- Not replayed: the server rows (Närvarande, Tid, "Må-runda genomförd."), the copies in the tasks section, `MAX_NEW_BLOCKS`, human edits of the Doc during the meeting.
- Numbers (2026-11-25, 2 runs each, claude-opus-5-5): veckomote-a and veckomote-b both PASS every bar — placement 20/20, roles 14/14, followup 8/8, Må-runda leaks 0, recall 20/20, churn 0 %, must_not 0, live2+ 0; cost $0.44 total ($1.18/h over 11.3 min of meeting time; a 0.240, b 0.203). No prompt tuning needed. Ledger .notes-replay/spend-formats.json.
