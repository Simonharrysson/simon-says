# Meeting formats and live notes in the förening's own agenda Doc — design

Date: 2026-11-25 · Status: approved by Simon via /goal (2026-11-25) · Builds on `docs/design.md` (v1 live notes).

## Intent

Simon Says today creates its own Doc with four fixed sections (Närvarande, Beslut, Att göra, Pågår nu). Real
föreningar don't work like that. In Hook & Look Golf the **ordförande writes the dagordning in a Doc before every
weekly meeting**, and the secretary writes notes into that same Doc during the meeting. Other föreningar write formal
§-numbered styrelseprotokoll that must follow their stadgar.

So Simon Says must (1) write **into the agenda Doc the ordförande already prepared**, live, under the right agenda
item, and (2) write in **the förening's own format** — a standard one they pick, or one learned from their own old
minutes — while (3) never copying poor quality: decisions and tasks are always complete and in tidy full sentences.

Why it matters (Simon): winning ground against other note-takers is about notes that live in the Doc people already
use, look like their own minutes, and never fight the humans editing next to them.

## Goals

- **G1 Agenda Doc mode.** At start, Simon Says finds (or the starter picks) the agenda Doc, anchors its structure and
  writes live: notes, decisions and tasks under the agenda item being discussed; tasks also under "Vad ska vi göra
  till nästa gång?"; loose remarks under "Anteckningar".
- **G2 Format profiles.** Three standard formats — **Veckomöte**, **Styrelseprotokoll**, **Enkel** — and **learned**
  formats. One default per förening; changeable at start.
- **G3 Learn a format.** An admin points Simon Says at a template Doc ("Mall…") or 3–5 old minutes (Google Picker);
  Claude proposes a profile; the admin reviews/edits and approves.
- **G4 Always complete.** Every decision is a "Beslut:" line under its agenda item; every task has owner and due when
  said; full, tidy sentences (Simon: "tidier full sentences").
- **G5 Roles.** People can have an optional role (Ordförande, Kassör, PR …). Tasks are attributed by role when the
  person has one ("Kassör: …"), else by name.
- **G6 Från förra veckan.** Before the meeting, the "Från förra veckan" agenda item is pre-filled with the previous
  meeting's open tasks, grouped by role/person.
- **G7 Må-runda.** Nothing from the Må-runda goes into the notes ("Må-runda genomförd" at most). Its segments feed the
  name round (everyone speaks there) and, later, voices.
- **G8 Fallback.** No agenda Doc → a new Doc in the chosen format (today's flow, generalised).

## Non-goals (this round)

- Voice enrolment / remembered voices (v1.1). Må-runda only feeds the name round now.
- The org goals dashboard (todo #2) — but G6 stores task status in a way the dashboard can build on.
- Editing the Styrelseprotokoll's legal content (justering workflow, digital signatures).
- Multi-language format profiles; Swedish UI and Swedish/English notes as today.

## Anti-goals (would be failures even if it "works")

- Writing into a human's agenda text or deleting/reordering anything the ordförande or secretary wrote.
- Copying content from a förening's old minutes into notes, prompts or the repo (privacy; the real Hook & Look minutes
  never enter the repo — fixtures are fictional).
- Copying poor quality: thin notes because their old minutes were thin.
- Guessing the wrong agenda Doc silently (newest-in-Drive is wrong — Simon: "the newest could be bullshit").

## Constraints (carried from v1)

- Every guarantee from `docs/design.md` and the plan's Global Constraints holds: human edits win (paragraph diff,
  locked items), revision-guarded writes with re-read/retry, writes only inside our own named ranges, Claude ops
  (add/change/remove) not full rewrites, prompt-cached append-only transcript blocks, usage caps, kill switch.
- Google scope stays `drive.file`: Simon Says may only touch files the user picked (Picker) or that Simon Says
  created. Consequence: we can't list a folder freely. See "Finding the agenda Doc".
- Migrations backward compatible, explicit grants, RLS. CI is the DB gate. UI Swedish, code English.
- Claude budget for evals ≤ $5 (org limit $70/month; ~$8 left until Dec 1 — check before spending).

## Approaches considered

1. **Live into their agenda Doc (chosen).** Anchor the agenda at start; render live under items with the existing
   machinery. Delivers the core bet; hardest part is coexisting with humans editing the same Doc — which v1's
   protections already handle.
2. Live in our own "Live" tab, write into the agenda once at the end. Safer, but the agenda stays empty during the
   meeting — loses the live value.
3. 2 first, then 1. Fastest to a first meeting but builds the hard part twice.

Simon picked 1 (2026-11-25).

## Concepts

### Format profile

A JSON document per förening (`format_profiles` table, versioned; one marked default per org):

