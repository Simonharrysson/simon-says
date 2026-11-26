# Onboarding — proposal (todo #5; #7 depends on it). NOT approved yet.

Simon: "make like an onboarding, where voices can (not mandatory) be learned, logo for org, and sync all older meetings … This has to be customer delight so make it beautiful and intuitive." Plus (2026-11-26): stadgar upload belongs here and should give both Styrelsemöte and Årsmöte.

## Flow (after "Skapa förening"; each step skippable, progress saved, resumable from the förening page)

```
 Ny förening ─────────────────────────────────────────────  1 2 3 4 5 6
 ┌──────────────────────────────────────────────────────────┐
 │  [logo]  Hook & Look Golf                                 │  1. Namn & logga
 │          Ladda upp logga (valfritt)                       │
 ├──────────────────────────────────────────────────────────┤
 │  Styrelsen                                                │  2. Styrelsen — ONE list:
 │  Anna Berg     Ordförande   anna@…   [Bjud in]            │     name, role, e-mail optional
 │  Erik Lund     Kassör       —                             │     (replaces Personer + Medlemmar
 │  + Lägg till                                              │      double entry, U3)
 ├──────────────────────────────────────────────────────────┤
 │  Mötesmapp  📁 Verksamhetsår 2025-2026  [Byt]             │  3. Folder (Picker)
 ├──────────────────────────────────────────────────────────┤
 │  Så brukar ni ha möten                                    │  4. Format: Veckomöte default ·
 │  (•) Veckomöte  ( ) Lär från ett gammalt protokoll        │     learn from old minutes ·
 │  Stadgar: [Ladda upp]  → styrelsemöte + årsmöte           │     stadgar → Styrelsemöte + Årsmöte
 ├──────────────────────────────────────────────────────────┤
 │  Era tidigare möten   [Välj protokoll…]  12 valda         │  5. Import old minutes (Picker multi-
 │  ▓▓▓▓▓▓▓░░░  läser 7 av 12 …                             │     select) → decisions, tasks, topics
 │                                                           │     → Översikt + goals (#7)
 ├──────────────────────────────────────────────────────────┤
 │  Röster (valfritt)                                        │  6. Voices: optional, see below
 ├──────────────────────────────────────────────────────────┤
 │  Klart! [Förbered första mötet →]                         │  → "Förbered möte" (todo #6)
 └──────────────────────────────────────────────────────────┘
```
(Rendered as one calm step at a time with the progress bar, not one long page; the sketch shows all at once.)

## Open questions for Simon
1. **Voices:** ElevenLabs live STT labels speakers per meeting only; it cannot recognise a stored voice. Learning voices needs our own speaker-embedding step (e.g. a small model on the server or later on the Jetson) + storing a voice sample per person (biometric data → explicit consent, GDPR special category). Proposal: onboarding v1 keeps the name round and shows "Röster — kommer snart"; a separate spike measures whether embeddings work well enough. OK?
2. **Logo:** shown on the förening page and in the Doc header? (my pick: both; small, top of the Doc)
3. **Import cost:** reading old minutes uses Claude (≈ $0.02–0.05 per protocol). Anthropic budget is ~$7 until Dec 1 → build now, run real imports after Dec 1. OK?

## My calls
- Steps skippable; onboarding reopens from a "Kom igång 3/6" card on the förening page until done.
- Styrelsen list merges people + members: a person can exist without an account (name only); adding an e-mail sends the invite link.
- Import reads only structure + decisions/tasks into the DB (same privacy line as learn-format), never stores Doc text.
