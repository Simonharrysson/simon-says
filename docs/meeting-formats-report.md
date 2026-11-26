# Meeting formats — report (2026-11-26)

## What works on prod (simonsays.harrysson.co = branch v1, migrations 0023–0027)

- **Agenda mode:** start a meeting in the ordförande's own agenda Doc. Notes are written live under the right agenda item, tasks by role in "Vad ska vi göra till nästa gång?", "Från förra veckan" pre-filled from last meeting's open tasks ("✓ klart" flows back to earlier meetings), Må-runda kept out of the notes, Närvarande/Tid filled, "Simon Says · avslutat" at the end. Human edits always win.
- **No agenda:** a new Doc in the förening's format.
- **Formats:** Veckomöte, Styrelseprotokoll (upload the stadgar and Simon Says adds the required items), Enkel. Or "Lär Simon Says ert format" from a template or old minutes (only structure leaves the Doc), or "Anpassa format" to edit the current one (e.g. remove Må-runda).
- **Roles:** give each person a role ("Kassör"); tasks are written by role. Saying a name, a first name or a role ("kassören") all work; otherwise the owner is written as said.
- **Checks:** three Testmöten on prod with a fictional Veckomöte agenda; paid eval (placement 20/20, roles 14/14, Från förra veckan 8/8, Må-runda leaks 0, $1.18 per meeting hour); `npm run suite` scorecard (all features PASS); three final reviews, all fixes re-reviewed.

## Already set up for Hook & Look (done 2026-11-26, structure only)

- The förening's format is **Veckomöte**. (Simon Says also learned your "Mall_mötesprotokoll" template; it lacks "Från förra veckan", so Veckomöte fits better. The learned one is in the format list if you prefer it.)
- The meeting folder is **"Verksamhetsår 2025-2026"**.

## What to try at Hook & Look's first real meeting

1. Before: on the förening page, give the board their roles (Ordförande, Kassör, …) and invite them with the link.
2. The ordförande writes the agenda Doc as usual in "Verksamhetsår 2025-2026".
3. At the table: "Starta möte" → "Välj dagordning" (opens the Picker in the meeting folder — pick today's agenda; Google only lets Simon Says see Docs you pick, so it can't suggest it by itself) → consent → name round ("Jag heter …") → Må-runda.
4. Watch the Doc: notes appear under the item being discussed; type freely — your edits win.
5. After: check with the secretary what was missing or placed wrong; write it in docs/learnings.md.

Still needs live ElevenLabs credits (docs/checklist-11-28.md) before a real meeting can be recorded.

## Known limits

- Simon Says can't auto-suggest an agenda Doc it didn't create (Google's drive.file). Idea: a "Skapa dagordning" button that makes next week's agenda through Simon Says.
- Styrelseprotokoll placement was 9–10/11 in eval runs (one point occasionally under the wrong §).
- If two people start in the same Doc at the same second, the loser's Datum/Tid text can stay in the cells.