```jsonc
{
  "kind": "veckomote" | "styrelseprotokoll" | "enkel" | "learned",
  "title": "Mötesprotokoll",                     // Doc title line
  "infoTable": ["Datum", "Tid", "Närvarande", "Sekreterare"],   // header fields; null = no table
  "agendaHeading": "Agenda",                     // or null (Enkel)
  "fixedAgendaItems": [                           // items every meeting has, in order
    { "key": "approve", "label": "Godkänn dagordning", "role": "procedural" },
    { "key": "checkin", "label": "Må-runda", "role": "checkin" },      // G7: excluded from notes
    { "key": "followup", "label": "Från förra veckan", "role": "followup" }, // G6
    { "key": "other", "label": "Övrigt", "role": "other", "position": "last" }
  ],
  "numbering": "numbered" | "paragraph" | "none",   // 1. 2. … / §1. §2. … / none
  "tasksSection": { "label": "Vad ska vi göra till nästa gång?", "groupBy": "role" | "person" } | null,
  "notesSection": { "label": "Anteckningar" } | null,
  "decisionPrefix": "Beslut:",
  "taskStyle": "role-first",                      // "Kassör: Mejla klubben om avgiften (fre)."
  "tone": "full-sentences",                       // always; G4
  "signatures": null | ["Mötesordförande", "Mötessekreterare", "Justerare"],
  "requiredItems": []                             // Styrelseprotokoll: from stadgar, e.g. "Val av justerare"
}
```

The three standard profiles ship as constants. A learned profile uses the same schema (`kind: "learned"`) and is
always admin-approved before use.

### Anchors (generalising v1's four sections)

v1: a note item has `section ∈ {attendees, decision, action, now}` and renders after that section's anchor range.
New: a note item has

- `kind ∈ {decision, task, note, attendee, now}` — what it is (drives formatting: "Beslut: …", role/owner prefix,
  plain sentence),
- `anchor` — where it lives: an agenda item anchor (`ag-<n>`), or a format section (`tasks`, `notes`, `attendees`,
  `now`).

A task may appear twice: under its agenda item (context) and in the tasks section (the per-role list). It is **one
item with one id rendered in two places**, each place its own named range (`ss-<meeting>-<id>` and
`ss-<meeting>-<id>-t`); human edits to either copy lock that copy only. (Builder detail: simplest safe rule is that a
locked copy freezes, the other copy keeps updating.)

`meetings.section_ranges` becomes the anchor map `{anchorKey: namedRangeName}` (same column, wider content —
backward compatible). v1 meetings keep working: their four keys are valid anchors.

### Rendering into a human Doc

- At start (agenda mode) Simon Says reads the agenda Doc once and creates **anchor named ranges**: one per agenda item
  paragraph (top-level list items under the agenda heading), one on the tasks-section heading and one on the
  notes-section heading. If a section heading the profile expects is missing, Simon Says **appends** it at the end of
  the Doc (our own text, our own range) — never inserts between human paragraphs except as sub-bullets below.
- Our notes for an agenda item are inserted **after the last paragraph belonging to that item** (its nested
  sub-bullets, human or ours), as nested bullets one level deeper than the item. They are our own named ranges, so
  every v1 rule applies: paragraph-diff locks human edits, revision guard, retries, ambiguous ranges skipped.
- Human sub-bullets under the same item stay where they are; ours go after them. If a human types after our last
  bullet, ours still go after the human's last paragraph of that item (we never interleave).
- Agenda items added during the meeting by a human (new top-level item) get an anchor on the next tick (re-scan the
  agenda list each tick; new items → new anchors; deleted items → their notes move to "Anteckningar"? **No** — notes
  under a deleted item stay deleted-by-human per v1 rules; Claude may re-place relevant content).
- The info table: Simon Says fills empty cells only (Datum, Tid, Närvarande from the name round, Sekreterare left as
  typed). Filled cells are never touched.
- Header/LIVE indicator: in agenda mode there is no "● LIVE" header line in the human's Doc; instead a small line at
  the top of the notes section is our own range ("Simon Says antecknar live · uppdaterad 12:31") that becomes
  "Simon Says · avslutat 12:58". (My call: keeps the health signal without touching their title.)
- Transcript: a "Transkript" tab is added to the agenda Doc (if share_transcript), as today.

### Claude's view (engine)

