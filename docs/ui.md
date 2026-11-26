# Simon Says — UI

The design system, page structure and live-meeting components. Swedish UI by default (English
optional, see "Language" below), English code.
Built with **shadcn/ui on Tailwind CSS v4**, styled in Simon Says' own Geist-based look (below).
Preview everything with fake data at **`/design`** (dev only; production needs `DESIGN_PREVIEW=1`).
Screenshots: `docs/ui/` (`<state>-<width>-<scheme>.png`, fake data, Next dev badge hidden) show the
earlier whiteboard design and are out of date since the Geist restyle. The design review and its
captures are in `docs/ui/review/`.

## Direction: Geist, Simon Says' own

The visual language follows Geist, Vercel's open design system: neutral greys, hairlines, small
radii, Geist Sans and Geist Mono, and colour only where it means status. It is a design language,
not a clone. Simon Says keeps its own name and logo, and uses no Vercel marks or assets. (Until
2026-11-26 the UI used a "whiteboard" design; the token names `--board`, `--rail`, `--ink` are
left over from it and now mean what the table below says.)

- **Light = white surfaces on a near-white page, dark = near-black surfaces on black**
  (follows `prefers-color-scheme`).
- **Colour is status only:** blue (links, focus, info, action items, "who is this"),
  **green** (decisions, success, consent given), **red** (live/recording, destructive, needs
  attention), **amber** (warnings that fix themselves, `Banner tone="warning"`). Everything else is grey.
  Red is kept for the hot state: if something is red, it is live or it needs you. Trash icons in
  lists are grey at rest (Button `variant="danger-ghost"`) and turn red only on hover/focus.
- **No status dots.** The words carry the status ("Transkriberar", "Pausat"); a tint on
  the badge or headline only supports them. Lists use en-dash markers, not discs. (The old `.magnet`
  dot was removed 2026-11-26.) Lists that need a marker use the `list-dash` utility. The mic level ring stays: it follows the live mic.
- **The logo** is the wordmark "Simon Says" set in Instrument Serif 400 (`next/font/google`,
  `--font-wordmark`, Tailwind `font-logo`, used only by `Wordmark`). No mark, no dot.
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

