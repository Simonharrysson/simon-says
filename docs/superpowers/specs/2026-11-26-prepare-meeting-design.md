# "Förbered möte" — design (todo #6, approved by Simon 2026-11-26 "kör")

## Why
Today the agenda Doc is written by hand and the meeting starts at once from "Starta möte". Simon: the prepared agenda "isn't very good", "Från förra veckan" hasn't been seen working, and the ordförande needs a separate step to prepare *before* the meeting.

## What the ordförande does (Simon's words + my playback, approved)
1. "Förbered möte" on the förening page (any member may prepare; my call).
2. Choose meeting type: **Veckomöte** preselected ("almost always"), Styrelsemöte, Årsmöte. Plus date (and optional time) of the meeting.
3. Simon Says drafts the agenda: the format's standing items; **"Från förra veckan"** filled with the open tasks per person/role from the previous real meeting(s) of the same kind; items that recur at several meetings pre-suggested.
4. The ordförande adds what Simon Says can't know ("+ Lägg till punkt", e.g. a party at the university), can reorder/remove.
5. "Skapa dagordning" → Simon Says creates the agenda Doc **in the förening's meeting folder with the correct name** (doc-place branch), editable in Google Docs as usual.
6. Meeting day: "Starta möte" suggests the prepared Doc automatically (Simon Says created it, so drive.file allows it); no Picker needed. Starting in it = existing agenda mode.

## Decisions (mine)
- Årsmöte: new standard format with a standard agenda (mötets öppnande, val av mötesordförande/sekreterare/justerare, stadgeenlig utlysning, verksamhetsberättelse, ekonomisk berättelse, revisionsberättelse, ansvarsfrihet, val av styrelse, motioner/propositioner, övriga frågor, avslutning). Årsmöte agenda from the förening's own stadgar is part of onboarding (todo #5), not this task.
- A prepared-but-not-started agenda is stored (meeting row in state "prepared" or a separate table — builder's call, additive migration) so the start screen can find it; one prepared agenda per förening and date; preparing again edits it.
- No Claude call needed for the draft (DB data + format profile). Optional later: Claude wording polish.
- Must prove end to end with a Testmöte: prepare → start → "Från förra veckan" lists last meeting's open tasks → "✓ klart" flows back.

## Non-goals
Calendar invites, sending the agenda by email, stadgar-derived årsmöte agenda (onboarding).