The notes engine gets, per tick: the agenda (item anchors + their labels + the human text under them, read-only),
the format profile summary, people with roles, and the current items. Ops gain `kind` and `anchor`; validation
rejects unknown anchors, notes under `checkin` (Må-runda), and items under `followup` (owned by G6). Prompt rules:
place each point under the agenda item being discussed (use the transcript's flow and the labels); decisions as
"Beslut: …" full sentences; tasks with owner (role when known) and due; loose remarks that fit no item → `notes`;
nothing from Må-runda; never duplicate what a human already wrote under that item.

### Finding the agenda Doc (G1, `drive.file`-safe)

1. Each förening has a **meeting folder** (Drive folder id) — set when the admin learns the format from old minutes
   (the folder those Docs live in) or picks a folder in settings. (My call: also settable directly, since
   standard-format föreningar have no "old minutes" step.)
2. With `drive.file` we can't list the folder unless the folder itself was picked. So the folder is picked with the
   Picker (`setSelectFolderEnabled`) once — that grants access to list it. (Verify on first build: if folder-pick
   doesn't grant child listing under drive.file, fall back to: the starter picks the agenda Doc in the Picker every
   time, pre-opened in that folder.)
3. At start, candidates = Docs in the folder created/modified in the last 7 days, not already used by a meeting
   (`meetings.doc_id`), ranked by: title contains today's date in any common format (2026-11-25, 25 nov, 25/11) >
   created this week > modified recently. The top one is **suggested**; the starter confirms or picks another.
   Never auto-used without confirmation.

### Learning a format (G3)

- Admin clicks "Lär Simon Says ert format" → Picker (multi-select, Docs only) for 3–5 old minutes **or** a template.
- If a picked Doc's title matches /^mall|template/i it's treated as the template (strongest signal).
- Claude reads the docs (structure-focused prompt: headings, table fields, recurring agenda items, task layout,
  numbering, roles used) and returns a format profile + a short Swedish explanation + a **quality note** ("era
  anteckningar saknar ofta ansvarig och datum — Simon Says skriver alltid ut dem"). Content of the minutes is never
  stored: only the profile. (Picked doc ids are not stored either, except the parent folder id for G1.)
- The admin sees a preview (rendered skeleton of the profile) and can edit fields (title, table fields, fixed agenda
  items, sections, group tasks by role/person) before approving.
- Styrelseprotokoll: the admin may pick the förening's **stadgar** (Doc or PDF); Claude extracts required agenda
  items (e.g. val av justerare, fråga om beslutsmässighet) into `requiredItems`; the format includes them.

### Roles (G5)

`people.role` (nullable text, ≤ 40 chars, validName-like rule). Editable on the förening page. The name round fills
names; roles are set by the admin. Task owner text = role if the owner has one and the profile groups by role, else
the name.

### Från förra veckan (G6)

- Tasks are stored (`note_items` kind task) with owner person id when resolvable. A task is **open** unless a later
  meeting's notes mark it done (Claude may emit `change` with `done: true` when someone reports it done under
  Från förra veckan; humans can tick it — a checked "☑"/strikethrough in the Doc counts as done when diffed).
- At meeting start (agenda mode), Simon Says writes under the "Från förra veckan" item (our own ranges) the previous
  meeting's open tasks grouped by role/person: "Kassör: Mejla klubben om avgiften." If the ordförande already wrote
  things there, ours go after theirs and Claude is told not to duplicate.
- Previous meeting = the latest `done` meeting of the same förening.

### Må-runda (G7)

Segments spoken while the agenda item "Må-runda" is current are marked (tick time window between the item becoming
current and the next item) and excluded from Claude's notes input except as a placeholder ("[Må-runda — utelämnad]"),
but **included** in the name-round input. (How "current item" is known: Claude's placement of the previous tick +
the agenda order; Må-runda is normally item 2 — my call: the window ends at the first segment Claude places under a
later item.)

## Data model changes (additive)

- `format_profiles` (id, org_id, kind, profile jsonb, approved_by, approved_at, created_at, is_default) — RLS: members
  read, admins write.
- `orgs.meeting_folder_id text null`.
- `people.role text null`.
- `meetings.agenda_doc boolean default false`, `meetings.format_profile_id uuid null`,
  `meetings.section_ranges` reused as the anchor map.
- `note_items.kind text null` (null = legacy, derived from section), `note_items.anchor text null`,
  `note_items.done boolean default false`, `note_items.owner_person_id uuid null`.
- `meeting_events` kinds: `agenda_anchored`, `format_learned`, `followup_prefilled`.

## UI

- Förening page → new "Mötesformat" card: current default (Veckomöte/Styrelseprotokoll/Enkel/Eget), "Byt",
  "Lär Simon Says ert format" (Picker), "Mötesmapp" (Picker, folder), role field per person in the people list.
- Live-page start (`/meetings/ny/<orgId>`): after consent, "Dagordning: <suggested Doc> · Byt" or "Ingen dagordning –
  skapa nytt dokument i formatet <X>". Format override dropdown.
- Copy Swedish, docs/ui.md design system.

## Testing

- Unit: anchor scan of agenda Docs (fixture JSON of a fictional Veckomöte Doc: table + numbered agenda + nested
  bullets), render under items, human paragraphs untouched, new item mid-meeting, missing sections appended.
- Eval (extend `scripts/notes-eval`): fictional agenda + transcript fixtures → placement accuracy (each expected
  point under its expected agenda item), roles in tasks, Från förra veckan content, zero Må-runda content, all
  existing bars (churn ≤ 15 %, recall 100 %, ≤ $1.75/h). Budget ≤ $5.
- Testmöte: an agenda-mode Testmöte — the admin-only feeder first creates a fictional Veckomöte agenda Doc in the
  förening's meeting folder (or uses one picked), then replays a fictional transcript that follows that agenda (incl.
  a Må-runda and a "Från förra veckan" round); a second run pre-fills Från förra veckan from the first.

