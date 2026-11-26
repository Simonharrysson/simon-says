# 11-28 checklist: from "built" to the first real meeting

Everything that can be built without live ElevenLabs is built, reviewed and deployed (v1, 2026-11-25).
This is the order for the day the credits return (or a Creator upgrade). Tick as you go; write surprises
into `docs/learnings.md`.

## 0. Before you start (by hand, ~10 min)

- [ ] ElevenLabs dashboard: hard monthly spend/usage limit, no automatic overage; note the plan's $/hour and set
      `ELEVENLABS_USD_PER_HOUR` in Vercel to it (Starter 0.48, Creator overage 0.22).
- [ ] Anthropic console: monthly spend limit on the Simon Says key.
- [ ] Resend: account, verify `harrysson.co`, then put `RESEND_API_KEY` (and optionally `MAIL_FROM`) in Vercel prod.
- [ ] Supabase Auth (simonsays-prod): redirect allow-list exactly `https://simonsays.harrysson.co/auth/callback**`
      — remove `http://localhost:3000/**` and any `*.vercel.app` entry **after** step 2 (you need localhost for it);
      email signup and anonymous sign-in off.
- [ ] Vercel: `DESIGN_PREVIEW` removed in production; `KILL_SWITCH=0`; `APP_URL=https://simonsays.harrysson.co`.

## 1. Task 0 spike (ElevenLabs, ~30 min, a few cents)

- [ ] `SPIKE_ENV_FILE=~/simon-says-private/.env zsh spike/run-all.sh smoke`, then the compare / long / reconnect /
      keyterms / fixture runs as in `docs/plan.md` Task 0; write `spike/REPORT.md`.
- [ ] Walk the **"Verify on 11-28"** list in `docs/learnings.md` (27 items: event names and fields, diarization per
      word, session end, errors, burst replay, idle/pause, hourly rollover, **whether ElevenLabs can end a session
      server-side** — if yes, revert Ruling 39's full-hour booking). Fix `lib/elevenlabs/events.ts`,
      `fixtures/elevenlabs/provisional.jsonl` and `scripts/fake-elevenlabs.ts` together where reality differs.
- [ ] Re-run the notes gate on a real transcript: `npm run notes-replay` on the spike's transcript (Task 8 Step 3).

## 2. Browser click-list (Ruling 34) — first against the fake, then real

Fake: `npm run fake-el` + `ELEVENLABS_WS_URL=ws://localhost:8787/v1/speech-to-text/realtime npm run dev`,
signed in on localhost. Then repeat the starred ones on prod with real ElevenLabs.

- [ ] ★ Chrome and Safari: Starta möte → consent → Starta mötet; partials show, runs post every ~3 s, URL becomes `/meetings/<id>`.
- [ ] Mic blocked in site settings → Swedish message, **no Doc created**.
- [ ] `curl localhost:8787/drop` ×3 → "Ansluter igen…" then live; no duplicate segments per (session, segment, run).
- [ ] Second tab → "Fortsätt mötet" there → first tab says "Mötet körs i en annan flik".
- [ ] ★ Lid closed 30 s and 2 min → audio resumes or a banner says why.
- [ ] ★ Paus → nothing sent, `paused` event; Fortsätt resumes.
- [ ] Reload mid-meeting → Fortsätt mötet → timer continues, no 409.
- [ ] ★ Avsluta → "Gör anteckningarna klara…" → ended view at once; Doc says "Avslutat" within a minute.
- [ ] Avsluta with Wi-Fi off → "N rader väntar…", nothing thrown away.
- [ ] Sign out in another tab → "Logga in igen" banner; lines sent after re-login.
- [ ] USB mic unplugged mid-meeting → "Hör inget ljud" notice.
- [ ] Fake `quota_exceeded` → "Transkriberingstjänstens kvot är slut".
- [ ] After a fake session: `el_sessions.kind = 'test'` and nothing booked in `usage_daily` for it.

## 3. Short real test (you + 1–2 people, 10 min)

- [ ] ★ A real 10-minute talk on your laptop mic: name round names everyone; notes update every ~45 s; your own
      edits in the Doc survive; transcript names are right; Avsluta → "Avslutat".
- [ ] Check the cost: `/status` and `usage_daily` (expect ~1 h booked — Ruling 41 — and Claude < $0.20).

## 4. First real Hook & Look meeting (Task 14)

- [ ] Before: invite the board to the förening (invite link), tell them the Doc appears in their Drive.
- [ ] At the table: laptop on charger, lid open, consent said out loud, name round ("Jag heter …").
- [ ] After: read the notes with the secretary — what was missing, what was wrong, what was noise. Write it into
      `docs/learnings.md`; that is the input for prompt tuning and for todo #1 (learn the förening's own format).

## Voice enrolment spike (todo #5, Simon 2026-11-26: "once maximum")
- Record two fictional speakers' name-round lines; in a new EL session, prepend both samples (silence-separated) before live audio; check diarization puts each sample's label on the matching live speaker. Measure accuracy over ≥5 sessions and the extra STT seconds. Decide go/no-go.
