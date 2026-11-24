# Simon Says — UI

The design system, page structure and live-meeting components. Swedish UI, English code.
Preview everything with fake data at **`/design`** (dev only; production needs `DESIGN_PREVIEW=1`).
Screenshots: `docs/ui/` (`<state>-<width>-<scheme>.png`, fake data; the round "N" is the Next dev indicator). The design review and its captures are in `docs/ui/review/`.

## Direction: the meeting-room whiteboard, made exact

Every student-union meeting room has one: a glossy white board, an aluminium tray, four
markers and a handful of round magnets. That is the whole visual world.

- **Light = white board, dark = black glass board** (follows `prefers-color-scheme`).
- **Exactly four marker hues, nothing else carries colour:**
  black ink (text, primary actions), **blue** (links, info, action items, "who is this"),
  **green** (decisions, success, consent given), **red** (live/recording, destructive, needs attention).
  Red is kept for the hot state: if something is red, it is live or it needs you. Warnings that
  fix themselves are ink (`banner--warning`: white sheet, aluminium edge), never red. Trash icons
  in lists are ink at rest (`danger-ghost`) and turn red only on hover/focus.
- **Magnets** (small glossy dots) are the status language: badges, the wordmark, name plates,
  the steps on the landing page. A pulsing red magnet = transcribing.
- **The Google Doc keeps its own look.** Wherever we draw the Doc (landing, edit demo) it is
  white paper in a system face, so people recognise "that's the Doc", not our UI.
- Refused on purpose: AI-SaaS gradients, glass, cards-with-icons grids, eyebrow labels.

### Principles

1. **Calm in the room.** The live page sits on a table during a meeting. Few elements, big
   targets, nothing moves unless it means something (the red magnet, the listening ring).
2. **Honest state.** Notes flowing, paused, stale, Doc paused, reconnecting — always visible,
   always one sentence: what happened + what to do (often: nothing).
3. **Humans' words win.** Copy and UI never imply the service overwrites people.
4. **Destructive is deliberate.** Every delete/rotate/stop goes through a confirm dialog; deleting
   an org needs the typed name.
5. **The server decides.** The UI only offers what will succeed (e.g. no delete on live meetings),
   but every server-side error code still has a designed message.

## Tokens (`app/globals.css`)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--board` | `#f7f8f6` | `#101214` | page background |
| `--surface` | `#ffffff` | `#181b1e` | panels/sheets |
| `--surface-sunk` | `#eef0ed` | `#0b0d0e` | inset areas, hover |
| `--rail` | `#c9cdc9` | `#464c52` | control borders (aluminium) |
| `--line` | `#e2e5e1` | `#2a2e33` | hairlines |
| `--ink` / `--ink-2` / `--ink-3` | `#16181b` / `#464b51` / `#5f656c` | `#f1f2ef` / `#bcc1c6` / `#9aa1a8` | text levels |
| `--blue` (+`-wash`) | `#1d58c9` | `#86aefc` | links, info |
| `--green` (+`-wash`) | `#17703f` | `#6bd497` | success, decisions |
| `--red` (+`-wash`) | `#c62b26` | `#ff7a70` | live, danger, attention |

Contrast (WCAG, computed): every text token ≥ 4.5:1 on board, surface and sunk in both themes
(lowest: red on sunk, light, 4.85; red on red-wash 4.75). White on red button 5.56.

**Type.** Familjen Grotesk (a Swedish grotesk, Familjen agency, Stockholm) for everything;
JetBrains Mono only for measurements: timer, timestamps, speaker labels, invite link, ids.
Both via `next/font/google` (downloaded at build, served from our domain, no Google request
from visitors). Scale: 13 / 15 / **17 body** / 20 / 26 / 34 / display `clamp(38px → 64px)`.
Headings 700, tracking −0.02 to −0.03em, `text-wrap: balance`.

**Space** 4px base: `--s-1..9` = 4, 8, 12, 16, 24, 32, 48, 64, 96. **Radii** 8 (controls),
14 (panels), round (magnets, chips, badges). **Depth** one system: `--shadow-panel` (resting
sheet), `--shadow-lift` (dialogs, auth sheet, board). No border + shadow on the same element.

**Motion.** `--ease-out` = `cubic-bezier(0.16,1,0.3,1)`; 120 ms hovers, 220 ms enters.
One authored moment: the landing board's notes **write themselves** line by line (clip-path
wipe, like a marker stroke). Elsewhere: red magnet pulse (live), listening ring on the mic,
name plates dropping in. `prefers-reduced-motion` turns all of it off; content is always visible
without animation.