The raw tokens below live on `:root` (dark values under `prefers-color-scheme: dark`, as before:
there is no theme toggle, and Tailwind's `dark:` variant follows the same media query). Tailwind
sees them through `@theme`, so every token is a utility: `bg-board`, `bg-surface`, `bg-sunk`,
`border-line`, `border-control`, `border-rail`, `text-ink` / `text-ink-2` / `text-ink-3`,
`text-on-ink`, `text-blue` / `bg-blue-wash` (same for green, red, amber), `text-on-red`,
`text-on-green`. Tailwind's default colour palette is switched off (`--color-*: initial`), so
`text-red-500` and friends don't exist: every colour goes through a token.

shadcn's role variables are mapped onto the same tokens, so shadcn components look like ours:

| shadcn | token | | shadcn | token |
|---|---|---|---|---|
| `--background` | `--board` | | `--muted` | `--surface-sunk` |
| `--foreground` | `--ink` | | `--muted-foreground` | `--ink-2` |
| `--card`, `--popover` | `--surface` | | `--accent` | `--surface-sunk` |
| `--primary` | `--ink` | | `--destructive` | `--red` |
| `--primary-foreground` | `--on-ink` | | `--border` | `--line` |
| `--secondary` | `--surface` | | `--input` | `--control-border` |
| `--ring` | `--focus` | | `--radius` | 8px |


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

**Type.** Geist Sans for everything (`font-sans`); Geist Mono only for measurements: timer, timestamps, speaker
labels, invite link, ids. Both via `next/font/google` (`Geist`, `Geist_Mono`; versions pinned by
the pinned `next`; downloaded at build, served from our domain, no Google request from visitors).
Scale (Tailwind `text-*`, our own, without line heights so text keeps inheriting the body's 1.5):
`text-2xs` 12 (badges) · `text-xs` 13 · `text-sm` 14 · **`text-base` 16 body** · `text-lg` 18 ·
`text-xl` 24 · `text-2xl` 32 · `text-display` `clamp(36px → 56px)`. Note `text-xl`/`text-2xl`
are 24/32, not Tailwind's defaults. Headings 600,
tracking −0.025em (display −0.045em, section titles −0.035em), `text-wrap: balance`; body
−0.006em. Buttons, labels and row titles 500.

**Space** 4px base: Tailwind's spacing scale (`gap-2` = 8, `gap-6` = 24, `gap-8` = 32, `p-6` = 24).
Page width `max-w-page` (72rem) with `px-gutter` (`clamp(16px → 32px)`). **Radii** `rounded-md` 6
(controls, chips), `rounded-lg` 8 (cards, banners, dialogs), `rounded-full` only for badges and the
mic ring. Breakpoints are the old ones, written as `max-[52rem]:`, `max-[30rem]:` etc. (`max-md:` =
under 48rem).
**Controls** sm 32px, md 40px, lg 48px (lg stays big on purpose: Paus/Fortsätt on the live page);
on screens under 48rem every button and input is ≥ 44px. Primary = ink on light, white on dark
(`--ink` / `--on-ink`); secondary = surface with a `--control-border` outline; ghost = transparent.

**Depth.** Cards are flat: `shadow-panel` is a 1px `--line` ring (a box-shadow, so it adds no
size). Only floating things get a real shadow: `shadow-lift` (dialogs, popovers, menus) = ring +
a small soft drop. Dialog footers sit on `--board` behind a hairline.

**Motion.** `ease-out` = `cubic-bezier(0.16,1,0.3,1)`; 120 ms hovers (`duration-120`), 200 ms
enters. Named animations in the theme: `animate-write` (landing lines), `animate-caret`,
`animate-plate-in`, `animate-notice-in`, `animate-scope-tick`, `animate-shimmer`.
One authored moment: the landing demo's notes **write themselves** line by line (clip-path
wipe). Elsewhere: listening ring on the mic, name plates dropping in.
`prefers-reduced-motion` turns all of it off (one global rule at the end of `globals.css`, plus
`motion-reduce:` on the mic ring); content is always visible without animation.

**Browser surfaces.** Themed selection, focus ring (2px blue, offset 2; inputs get a 2px blue
ring outside a 1px gap), caret, scrollbars.

## Voice (Swedish copy)

Short, warm, concrete; "du/ni"; no jargon ("transkriberas", not "processas"). Buttons name the
action ("Starta mötet", "Radera mötet", "Skapa ny länk"). Errors say what happened and what to
do ("Mikrofonen är blockerad — klicka på hänglåset… välj Tillåt"). Reassure when nothing is
needed ("Vi försöker igen automatiskt, du behöver inte göra något"). Always say the Google Doc
stays in Drive when deleting.

## Language (sv default, en optional)

Todo #10: the web app is Swedish by default and can be switched to English. Built on **next-intl
4.15.1** (pinned), cookie-based, **no URL prefixes** (routes are unchanged).

- **Catalogs:** `lib/i18n/messages/{sv,en}/<area>.json`, registered in `lib/i18n/messages/index.ts`.
  Swedish is the source of truth (the copy as it always was); English must have the same keys,
  placeholders and rich-text tags (`lib/i18n/messages.test.ts`, also checks every message parses as
  ICU). ICU plurals: `{count, plural, one {# möte} other {# möten}}`; links/emphasis via `t.rich`
  tags (`<link>…</link>`, `<strong>…</strong>`).
- **Using them:** components (server or client, also the views `/design` renders) call
  `useTranslations("area")`; async server pages/actions use `getTranslations` / `getLocale` from
  `next-intl/server`; route handlers use `apiT(request)` (`lib/i18n/api.ts`, reads the cookie from
  the Request so tests calling handlers directly get Swedish); pure lib code and e-mails use
  `translator(locale)` (`lib/i18n/translator.ts`). Messages lib code returns in Swedish
  (`lib/meetings/start.ts`, `lib/formats/stadgar-file.ts`) are translated at the route boundary by
  `localizeMessage` (looked up by their Swedish text; a test keeps them in the catalog).
- **Choosing:** Konto → "Språk / Language" (Svenska / English) saves the account's choice
  (`user_settings.locale`, migration 0040, `set_my_locale`) and the `lang` cookie. Signed-out pages
  have "English / Svenska" in the footer (`/sprak?till=en&tillbaka=…`, same-origin paths only; also
  saves the account's choice when signed in). Sign-in copies the saved choice into the cookie; an
  English choice made while signed out becomes the account's if it has none. `<html lang>` follows
  the cookie. Reading it in the root layout makes every route render per request (the status page
  is no longer cached for 60 s).
- **Dates and numbers:** sv-SE / en-GB (24-hour clock in both), Europe/Stockholm; `lib/format.ts`
  and friends take a `locale`.
- **E-mails** (invite, meeting summary) use the recipient's saved language: the account's
  `user_settings`, or for an address the confirmed account that signs in with it
  (`locale_for_email`); Swedish otherwise. The invite form's preview shows the Swedish mail.
- **Not translated, on purpose:** everything written into Google Docs (meeting notes, agenda Docs,
  headings, agenda items such as "Godkänn dagordning", "Må-runda", "Från förra veckan", task lines,
  speaker labels "Talare 1") follows the förening's meeting language, which is Swedish for now; the
  Claude prompts; stored labels ("Dokument 1, möte 2 av 3"); the landing page's Doc mock; the
  `/design` gallery's chrome and fake data; role names people type.
- **Lint-ish guard:** `lib/i18n/no-swedish-literals.test.ts` fails on å/ä/ö in string literals or
  JSX text in `components/**` and `app/**` (comments ignored; `components/design/` allowed).

**Glossary (sv → en).** förening → association · Föreningar → Associations · Konto → Account ·
Veckomöte → Weekly meeting · Styrelsemöte → Board meeting · Styrelseprotokoll → Board minutes ·
Årsmöte → Annual meeting · Må-runda → Check-in round · namnrunda → name round · protokoll → minutes ·
dagordning → agenda · mötesmapp → meeting folder · stadgar → statutes · personlista → people list ·
Kom igång → Get started · Översikt → Overview · Förbered möte → Prepare meeting · Pausa/Fortsätt →
Pause/Resume · Avsluta mötet → End the meeting · Integritet → Privacy · mejl → e-mail.
Voice in English: the same as Swedish (short, warm, concrete, "you"), British spelling.

## Components (`components/ui/`)

Two kinds of files live here:

- **shadcn primitives**, lowercase (`button.tsx`, `badge.tsx`, `input.tsx`, `label.tsx`,
  `native-select.tsx`, `checkbox.tsx`, `switch.tsx`, `card.tsx`, `alert.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `skeleton.tsx`).
  They came from `npx shadcn add` (style `radix-nova`, Radix underneath) and were then restyled
  to the tokens. They are our code now: edit them, don't re-add them over the top.
- **App components**, PascalCase, built on the primitives and keeping their old APIs.

| Component | Built on | Notes |
|---|---|---|
| `Button`, `ButtonLink` (`button.tsx`) | shadcn Button | `variant`: primary · secondary · ghost · danger · danger-quiet · danger-ghost (list trash icons); shadcn's `default`/`outline`/`destructive`/`link` are aliases. `size` sm/md/lg; `loading` (spinner, aria-busy, disabled); `icon`; `iconOnly` (label visually hidden + title); `block`; `asChild`. `buttonVariants()` styles a plain `<a>`. |
| `SubmitButton` | Button | `useFormStatus` → loading while its form's server action runs; `pendingLabel`. |
| `Field`, `Check` (`Field.tsx`) | Label, Input, Checkbox | label/hint/error wired with `aria-describedby` / `aria-invalid`; `Check` = Radix checkbox with title + explanation (`checked` + `onCheckedChange`, or `name` + `defaultChecked` in a form: it posts `on` like a native checkbox). |
| `Switch` (`switch.tsx`) | Radix Switch | On/off that takes effect at once (no Save button), 40×24, ink when on. Put it in a row whose label is the target (≥ 44px). For choices saved with a form, use `Check`. |
| `NativeSelect` | shadcn NativeSelect | a real `<select>` drawn like an Input with a chevron (forms, `defaultValue`, keyboard and phone pickers unchanged). |
| `Banner` | shadcn Alert | `tone` info/success/warning/danger/neutral, `title`, `action`, `loud` (the stopped live meeting); role alert for warning/danger, status otherwise (`live={false}` for static). |
| `Badge` (`badge.tsx`) | shadcn Badge | label (pill), tinted by `tone`: neutral/live (red)/alert (static red, "needs you")/success/info. |
| `Panel` | shadcn Card | sheet with title/actions; `flush` for edge-to-edge lists (`panelIntroClass`, `panelPadClass`, `panelFootClass` for the padded bits). |
| `ListRow` | — | leading · title/meta · actions; `href` makes the row a link (`group/row` for hover effects). Use inside a `<ul>`. `rowClass` & co. for hand-built rows. |
| `ConfirmAction` | shadcn Dialog | trigger + Radix dialog (focus trap, Esc, backdrop click, focus back to the trigger). Posts `hidden` fields to a server action unchanged; `requireText` for typed confirmation. |
| `EmptyState`, `CopyField`, `PageHeader`, `SiteHeader` (+ `navLinkClass`), `SiteFooter`, `Wordmark` | — | page chrome. |
| `Skeleton` | shadcn Skeleton | the grey shimmer in `app/(app)/loading.tsx`. |
| `icons.tsx` | — | the authored 24px icon set (1.75 stroke) and Google's G. shadcn's lucide imports are swapped for these; `lucide-react` is not installed. |

Not added (nothing uses them yet): shadcn `textarea`, `tooltip`, `separator`, `alert-dialog`
(every confirm is a `Dialog`, because an alert dialog can't be closed from the backdrop). Icon-only
buttons keep `title` + a visually hidden label instead of a tooltip.

### Styling rules

- Utilities in `className`, merged with `cn()` from `lib/utils.ts` (clsx + tailwind-merge, taught
  our theme keys so `text-2xs`, `shadow-panel`, `max-w-page`, `px-gutter` merge correctly).
- No new stylesheets: tokens and the base layer only in `globals.css`. Repeated class lists become
  exported constants next to their component (`hintClass`, `rowClass`, `navLinkClass`,
  `docPaperClass` in `components/views/doc-paper.ts` for the Google-Doc paper).
- Colour only through tokens; status colours only for status; no dots.
- Focus: the base layer gives every focusable element the 2px blue ring (offset 2); inputs use a
  2px ring outside a 1px gap instead. Don't add shadcn's `ring-ring/50` styles.

### Adding a shadcn component

1. `npx shadcn@latest add <name>` (it reads `components.json`; if a lowercase file would collide
   with a PascalCase one on macOS, add it under a temporary name first).
2. In the new file: import `cn` from `@/lib/utils` (not the `cn` npm package), swap lucide icons for `icons.tsx`,
   drop `dark:` classes (our tokens already switch), replace shadcn's colours/radii/rings with ours
   (`bg-surface`, `border-control`, `rounded-md`, `shadow-lift`…), remove the `size-*` defaults that
   don't match 40/32/48px controls.
3. Pin any new dependency to an exact version in `package.json`.
4. Show it on `/design?vy=primitives` and check light and dark.

**Förening tabs.** The förening page has two tabs, "Möten" and "Översikt" (`?flik=oversikt`): server
links with `aria-current` (`OrgDetailView` `tabs` prop). Översikt is `OverviewView`: only "Mål" (propose → approve, "Skriv egna mål", "Läs in gamla protokoll"
with its import progress), full width, under a line on what the goals build on ("Målen bygger på …",
own meetings and imported protocols). Open tasks, decisions, recurring topics and attendance were
removed as not helping the förening; the data helpers in `lib/dashboard` stay for the goals proposal
and Förbered möte. Gallery: `org-overview`, `org-overview-goals`, `org-overview-empty`,
`org-overview-history`, `org-overview-history-only`.

Pages are split: a thin server page (auth, data, `?fel=` mapping, actions) renders a
presentational view in `components/views/` (`LandingView`, `LoginView`, `OrgsView`,
`OrgDetailView`, `JoinView`, `AccountView`, `StatusView`). All `?fel=`/`?klart=` codes map in
`lib/ui/messages.ts`.

Mejlval (`EmailPrefsForm`, categories in `lib/email/categories.ts`): one `Switch` per kind of mail
plus "Inga mejl alls", each saved on change with "Sparat" (`role="status"`); a failed save puts
the switch back and says so. "Inga mejl alls" greys the categories out but keeps their values.
Shown under Konto (`AccountView`) and on `/mejl` (`MailPrefsView`, the signed link in every mail,
no login; opening it changes nothing). Gallery: `account`, `account-mail-off`,
`account-mail-error`, `account-mail-save-fails`, `mail-link`, `mail-link-invalid`.

Touch targets: every control is ≥ 44px on screens under 48rem (`max-md:min-h-11`; Button does it).
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
- `LiveDialog` — the shared confirm dialog, a shadcn Dialog opened through a `LiveDialogHandle` ref
  (`showModal()` / `close()`) (safe choice first and focused; `stayVariant="primary"`
  in the leave dialog, where leaving is the risky choice).

Weight order on the live page: Paus/Fortsätt (lg) is the strongest control; Stämmer and Välj are
outlined secondary. The timer's allowance rail has a `--rail` track and an ink fill, as wide as
the digits.
- `MeetingEnded {docUrl, durationSeconds, finalizing?, orgHref, autoStopped?}`

## Org page hooks for Task 7

`OrgDetailView` takes `startMeetingHref?` and `liveMeetingHref?: (id) => string`. With the latter,
any member may continue the running meeting: it gets "Till mötet" in the list and the header action becomes
"Fortsätt mötet"; meetings abandoned < 2 h ago get "Fortsätt mötet" in the list. Admins and the starter also get
a ghost "Avsluta mötet" (`ConfirmAction`, `actions.endMeeting`) on a live row. A live meeting nobody is connected
to ends by itself after a grace period (`lib/meetings/presence.ts`), like Meet.
`startMeeting?: ReactNode` is the "Starta möte" panel (the page passes `StartMeetingForm`), no explanatory
text: when an agenda is prepared, one quiet row "Nästa möte  Veckomöte · tis 1 dec 18.00  Dagordning ↗  Ändra";
then **Starta möte** (primary, mic; the live page's consent step `/meetings/ny/<orgId>`) and **Förbered möte**
(secondary); service admins get a small ghost **Testmöte ▾** menu on the right (items "Utan dagordning" /
"Med dagordning", each with a one-line hint; the trigger spins "Startar testmöte …"). Phone: the buttons
stack full width, the menu under them. While a meeting is live/ending the panel is replaced by an info
banner with the Doc link. `/design`: `org-start`, `org-prepared`.

Members panel (final fix wave A2): each member's email with "admin" / "du". Admins get a ghost "Ta bort" per other
member, everyone a ghost "Lämna" on their own row; both open a `ConfirmAction` dialog whose copy says that Docs
already shared stay shared (and, for Ta bort, that the invite link still works until a new one is made).
Admin handover (todo #8, migration 0031): admins also get "Gör till admin" on members and "Ta bort som admin" on
other admins, and "Sluta vara admin" on their own row while another admin exists; each opens a `ConfirmAction`
with a primary (not red) confirm. The last admin's own row shows "Gör någon annan till admin först för att kunna
lämna." instead of Lämna. The DB refuses demoting or removing the last admin on every path (`last_admin`); the
notices say "Gör någon annan till admin först". Actions wrap under the email at phone width. `/design`:
`org-admin` (last admin), `org-admins` (two admins).

## The live page (Task 7)

Routes outside the `(app)` layout: `/meetings/ny/<orgId>` (consent step; Start asks for the mic from the click,
then `POST /api/meetings` creates the Doc, the address becomes `/meetings/<id>` without a reload) and
`/meetings/<id>` (any member; live or abandoned < 2 h → "Fortsätt mötet", or "Ta över här" while another tab
records it, which `POST /resume`s and starts
the mic from that click; ending → polls until done; done → ended). `LiveMeetingController` maps `LiveStream`
(`lib/audio/stream.ts`) onto `LiveMeeting`; heartbeat answers feed `minutesLeft`, `docPaused` and
`lastTickOkAt`. "Logga in igen" opens `/login?next=/inloggad` in a new tab: that page says "close this tab"
and pings the meeting tab (BroadcastChannel), so the sign-in never opens a second meeting tab (U8).

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
| folder not reachable (folder set, this starter's grant has never opened it) | explanation naming the folder (`orgs.meeting_folder_name`, 0030) · **Använd mötesmappen** (folder Picker → `POST /api/orgs/<id>/meeting-folder` with `grantOnly: true`, so the start screen never changes the folder, admins included → reload) · Välj dagordning · Skapa nytt dokument | a pick or Skapa nytt |
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

`FormatCard` (the "Mötesformat" card) leads with the state: the format's name, one grey line
("Anpassat 2026-11-02 · mötesmapp: Verksamhetsår 2026-2027"; "mötesmapp vald" for a folder picked
before 0030, whose name was not stored; "Ingen mötesmapp vald"), and, when the stadgar add
items, a collapsed `<details>` "Stadgarna kräver N punkter". Members see only that. Admins get one
**Ändra** menu (`dropdown-menu.tsx`; each item has a one-line hint): Byt format (opens the
`<select>` + Byt / Avbryt in the card), Anpassa format, Lär Simon Says ert format, Lägg in punkter
från stadgarna, Välj/Byt mötesmapp (folder Picker → `POST /api/orgs/<id>/meeting-folder`; the
result is a polite line under the state). With the Picker off, learning is a disabled item, the
stadgar and folder items are hidden, and the menu says "Google-väljaren är inte inställd än.".
One change is open at a time; its progress, error (Försök igen / Avbryt) or editor shows in the
card, and focus returns to Ändra when it closes. Flow state lives in `useFormatFlow`
(`FormatEditor.tsx`) and `useMeetingFolderPicker`.
`/design`: `format-card-admin`, `format-card-full`, `format-card-picker-off`, `format-card-member`,
`live-agenda-suggestion`, `live-agenda-none`, `live-agenda-folder`, `live-agenda-off`.

### Learning a format (B2)

`FormatCard`, admins with the Picker on: **Lär Simon Says ert format** (`useFormatFlow` in
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
  - with a Må-runda item: the checkbox "Dölj må-rundan i anteckningarna (experimentellt — kan ibland
    dölja annat som sägs)", unchecked by default, with the hint "Utan bocken antecknas må-rundan som
    de andra punkterna." Ticked, the format stores `hideCheckin: true` and its meetings mask the
    Må-runda out of the notes. Unchecked (and for every format saved before), the Må-runda is an
    ordinary item.
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

**Lägg in punkter från stadgarna** (C1, `useFormatFlow`, in the Ändra menu) opens the Picker
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

Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/postcss`, `postcss.config.mjs`), shadcn/ui
(`components.json`; Radix through `radix-ui`, variants through `class-variance-authority`,
`clsx` + `tailwind-merge` for `cn()`, `tw-animate-css` for the dialog's enter animation). All
pinned to exact versions. One stylesheet: `app/globals.css` (tokens, theme, base layer). Fonts via
`next/font`.

## Meeting Docs on the förening page (0030)

Each meeting row shows the Doc only to someone who can open it, never a link to Google's
access-denied page. Access comes from recorded shares (`meeting_doc_shares`), not a Drive call per
page view (a member's drive.file grant is not expected to see a Doc it didn't create or pick):

| Viewer | Shows |
|---|---|
| the starter, or a member Simon Says shared the Doc with | **Dokument** (opens in a new tab) |
| any other member, Doc Simon Says created | **Få åtkomst** (`DocAccessButton` → `POST /api/meetings/<id>/doc-access`, shared through the starter's grant) → **Dokument**; if that fails (or after 3 presses in an hour): "Be <starter> dela dokumentet med dig." After a share: "Delat till <email>". |
| any other member, the förening's own agenda Doc | "Be <starter> dela dokumentet med dig." (Simon Says never shares a Doc it didn't create) |

The "Ett möte pågår" banner follows the same rule. New members get the earlier Docs Simon Says
created shared on join (after the redirect, so the first view may still show "Få åtkomst"). Under the list: "Mötesdokumenten
delas till <email> – öppna dem i Google med den adressen." Sharing always
goes through the starter's grant, and only while the starter is still a member. On the live page, "Dokumentet hamnade i din Drive" (warning, dismissable)
when the förening has a meeting folder but the starter's grant could not add to it.


## Läs in gamla protokoll (Översikt → Mål, admins)

`HistoryImport` (`components/views/HistoryImport.tsx`, steps in `DriveSteps.tsx`), no Google
Picker unless the admin says no to read access:

| Phase | Shows |
|---|---|
| `access` (the admin's stored grant lacks `drive.readonly`) | one calm paragraph on why (see the mappar and mötesnamn; opens only what you tick; stores nothing else) · **Ge åtkomst** (server action `requestDriveAccess` → Google's incremental consent → `/orgs/<id>/protokoll` → back here) · Avbryt. Back with `?drive=nej`: neutral banner + **Välj ett och ett i stället** (the old Picker flow). `?drive=fel`: danger banner. `?drive=konto` (another Google account came back): warning "Välj samma Google-konto som du är inloggad med: <email>". After "Ta bort läsåtkomst nu": success banner. |
| `folders` (step 1 of 2) | the förening's meeting folder pinned at the top and ticked · search box (by name, debounced) · Min enhet / Delade med mig / Delade enheter · breadcrumb · rows = checkbox + open (chevron), "Visa fler mappar" paging · chips of the ticked folders (max 20) · Ta med undermappar (on) · "tas bort automatiskt efter 24 timmar · Ta bort läsåtkomst nu" |
| `files` (step 2 of 2) | every Google Doc (and .docx, not selectable) in them, oldest first: title, date ("(gissat)" when not from the title), folder · Välj alla · already imported rows show a green check, "Redan inläst", no checkbox · Simon Says' own Docs disabled with a hint · templates/kallelser/dagordningar unticked with a hint · count line (max 60; amber over) · **Fortsätt med N protokoll** |
| `confirm` → `importing` → `dates` | as before (cost, `PrivacyNote`, **Läs in N protokoll**), the progress is a list: Väntar · Läser … · Inläst (green) · Gick inte (with the server's reason) |

Server: `POST /api/orgs/<id>/history/drive` (admins, the separate 24 h import grant, 0034 cap
120 folders listed / 10 min per user, metadata only, nothing stored; each importable row carries
a signed ticket the estimate/import routes require before using the read access);
`DELETE` = Ta bort läsåtkomst. Gallery: `org-overview-import-access`,
`-declined`, `-files`, `-progress`.

## Förbered möte (todo #6, migration 0033)

`/orgs/<id>/forbered` (any member; "Förbered möte" next to "Starta möte", whose "Nästa möte" row links the
next prepared agenda with "Dagordning" and "Ändra"). `PrepareMeeting` (container) / `PrepareMeetingView`
(`components/views/PrepareMeeting.tsx`), three steps under the title ("1. Möte — 2. Dagordning — 3. Klart"):

1. **Vilket möte?** Three radio cards, Veckomöte preselected (Styrelsemöte, Årsmöte), Datum (proposed:
   the last meeting's weekday, on or after today) and optional Tid (its time, to the quarter hour).
   "Ta fram dagordningen".
2. **Dagordning** (`GET /api/orgs/<id>/prepare`): one numbered list, each item an editable label with ↑ ↓
   and a grey trash (`danger-ghost`). "Från förra veckan" lists the previous meeting-of-that-kind's open
   tasks as the Doc will show them, each with a checkbox (untick = not on the agenda), under a grey line
   naming the source ("Öppna uppgifter från mötet 24 nov."). An imported protocol (0032) newer than the
   last real meeting and at most 60 days before the date is the source instead ("… från protokollet
   19 nov (inläst)."; its tasks are text lines, a ✓ klart never reaches the imported history). Nothing to
   carry: the line says why ("Inget tidigare möte än. Testmöten räknas inte." / "Senaste protokollet är
   från 20 aug — för gammalt för att ta med uppgifter."). "Lägg till punkt"
   (placeholder "T.ex. Fest på universitetet") adds before the items the format keeps last (the button
   or Enter); text still in the field when "Skapa dagordning" is pressed is added too, never lost. "Fler punkter"
   holds recurring Översikt topics ("Har tagits upp på N möten") and removed standing items, dashed, with
   "Lägg till". "Skapa dagordning" (primary, the only one) → "Skapar dokumentet …". Preparing again for a
   date that has one: info banner "Du ändrar en förberedd dagordning" and "Uppdatera dagordningen"; a
   date a meeting was held in: neutral banner, nothing editable.
3. **Klart**: success banner with the Doc name, what happens on meeting day, "Öppna dokumentet" (primary)
   and "Till <förening>". When someone had written in the Doc, a grey line says the order there was kept.

The Doc: `YYYY-MM-DD[ HH.MM] Dagordning – <förening>` in the meeting folder (else the preparer's own
folder), shared with the members, the format's skeleton with the chosen items; "Från förra veckan"
lines are written by the notes engine (`ss-prep-<id>-c<n>`), so the meeting adopts them and writes
"✓ klart" in the same line. Preparing again changes only Simon Says' untouched lines.

**Start screen.** `AgendaStep` view state `prepared` comes first: "Starta med dagordningen från
<tisdag 1 december> kl. 18.00", grey "<typ> · <Doc-namn>", **Använd** · Välj annan · Skapa nytt
dokument. No format select (the prepared format is used). If the starter's Google account can't edit it
yet (prepared by someone else, drive.file): a line saying so and **Öppna i Google-väljaren**. The
Picker-off fallback shows it too. `/design`: `org-start`, `org-prepared`, `prepare-*` (incl. `prepare-draft-import`,
`-no-meeting`, `-too-old`), `live-agenda-prepared`,
`live-agenda-prepared-picker`.


## Kom igång (onboarding, todo #5, migration 0035)

After "Skapa förening" the admin lands on `/orgs/<id>/kom-igang`: one step per screen, a six-part
progress rail (done = ink, skipped = grey, here = blue; never dots; each part jumps to its step),
"Steg n av 6", the step's title and lead, and one footer (Tillbaka · Hoppa över · Fortsätt). Steps
slide in from the right going forward, from the left going back (`animate-step-in` / `-back`, off
with reduced motion). Progress is saved on every Fortsätt / Hoppa över (`org_onboarding`) and kept
in `?steg=n`; the förening page shows the admins a "Kom igång n/6" card (`KomIgangCard`, Fortsätt ·
Dölj) until every step is done or skipped. Föreningar from before 0035 have no row and no card;
Inställningar links to the guide.

1. **Namn och logga**: the name, and a logo cropped to a centred 256 px square in the browser
   (`squareLogo`), uploaded to `POST /api/orgs/<id>/logo` (bytes checked: PNG/JPEG/WebP, ≤ 1 MB),
   stored privately in storage `org-logos/<id>/logo`, served member-checked at
   `GET /api/orgs/<id>/logo?v=…`. `OrgLogo` shows it on the förening page and in the list only,
   never in the Docs; without one, the first letter on ink.
2. **Styrelsen**: ONE list (`boardRows`, `lib/people/board.ts`): people (name, role) plus members
   nobody has named yet ("Namn saknas" + Lägg till namn). An e-mail invites (`set_person_email`):
   the person is linked to the member account with that address now or when they join
   (`org_members` trigger). Under the list, "Bjud in via mejl" (below) sends the invite e-mail; a
   button fills in the people with an e-mail not invited yet. The link is also shown to copy. Status
   line: "Har konto" (green) · "e-post · Inbjudan: skickad <datum>" / "ingen inbjudan skickad än" ·
   "Bara namn". The Personer panel shows "Inbjuden · e-post".
3. **Mötesmapp**: the existing folder Picker (`useMeetingFolderPicker`).
4. **Så brukar ni ha möten**: Veckomöte (förvalt; Fortsätt makes it the default when the förening
   has none), "Som våra gamla protokoll" (the existing `LearnFormatView`), or "Behåll …" when a
   format is already chosen. **Stadgar**: one Claude call (`extractStadgarAgendas`, oneShot spend
   gate) gives the Styrelsemöte's required items and the Årsmöte's agenda; both lists are editable
   and saved with `POST /api/orgs/<id>/onboarding/formats` as non-default versions the förening
   points at (`orgs.styrelse_format_id`, `orgs.arsmote_format_id`, `set_type_format`). Förbered
   möte uses them; no årsmöte list → the standard Årsmöte.
5. **Era tidigare möten**: explains the import and links to `/orgs/<id>/protokoll` (the import on
   Översikt); nothing is reimplemented.
6. **Röster (valfritt)**: says the plan honestly (the name round in the first meeting becomes the
   voice; the feature is still a spike) and records per person who has said yes
   (`set_voice_consent`: when + by whom). The feature must ask the person again before storing anything.

**Klart**: what was done (✓) and skipped (– · Gör nu), "Förbered första mötet →" (primary).
`/design`: `onboarding-*`, `org-kom-igang`, `orgs-logos`.

## Sammanfattning efter mötet (Simon's todo, migration 0037)

**Setting** (Inställningar, admins; `SummarySettingsForm`, `updateSummaryAction` → `set_summary_settings`):
four radio cards, **Till de som missade mötet** (default) · Till alla · Till utvalda personer · Av. "Utvalda"
opens a checkbox list of the people list (no address: disabled, "Ingen e-postadress"). Other modes show how many people have an address. Ticks are kept when the mode changes.

**When**: `finishMeeting` sets the meeting `done`, then `trySendMeetingSummaries` (best effort, never changes the
end); the 5-minute cron (`sendPendingSummaries`) sends what that skipped: a Doc paused at the end (after its final
pass), a failed attempt; only meetings that ended in the last 48 h. Once per meeting (`meetings.summary_state`
claimed atomically: null → `sending` → `sent`) and per person (`meeting_summary_sends`, inserted before the
mailer is called; a failed send is not retried). The loop stops before the caller's deadline and the cron resumes
`sending` meetings, also one whose function died mid-loop. A recipient whose preference check can't be answered
is not claimed (the meeting stays `sending` and the next sweep retries); a meeting still `sending` after 48 h
becomes `partial` (event with counts). Never for a Testmöte, never when the meeting has no decision, open task or other note.

**Who** (`lib/summaries/recipients.ts`): only the förening's people with an address (the linked account's,
else `people.email`), deduplicated. Present = a named voice (speaker map, merges), a Närvarande name (full or
first name; an ambiguous first name counts all of them as present), or the starter's account. Attendance is
*certain* only when someone was identified by voice or Närvarande (the starter alone doesn't count) and no voice
is unnamed ("Talare 2" on a shared mic, "Anna?") and no Närvarande text names nobody in the list ("hela
styrelsen", "alla"); otherwise "missed" sends nothing (`uncertain`, with the count
of unnamed voices in the event) and "alla"/"utvalda" send with neutral wording. Every send goes through the e-mail gate
(`sendUserMail`, category `meeting_summary`, 0039): whoever said no never gets it (counted as `optedOut`); a person whose member link was removed (`summary_removed_at`) gets nothing by the old address. E-mail
addresses are written only by the admin functions.

**The e-mail** (`lib/summaries/email.ts`, design A "Calm Geist" from the invite e-mail): subject
"Sammanfattning: <förening> <24 november>", "Du missade mötet 24 november" (or "Mötet 24 november"),
**Dina uppgifter** first in a grey box (owner id, name or role), Beslut, (Övriga) uppgifter with owners, Övrigt
(max 3); lists capped with "… och N till i protokollet"; no Må-runda items, no info cells, no done tasks.
**Öppna protokollet**: the Doc for the starter and members it was shared with; other members go to the meeting's
row on the förening page (`#mote-<id>`, Få åtkomst); people without an account get the Doc with a line on asking
for access. Footer: "Ändra vilka som får sammanfattningar" (admins) · **Avsluta prenumeration** (the address's `/mejl`
page, `k=meeting_summary`); headers from `listUnsubscribeHeaders` (one-click `POST /api/mejl/avsluta`). Logs and the `summary` event hold counts only.
`/design`: `org-summary-*`, `summary-email*` and `org-admin`. Screenshots:
`emails/summary/shoot.sh` (desktop/phone, light/dark, into `.superpowers/meeting-summary/`).

## Bjud in via mejl (migration 0038)

Admins type or paste addresses (comma, semicolon or new line; "Namn <adress>" works) in the Bjud in
panel on the förening page and in Kom igång → Styrelsen (`InviteByEmail`). The hint counts valid
addresses, marks members ("är redan medlem") and what isn't e-mail. "Visa mejlet" previews the e-mail
(React, never injected HTML). "Skicka N inbjudningar" → `POST /api/orgs/<id>/invites`; each address
gets a line: Skickat (green) · Redan medlem · Ogiltig adress · Misslyckades + Försök igen · Redan
inbjuden · limits. "Skickade inbjudningar" lists every invite (Skickad · Misslyckades · Har gått med,
with time) with "Skicka igen", once per address per 24 h ("Igen <tid>" after). The link to copy stays
under it ("Eller dela länken själv").

The e-mail is design A, "Calm Geist" (`lib/invites/email.ts`; reference rendering
`emails/invite/a.html` + `a.txt`, screenshots with `emails/invite/shoot.sh`): wordmark, one card,
"Gå med i <förening>", one paragraph, one black button with the förening's join link, the link as
text, and the footer "Du får det här mejlet för att <namn> lade till din adress … Väntade du dig inte
mejlet kan du strunta i det". Subject "<namn> bjuder in dig till <förening> på Simon Says"; Reply-To
is the admin. Two other directions were considered and dropped: B, a warmer letter with the
förening's initial and a "what you get" list, and C, a richer card with steps and a preview of a
meeting Doc. A was chosen as the calmest and closest to the app.

Limits (`claim_invite_send`): 50 per förening and 200 per admin in 24 h; members are skipped; the
invite turns "Har gått med" when someone joins with that confirmed address. No addresses in logs.
A förening or inviter name that looks like a link or address (`looksLikeLink`: `://`, `www.`, `@`,
`x.se`) is refused with a sentence asking to rename it (the form says so up front); every dot in a
name gets a zero-width non-joiner in the e-mail, and the subject is cut at 80 characters. The form
sends 10 addresses per request (two at a time, no new send after 40 s: "Hann inte skickas"). A
timeout or 5xx is "Osäkert – kan ha skickats"; Försök igen reuses the send's Resend Idempotency-Key,
so it can't arrive twice. Sends hung in `sending` for 5 min are swept to `uncertain` by the import cron.
Every invite goes through the mail-settings gate (0039, `sendUserMailDetailed`, category
`invite`), checked before `claim_invite_send` so an address that said no uses no quota: its line says
"Vill inte ha mejl" (no retry). Each e-mail carries the recipient's own settings link
(`emailPrefsUrl`) in the footer and List-Unsubscribe headers.
`/design`: `invite-email*`.
