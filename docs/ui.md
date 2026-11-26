# Simon Says — UI

The design system, page structure and live-meeting components. Swedish UI, English code.
Preview everything with fake data at **`/design`** (dev only; production needs `DESIGN_PREVIEW=1`).
Screenshots: `docs/ui/` (`<state>-<width>-<scheme>.png`, fake data, Next dev badge hidden) show the
earlier whiteboard design and are out of date since the Geist restyle. The design review and its
captures are in `docs/ui/review/`.

## Direction: Geist, Simon Says' own

The visual language follows Geist, Vercel's open design system: neutral greys, hairlines, small
radii, Geist Sans and Geist Mono, and colour only where it means status. It is a design language,
not a clone. Simon Says keeps its own name and logo, and uses no Vercel marks or assets. (Until
2026-11-26 the UI used a "whiteboard" design; the class name `board` and the token
names `--board`, `--rail`, `--ink` are left over from it and now mean what the table below says.)

- **Light = white surfaces on a near-white page, dark = near-black surfaces on black**
  (follows `prefers-color-scheme`).
- **Colour is status only:** blue (links, focus, info, action items, "who is this"),
  **green** (decisions, success, consent given), **red** (live/recording, destructive, needs
  attention), **amber** (warnings that fix themselves, `banner--warning`). Everything else is grey.
  Red is kept for the hot state: if something is red, it is live or it needs you. Trash icons in
  lists are grey at rest (`danger-ghost`) and turn red only on hover/focus.
- **No status dots.** The words carry the status ("Transkriberar", "Pausat"); a tint on
  the badge or headline only supports them. Lists use en-dash markers, not discs. (The `.magnet`
  dot was removed 2026-11-26.) The mic level ring stays: it follows the live mic.
- **The logo** is the wordmark "Simon Says" set in Instrument Serif 400 (`next/font/google`,
  `--font-wordmark`, used only by `.wordmark`). No mark, no dot.
- **The Google Doc keeps its own look.** Wherever we draw the Doc (landing, edit demo, format
  preview) it is white paper in a system face, so people recognise "that's the Doc", not our UI.
- Refused on purpose: gradients, glass, cards-with-icons grids, eyebrow labels, heavy shadows.

### Principles

1. **Calm in the room.** The live page sits on a table during a meeting. Few elements, big
   targets, nothing moves unless it means something (the listening ring).
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
| `--board` | `#fafafa` | `#000000` | page background |
| `--surface` | `#ffffff` | `#0a0a0a` | cards, sheets, controls |
| `--surface-sunk` | `#f2f2f2` | `#1a1a1a` | hover, inset areas |
| `--rail` | `#c7c7c7` | `#454545` | decorative strong lines (timer track, dashed empty states) |
| `--control-border` | `#8a8a8a` | `#6e6e6e` | edges of inputs, selects, checkboxes, chips, bordered buttons, the consent box |
| `--line` | `#ebebeb` | `#2e2e2e` | hairlines: card borders, row dividers |
| `--ink` / `--ink-2` / `--ink-3` | `#171717` / `#4d4d4d` / `#666666` | `#ededed` / `#bdbdbd` / `#a1a1a1` | text levels |
| `--on-ink` | `#ffffff` | `#0a0a0a` | text on the primary (ink) button |
| `--blue` (+`-wash`) | `#0068d6` / `#ebf5ff` | `#52a8ff` / `#0d1c30` | links, focus, info |
| `--green` (+`-wash`) | `#107d32` / `#ebfaef` | `#4cc26b` / `#0c2414` | success, decisions, consent |
| `--red` (+`-wash`) | `#cb2a2f` / `#ffebec` | `#ff6166` / `#2e1215` | live, danger, attention |
| `--amber` (+`-wash`) | `#a35200` / `#fff4e0` | `#f1a10d` / `#2b1f05` | warnings that fix themselves |
| `--focus` | `#0068d6` | `#52a8ff` | focus ring |

The status colours are the darker, text-safe shades of Geist's scales (Geist's bright
`#0070f3`-style fills are under 4.5:1 as text on white).

Contrast (WCAG, computed): every text token ≥ 4.5:1 on board, surface and sunk in both themes.
Lowest light: red on red-wash 4.69, green on sunk 4.69, blue on sunk 4.75; lowest dark: red on
red-wash 5.90. `--ink-3` 5.13 on sunk (light). White on the red button 5.37 (light); dark uses
`#1a0806` on red, 6.62. Primary button text 17.9 / 16.9. Control edges (`--control-border`, WCAG
1.4.11 ≥ 3:1): light 3.45 on surface, 3.31 on board, 3.08 on sunk; dark 3.88 on surface, 4.12
on board, 3.41 on sunk. Hairlines between rows and cards (`--line`) stay faint on purpose: they
are decorative, not control boundaries.