## What's left to the builder

Exact prompt wording; ranking heuristics for agenda candidates; preview rendering of a profile; how the format editor
looks within docs/ui.md; the precise Docs API sequence for nested bullets (createParagraphBullets with nesting level
vs. tab indentation — measure on a real Doc first and record in docs/learnings.md).

## Calls I made (Claude) — not discussed with Simon

- In agenda mode the LIVE indicator lives in our own line at the top of the notes section, not in their title.
- Meeting folder is settable directly (not only via learning).
- A task renders in two places (under its item and in the tasks section) as one item.
- Må-runda window ends at the first segment placed under a later item.
- Deleted agenda items: our notes there follow v1 deletion rules (not moved).
- Info table: fill empty cells only.

## Builder check (2026-11-25) — answers

Fresh-builder questions, all settled without Simon (my calls unless marked "observed"):

1. **Whose Google grant reaches the agenda Doc.** Always the **starter's** token (drive.file grants are per user;
   we never write with another member's token). Suggestion of a candidate Doc only works if the starter's own token
   can list the meeting folder (i.e. the starter picked the folder once — "Använd mötesmappen" on first start). If
   not, the Picker opens pre-navigated to the folder (`setParent(folderId)`) and the starter picks the agenda Doc.
   If the starter lacks edit access to the picked Doc, a Swedish error explains it and offers the fallback (new Doc).
2. **Real agenda Doc shape (observed in Hook & Look's weekly minutes, described structurally; no content copied):**
   title line ("Mötesprotokoll:", sometimes a H1), a 2-column info table (Datum / Tid / Närvarande / Sekreterare),
   an agenda heading ("Agenda:" as a plain paragraph or H1), a **numbered list** of items, often with **nested
   sub-bullets prepared before the meeting**; sometimes a sub-heading per topic ("### 4. Kommande event") instead of
   a list item; then "Vad ska vi göra till nästa gång?" (H2 or bold paragraph) with per-role/person lines; then
   "Anteckningar:" (H1 or plain). Scanner rules: agenda items = top-level list items *or* headings below the agenda
   heading and above the tasks/notes headings; tolerant label match ("Agenda"/"Dagordning", case/colon-insensitive).
   Fixed items (Må-runda, Från förra veckan, Godkänn dagordning, Övrigt) are matched to profile roles by Claude once
   at anchoring (cheap call, cached per meeting), falling back to fuzzy string match. Fixture: a fictional Doc built
   with that structure.
3. **When Från förra veckan is filled:** at meeting start (before the first tick), not by a background job.
4. **Task carry-over and "done":** carried tasks are **new note_items** in the new meeting with `carried_from`
   (original item id); the original row gets `done = true` when the new meeting's notes say it's done (Claude op
   `change … done:true` on the carried item, propagated to the origin). Done is shown as "✓ klart" appended by us; a
   human editing the line locks it (v1 rule) and we don't infer done from styles.
5. **Fallback (no agenda Doc):** a new Doc in the chosen format with the format's fixed items, an "Övriga punkter"
   item that collects topics, the tasks section and the notes section. Claude does **not** invent new agenda items
   in v1 of this feature (no "add anchor" op).
6. **Phasing within this goal:** Phase A = format profiles (3 standard), roles, agenda mode for Veckomöte incl.
   anchoring, placement, Från förra veckan, Må-runda exclusion, fallback, Testmöte in agenda mode. Phase B = learn a
   format (Picker + Claude proposal + admin approve). Phase C = Styrelseprotokoll with stadgar (`requiredItems`).
   The first real Hook & Look meeting needs only Phase A. Evals run in Phase A within the $5 cap (check org spend
   first).
7. **Previous meeting:** latest `done` meeting of the same förening **and the same kind**: Testmöten (el_sessions
   kind test → `meetings.is_test`) only pull from Testmöten, real meetings only from real meetings.
8. **Transcript in someone else's Doc:** in agenda mode the start screen asks "Lägg transkriptet i dokumentet?"
   defaulting to **no** (the agenda Doc may be shared more widely than the förening); the transcript is always kept
   in our DB for notes as today.
