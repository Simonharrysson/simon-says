# Product

<!-- impeccable:product-schema 1 -->

> Inferred from `docs/design.md`, `docs/plan.md` and Simon's UI brief (2026-11-24). No interview
> round was possible (unattended run); every line below is taken from those documents, not invented.

## Platform

web

## Users

- **The meeting runner** — a student or volunteer in a Linköping organisation (LiU AI Society,
  Hook & Look Golf). Opens one page on a laptop at the meeting table, confirms everyone knows
  the meeting is transcribed, presses Start, and keeps half an eye on it while taking part.
  Low patience, distracted, often mid-conversation.
- **Org members** — sign in with Google, sometimes on a phone, to join an org from an invite link.
- **Everyone else in the room** — no account; a name in the org's person list.
- **Visitors from LinkedIn / GitHub** — read the landing and status pages to understand what
  Simon built.

## Product Purpose

Free service: structured meeting notes (decisions, action items, the current topic) build up
live in the organisation's own Google Doc while people talk; the raw transcript lives in a
second tab. Success = the secretary stops typing minutes and trusts the Doc.

## Positioning

Live, structured notes written straight into Google Docs during an in-person meeting, from one
laptop's built-in microphone, and a hard rule that the service never overwrites what a person
typed in the Doc.

## Operating Context

One laptop on a table, in a room, people talking. Consent in the room before Start; a Paus
button. Meetings up to 4 h (warning at 3 h 45). The Doc is the real output; the web page is the
control panel. Swedish UI.

## Capabilities and Constraints

- Google sign-in (drive.file only). Orgs (max 2 created per user), invite links, person list,
  meetings list with delete rules, per-org settings (share transcript, show on status page).
- Live page: consent, Start / Paus / Stopp, timer, partial text, Doc link, reconnect and
  Doc-paused states, stale-notes warning, name round, speaker list.
- Public `/status` and `/integritet`. Personal-data controller: Harrysson & Company AB.
- No pricing, no customers, no testimonials exist; none may be invented.

## Brand Commitments

- Name: Simon Says. Swedish copy, short, warm, clear, no jargon.
- Doc header vocabulary: `● LIVE · uppdaterad HH:mm`, sections Beslut / Att göra / Pågår nu.

## Evidence on Hand

- The Doc layout sketch in `docs/design.md` (real section names). No screenshots of real
  meetings, no real user quotes. Demonstration notes on the landing page are synthetic.

## Product Principles

1. Humans' words win: never overwrite, always visible when the service pauses.
2. Calm in the room: the page must not pull attention from the meeting.
3. Honest state: always show whether notes are flowing, paused or stale.
4. Consent before capture.

## Accessibility & Inclusion

WCAG AA contrast in light and dark, keyboard and screen-reader friendly, mobile-first.