**Type.** Geist Sans for everything; Geist Mono only for measurements: timer, timestamps, speaker
labels, invite link, ids. Both via `next/font/google` (`Geist`, `Geist_Mono`; versions pinned by
the pinned `next`; downloaded at build, served from our domain, no Google request from visitors).
Scale: 13 / 14 / **16 body** / 18 / 24 / 32 / display `clamp(36px → 56px)`. Headings 600,
tracking −0.025em (display −0.045em, section titles −0.035em), `text-wrap: balance`; body
−0.006em. Buttons, labels and row titles 500.

**Space** 4px base: `--s-1..9` = 4, 8, 12, 16, 24, 32, 48, 64, 96. **Radii** 6 (controls, chips),
8 (cards, banners, dialogs), round only for badges and the mic ring.
**Controls** sm 32px, md 40px, lg 48px (lg stays big on purpose: Paus/Fortsätt on the live page);
on screens under 48rem every button and input is ≥ 44px. Primary = ink on light, white on dark
(`--ink` / `--on-ink`); secondary = surface with a `--control-border` outline; ghost = transparent.

**Depth.** Cards are flat: `--shadow-panel` is a 1px `--line` ring (a box-shadow, so it adds no
size). Only floating things get a real shadow: `--shadow-lift` (dialogs, popovers, menus) = ring +
a small soft drop. Dialog footers sit on `--board` behind a hairline.

**Motion.** `--ease-out` = `cubic-bezier(0.16,1,0.3,1)`; 120 ms hovers, 200 ms enters.
One authored moment: the landing demo's notes **write themselves** line by line (clip-path
wipe). Elsewhere: listening ring on the mic, name plates dropping in.
`prefers-reduced-motion` turns all of it off; content is always visible without animation.

**Browser surfaces.** Themed selection, focus ring (2px blue, offset 2; inputs get a 2px blue
ring outside a 1px gap), caret, scrollbars.

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
| `Badge` | label (pill), tinted by tone: neutral/live (red)/alert (static red, "needs you")/success/info. |
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
no footer. `LiveMeeting` renders its own "← {förening}" back link (same on consent, resume and
live), which asks "Mötet pågår — lämna sidan?"
while the meeting runs (Task 7 should also add a `beforeunload` guard).

**One status.** `liveStatus()` in `lib/ui/live-status.ts` (tested) turns
`{phase, connection, docPaused, staleMinutes, minutesLeft}` into the headline (label + tone),
mic ring on/off, partial-strip mode, Doc card health, whether Paus is offered, and the ordered
banner list. Every live component reads from it, so the page can't contradict itself:

| Situation | Headline | Ring | Partial strip | Banner |
|---|---|---|---|---|
| live / name round | Transkriberar (red) | on | live words | — |
| connection down | Ansluter igen… (grey) | off | last words, grey, "(senaste vi hörde)" | Ljudet väntar i webbläsaren (ink) |
| paused | ❚❚ Pausat — inget ljud skickas; bar tinted | off | "Pausat. Inget ljud skickas." | — |
| error | Stannat — behöver dig (red); bar outlined red; Paus hidden | off | "Inget ljud skickas just nu." | loud red, Försök igen |
| ending | Avslutar… | off | — | — |