**Browser surfaces.** Themed selection, focus ring (2px blue, offset 2), caret, scrollbars.

## Voice (Swedish copy)

Short, warm, concrete; "du/ni"; no jargon ("transkriberas", not "processas"). Buttons name the
action ("Starta mötet", "Radera mötet", "Skapa ny länk"). Errors say what happened and what to
do ("Mikrofonen är blockerad — klicka på hänglåset… välj Tillåt"). Reassure when nothing is
needed ("Vi försöker igen automatiskt, du behöver inte göra något"). Always say the Google Doc
stays in Drive when deleting.

## Primitives (`components/ui/`)

| Component | Notes |
|---|---|
| `Button`, `ButtonLink` | `variant`: primary · secondary · ghost · danger · danger-quiet · danger-ghost (list trash icons); `size` sm/md/lg; `loading` (spinner, aria-busy, disabled); `icon`; `iconOnly` (label becomes visually hidden + title); `block`. |
| `SubmitButton` | Button + `useFormStatus` → loading while its form's server action runs; `pendingLabel`. |
| `Field`, `Check` | Label/hint/error wired with `aria-describedby` / `aria-invalid`; `Check` = checkbox with title + explanation. |
| `Banner` | `tone` info/success/warning/danger/neutral, `title`, `action`; role alert for warning/danger, status otherwise (`live={false}` for static). |
| `Badge` | magnet + label; tone neutral/live (pulses)/alert (static red, "needs you")/success/info. |
| `EmptyState` | dashed outline, title, body, optional action. |
| `Panel` | sheet with title/actions; `flush` for edge-to-edge lists. |
| `ListRow` | leading · title/meta · actions; `href` makes the row a link. Use in `<ul class="list">`. |
| `ConfirmAction` | trigger + native `<dialog>` (focus trap, Esc, backdrop click). Posts `hidden` fields to a server action unchanged; `requireText` for typed confirmation. |
| `CopyField` | read-only value + Kopiera; clipboard fallback selects the text. |
| `PageHeader`, `SiteHeader`, `SiteFooter`, `Wordmark`, `icons` | page chrome; authored 24px icon set (1.75 stroke). |

Pages are split: a thin server page (auth, data, `?fel=` mapping, actions) renders a
presentational view in `components/views/` (`LandingView`, `LoginView`, `OrgsView`,
`OrgDetailView`, `JoinView`, `AccountView`, `StatusView`). All `?fel=`/`?klart=` codes map in
`lib/ui/messages.ts`.

Layout helpers: `.stack` with `stack--2…6` for gaps on the space scale (no inline gap styles).
Touch targets: every control is ≥ 44px on screens under 48rem (`btn--sm` grows there).
Term: always **förening/föreningar** in copy (routes and codes keep `org`).

## Live meeting components (`components/live/`)

Plain props and callbacks; no fetching. Task 7 owns the state machine (LiveStream, heartbeat,
wake lock) and maps it onto these. Types in `components/live/types.ts`.

**Full-screen focus mode.** The live route must sit **outside** the `(app)` layout: no app header,
no footer. `LiveMeeting` renders its own "← Tillbaka", which asks "Mötet pågår — lämna sidan?"
while the meeting runs (Task 7 should also add a `beforeunload` guard).

**One status.** `liveStatus()` in `lib/ui/live-status.ts` (tested) turns
`{phase, connection, docPaused, staleMinutes, minutesLeft}` into the headline (label + tone),
mic ring on/off, partial-strip mode, Doc card health, whether Paus is offered, and the ordered
banner list. Every live component reads from it, so the page can't contradict itself:

| Situation | Headline | Ring | Partial strip | Banner |
|---|---|---|---|---|
| live / name round | ● Transkriberar (red, pulsing) | on | live words | — |
| connection down | ● Ansluter igen… (grey) | off | last words, grey, "(senaste vi hörde)" | Ansluter igen (ink) |
| paused | ❚❚ Pausat — inget ljud skickas; bar tinted | off | "Pausat. Inget ljud skickas." | — |
| error | ● Stannat — behöver dig (red, static); bar outlined red; Paus hidden | off | "Inget ljud skickas just nu." | loud red, Försök igen |
| ending | Avslutar… | off | — | — |