Banner priority: error > Doc paused > time limit > connection. Every red banner (user must act)
is always visible; the self-fixing connection banner ("Ljudet väntar i webbläsaren") shows alone,
or behind "Visa 1 varning till ▾" when something red is already on screen. Stale notes are not a banner: the Doc card shows them (green "Uppdaterat för
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

- `ConsentStep {orgName, shareTranscript, onStart, starting?, error?, micLevel?, onMicCheck?, agenda?, agendaConfirmed?, agendaDoc?, onNewDocInstead?}` —
  Start is disabled until "Alla i rummet vet att mötet transkriberas och kan be om paus" is ticked
  and the agenda choice is confirmed. `agenda` (the `AgendaStep`) renders under the checkbox;
  `agendaDoc` switches the Doc fact to "skrivs i den valda dagordningen"; `onNewDocInstead` puts
  "Skapa nytt dokument i stället" in the error banner (the controller passes it for `agenda_*` errors).
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
- `LiveDialog` — the shared confirm dialog (safe choice first and focused; `stayVariant="primary"`
  in the leave dialog, where leaving is the risky choice).

Weight order on the live page: Paus/Fortsätt (lg) is the strongest control; Stämmer and Välj are
outlined secondary. The timer's allowance rail has a `--rail` track and an ink fill, as wide as
the digits.
- `MeetingEnded {docUrl, durationSeconds, finalizing?, orgHref, autoStopped?}`

## Org page hooks for Task 7

`OrgDetailView` takes `startMeetingHref?` and `liveMeetingHref?: (id) => string`. With the latter,
the starter's running meeting gets "Till mötet" in the list and the header action becomes "Fortsätt mötet";
the starter's meetings abandoned < 2 h ago get "Fortsätt mötet" in the list. Other members see no live
links (only the starter can run a meeting).
`startMeeting?: ReactNode` is the "Starta möte" panel (the page passes `StartMeetingForm`: a link to the live
page's consent step `/meetings/ny/<orgId>`, plus the admins' Testmöte); while a meeting is live/ending it is
replaced by an info banner with the Doc link.

Members panel (final fix wave A2): each member's email with "admin" / "du". Admins get a ghost "Ta bort" per other
member, everyone a ghost "Lämna" on their own row; both open a `ConfirmAction` dialog whose copy says that Docs
already shared stay shared (and, for Ta bort, that the invite link still works until a new one is made). The last
admin can't leave or be removed (the notice suggests deleting the förening instead).

## The live page (Task 7)

Routes outside the `(app)` layout: `/meetings/ny/<orgId>` (consent step; Start asks for the mic from the click,
then `POST /api/meetings` creates the Doc, the address becomes `/meetings/<id>` without a reload) and
`/meetings/<id>` (starter only; live or abandoned < 2 h → "Fortsätt mötet", which `POST /resume`s and starts
the mic from that click; ending → polls until done; done → ended). `LiveMeetingController` maps `LiveStream`
(`lib/audio/stream.ts`) onto `LiveMeeting`; heartbeat answers feed `minutesLeft`, `docPaused` and
`lastTickOkAt`.

Final fix wave: the first connection says "Ansluter…" (no banner); a paused meeting never shows the "Ljudet väntar"
banner. The mic ring follows the real level (still when the mic hears nothing; opacity only with reduced motion), and
2 min below the heard level shows "Hör inget ljud sedan 2 min". A stopped page (`error`) retries by itself every 30 s,
says "efter tre försök" only after three token failures, says "Starta ett nytt möte" (no Försök igen) when the
meeting has used all its sessions, and puts "⚠ Stannat – Simon Says" in the tab title. After Avsluta, lines still
unsent show "N rader väntar på nätet – stäng inte fliken"; a failed `/end` shows "Försök igen" instead of leaving
the page. Automatic stops and the time banner name the limit (4 h, the förening's month, the service's day,
the transcription service's quota). "N medlemmar fick inte åtkomst – dela dokumentet manuellt" when sharing failed.
Sessions last at most an hour (Ruling 39): at the rollover new voices appear as "Vem är detta?" in the list; the
name round never reopens.

## Agenda step and the Google Picker (meeting formats A11)

The consent step asks which Doc the meeting runs in. `AgendaStep` (`components/live/AgendaStep.tsx`)
is the container: it reads `GET /api/orgs/<id>/agenda-candidates` (the förening's meeting folder,
read with the starter's own Google grant; Docs already used by a meeting are left out), opens the
Google Picker (`usePicker()` in `components/google/Picker.tsx`, token from
`POST /api/google/picker-token`) and reports an `AgendaChoice` through `onChange`.
`AgendaStepView` is the presentational part (no fetching), used by `/design`.

| State | Shows | Confirms |
|---|---|---|
| suggestion | blue "Förslag: <Doc-namn>" · **Använd** · Välj annan · Skapa nytt dokument | any of them |
| none (no folder, or nothing new in it) | "Ingen dagordning – skapa nytt dokument i formatet <X>" · **Skapa nytt dokument** · Välj dagordning | either |
| folder not reachable (folder set, this starter's grant has never opened it) | explanation · **Använd mötesmappen** (folder Picker → `POST /api/orgs/<id>/meeting-folder` with `grantOnly: true`, so the start screen never changes the folder, admins included → reload) · Välj dagordning · Skapa nytt dokument | a pick or Skapa nytt |
| picker off (`GOOGLE_PICKER_API_KEY`/`GOOGLE_PROJECT_NUMBER` unset) | green "Nytt dokument i formatet <X>" + "Google-väljaren är inte inställd än." | already confirmed (as before A11) |

Start stays disabled until the choice is confirmed: a suggestion is never used on its own. Once
confirmed, a green line shows the choice ("Dagordning: <namn>" or "Nytt dokument i formatet
<X>") with Välj annan / Skapa nytt dokument / Välj dagordning to change it. With an agenda Doc and a
förening that shares transcripts, "Lägg transkriptet i dokumentet?" appears (default off). The
"Format" `<select>` (default first, marked "(förvalt)") overrides the format; the default sends
nothing, another standard format sends `formatKind`, a learned version `formatProfileId`. Picker
and request problems show as one polite line under the step (`aria-live`). Doc names are the
förening's text: shown in the UI, never logged. A failed start with an `agenda_*` code shows the
server's Swedish message with "Skapa nytt dokument i stället", which remounts the step on a
confirmed new Doc and keeps the format override. The doc Picker shows the meeting folder first
(when set) and all Docs as a second view.

`FormatCard`: admins get "Välj mötesmapp" / "Byt mötesmapp" (folder Picker →
`POST /api/orgs/<id>/meeting-folder`), or "Google-väljaren är inte inställd än." with the Picker off.
`/design`: `live-agenda-suggestion`, `live-agenda-none`, `live-agenda-folder`, `live-agenda-off`.

### Learning a format (B2)

`FormatCard`, admins with the Picker on: **Lär Simon Says ert format** (`LearnFormat` in
`components/views/FormatEditor.tsx`) opens the Picker in `docs-multi` mode for a template or 1–5
old minutes. More than five gives "Välj högst 5 dokument." Next comes "Simon Says läser strukturen …"
(`POST /api/orgs/<id>/formats/propose`), then `FormatEditor`. With the Picker off, the button is
disabled and shows "Google-väljaren är inte inställd än."

`FormatEditor` shows:
- Claude's explanation;
- the quality note, as a neutral banner titled "Om era gamla protokoll";
- the fields:
  - title;
  - info-table fields (none means no table);
  - agenda heading;
  - the fixed items, each with a label, a type (Formalia / Må-runda / Från förra veckan / Ämne /
    Övrigt), "Sist", ↑ ↓ and **Ta bort**. Removing the Må-runda is valid: not every förening has one.
    The hint says so.
  - numbering (1. / § / none);
  - tasks heading on/off with group by role/person;
  - notes heading on/off;
  - signatures.
- A Doc-paper preview of `skeletonBlocks(profile)` beside the fields (below them on narrow
  screens). While a field is invalid, the preview keeps the last valid profile.

The Swedish errors from `editorToProfile` (`lib/formats/editor.ts`) are listed under the fields,
for example "Titeln får inte vara tom." or "Bara en punkt kan vara Må-runda.". While there are
errors, **Godkänn och använd** is disabled. It posts `POST /api/orgs/<id>/formats` and refreshes the
page. **Avbryt** drops the proposal; nothing is stored before approval.
`/design`: `format-learn-proposing`, `format-learn-editor`, `format-learn-error`.

**Lägg in punkter från stadgarna** (C1, `StadgarFormat`, below the learn button) opens the Picker
in `doc-or-pdf` mode. It shows "Simon Says läser stadgarna …" while it calls
`POST /api/orgs/<id>/formats/stadgar`. The route reads a Google Doc as plain text, or a PDF of at
most 10 MB (a larger one gets 413 "Filen är för stor (max 10 MB)."). Then `FormatEditor` opens on
the standard Styrelseprotokoll with an editable list "Punkter som stadgarna kräver" (at most 15).
Approving stores it as `kind: "styrelseprotokoll"`. The stadgar themselves are never stored.
`/design`: `format-stadgar-editor`.

## Name round and speaker list (Task 11)

A new meeting opens in `name-round`: "Säg 'Jag heter …' en i taget"; voices appear as "Talare n …" while the page
polls `GET /api/meetings/<id>/speakers` (4 s, then 15 s while live). "Klar" `POST`s the same route: the server
reads the names from the session's first minutes (Claude, `lib/names/`), fills `speaker_map` for voices nobody has
named and adds new confident names to the förening's people; then the speaker list takes over. Without "Klar" the
tick runs the round itself once the session has ~2 min of speech, and the page leaves the round when it sees
`nameRoundDone`. Until a session's round has run the tick holds back its transcript lines, so they are written
with names. After a reconnect the new session's voices show "Vem är detta?" (labels restart per session) with the
meeting's names first as one-tap choices; its own round runs after ~2 min and fills only what is still open, unsure
guesses as "Anna?" + Stämmer. `PATCH` (starter only) renames a voice (through merge aliases); it applies to
transcript lines written afterwards and to the notes from the next tick.

## Dependencies

No UI kit. React + plain CSS custom properties (three global stylesheets: `app/globals.css`
tokens + primitives, `app/views.css` pages, `components/live/live.css`). Fonts via `next/font`.