Banner priority: error > Doc paused > time limit > connection. Only the first shows; the rest sit
behind "+N till". Stale notes are not a banner: the Doc card shows them (green "Uppdaterat för
2 min sedan" · grey "Senast uppdaterat 19:38 · vi försöker igen automatiskt" · red "Pausat — logga in igen").

**`LiveMeeting`** — the whole page; renders the right layout for `phase`:
`consent | starting | name-round | live | paused | ending | ended | resume | error`.

| Prop | Type | Meaning |
|---|---|---|
| `phase` | `LivePhase` | see above |
| `orgName`, `orgHref`, `title` | string | header + back link; title = Doc title |
| `shareTranscript` | boolean | consent copy mentions the transcript tab or not |
| `startedAt` | ISO? | resume copy |
| `elapsedMs` | number | timer (caller ticks it) and ended duration |
| `docUrl`, `lastUpdatedAt` | string \| null | Doc link + last write time |
| `updatedMinutesAgo` | number \| null | minutes since that write (caller ticks it) → "Uppdaterat för 2 min sedan" |
| `partialText`, `partialSpeaker` | string | live partials (display only); at most two lines, newest words always visible |
| `connection` | `ok \| reconnecting \| offline` | "Ansluter igen…" banner |
| `docPaused` | boolean | "Dokumentet pausat — logga in igen" + button |
| `staleMinutes` | number \| null | "Anteckningarna har inte uppdaterats på N min" (pass when > 3) |
| `minutesLeft` | number \| null | 3 h 45 warning (pass from 3 h 45; auto-stop is the server's `stop`) |
| `speakers`, `people` | `Speaker[]`, `PersonOption[]` | speaker list + one-tap names |
| `nameRound` | `NameRoundEntry[]` | names heard during the name round |
| `startError` | `mic-denied \| mic-missing \| start-failed \| limit \| null` | consent-step error |
| `micLevel`, `onMicCheck` | number 0–1 \| null, () => void | optional consent mic check: button, then a 5-bar meter "Hör dig" |
| `busy`, `autoStopped` | boolean | request in flight; ended by the 4 h limit |
| callbacks | `onStart, onPause, onResume, onStop, onReLogin, onAssignSpeaker(key, choice), onNameRoundDone, onNameRoundSkip?, onResumeMeeting, onEndUnfinished?, onRetry, onLeave?` | `onLeave` defaults to navigating to `orgHref` |

Building blocks (usable on their own):

- `ConsentStep {orgName, shareTranscript, onStart, starting?, error?, micLevel?, onMicCheck?}` —
  Start is disabled until "Alla i rummet vet att mötet transkriberas och kan be om paus" is ticked.
- `MeetingControls {status: live|paused|ending, onPause, onResume, onStop, busy?, canPause?}` —
  big Paus; Avsluta asks once (dialog) before `onStop`; `canPause={false}` leaves only Avsluta.
- `MeetingTimer {elapsedMs, paused?, limitMs = 4 h, size?}` — mm:ss / h:mm:ss + allowance rail (red in the last 15 min).
- `PartialStrip {text, speaker?, mode: live|last-heard|paused|silent}` — quiet: body size, grey, below the Doc card.
- `DocLink {url, title, lastUpdatedAt?, updatedMinutesAgo?, health: ok|stale|paused, pending?}`
- `LiveBanners {banners, connection, minutesLeft?, onReLogin?, onRetry?}` — `banners` from `liveStatus()`.
- `NameRound {entries, onDone, onSkip?}` — "Säg ”Jag heter …” en i taget"; unsure names show "Sara?" in blue.
  During the name round the speaker list is hidden (one list, one way to confirm).
- `SpeakerList {speakers, people, onAssign}` — "Talare 2 / Anna"; needs-confirm shows "Anna?" (blue) +
  Stämmer inline; unknown shows "Vem är detta?" (blue) + Välj, which opens the name chips and
  "Någon annan". Pickers are closed by default. Speakers are keyed by `(elSessionId, speakerLabel)`
  since labels restart on a new ElevenLabs session.
- `ResumeMeeting {startedAt, orgName, onResume, onEnd?, resuming?}` — "Fortsätt mötet"; "Avsluta mötet" asks first.
- `LiveDialog` — the shared confirm dialog (safe choice first and focused).
- `MeetingEnded {docUrl, durationSeconds, finalizing?, orgHref, autoStopped?}`

## Org page hooks for Task 7

`OrgDetailView` takes `startMeetingHref?` and `liveMeetingHref?: (id) => string`. With the latter,
running meetings get "Till mötet" in the list and the header action becomes "Fortsätt mötet".

## Dependencies

No UI kit. React + plain CSS custom properties (three global stylesheets: `app/globals.css`
tokens + primitives, `app/views.css` pages, `components/live/live.css`). Fonts via `next/font`.
