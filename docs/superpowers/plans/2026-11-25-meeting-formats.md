# Meeting formats and live notes in the förening's agenda Doc — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simon Says writes live notes into the agenda Doc the ordförande already prepared, under the right agenda item and in the förening's format (three standard formats in Phase A, learned formats in Phase B, Styrelseprotokoll with stadgar in Phase C).

**Architecture:** A format profile (JSON, versioned rows in `format_profiles`) describes a Doc's shape. At start the server reads the chosen agenda Doc once with the starter's `drive.file` token, scans it (title, info table, agenda items, tasks and notes headings), and creates our anchor named ranges in one revision-guarded batch, plus the LIVE line, empty-cell fills and the "Från förra veckan" carry-over. Ticks reuse v1's machinery unchanged in spirit (read → diff → Claude ops → read + diff → guarded render), but ops carry `kind` and `anchor`, and the renderer inserts nested bullets after the last paragraph of an agenda item. Without an agenda Doc, the server builds a skeleton Doc in the chosen format and runs the same pipeline on it (Enkel keeps today's v1 Doc).

**Tech Stack:** as v1: Next.js App Router + TypeScript, Supabase (Postgres, RLS, CLI), `@googleapis/docs` + `@googleapis/drive`, Google Picker (browser, `apis.google.com/js/api.js`), `@anthropic-ai/sdk`, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-meeting-formats-design.md` (binding, incl. its final "Builder check — answers"). v1 context: `docs/design.md`, `docs/plan.md`, `docs/learnings.md`.

**Ordering principle (from v1):** every external behaviour is measured on a real Doc before code is built on it. Task A1 measures the Docs API on an agenda-shaped Doc; Task A11 measures what a Picker folder pick grants under `drive.file`. Findings go to `docs/learnings.md` and may change later tasks before they start.

## Global Constraints

- Every v1 Global Constraint in `docs/plan.md` still holds. The ones this work touches, verbatim in substance:
  - Google scopes stay `openid email profile https://www.googleapis.com/auth/drive.file`. Every Docs request sets `tabId` / `tabsCriteria`.
  - Notes writes: **read + diff immediately before writing**, `batchUpdate` with `writeControl.requiredRevisionId` from that read; on 400 repeat read→diff→write up to 4 times with a random 150–600 ms backoff (`CONFLICT_RETRIES`, `retryDelayMs`).
  - The service never writes outside its own named ranges, except: inserting **new** paragraphs (our own ranges) between paragraphs, filling an **empty** info-table cell, creating anchor named ranges over human text (a named range does not change text). It never edits, deletes or reorders a human's paragraph, list item or cell.
  - Human-edited items are locked (kept verbatim, never reworded or removed, including the final pass); deleted ones are never re-added. The full tab text goes to Claude as read-only context.
  - Claude: `claude-opus-5-5`, streaming, structured output via `output_config.format`, `output_config.effort: "medium"`, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`, `stop_reason` checked before content; transcript as append-only blocks with the cache breakpoint on the newest; every Claude call's tokens recorded (`recordClaudeUsage`); no Claude call under `KILL_SWITCH=1` or past `GLOBAL_DAILY_USD` (`dayUsd()`).
  - Migrations always backward compatible with the code in production (add first, use in a later deploy; widen checks, never narrow); explicit grants; RLS on. CI (`supabase db reset` + vitest) is the DB gate.
  - UI text Swedish, code and comments English; `docs/ui.md` design system.
  - Cost bar ≤ $1.50 per meeting-hour; churn median ≤ 15 %; recall 100 %.
- New migrations start at `0023`.
- **Privacy:** real Hook & Look minutes (or any förening's minutes or stadgar) never enter fixtures, prompts, tests, logs or the repo. Fixtures are fictional with the same structure (spec answer 2). Learned formats store only the approved profile, never minutes content or picked doc ids (only the parent folder id).
- Agenda Doc access always with the **starter's** token (spec answer 1); never with another member's token.
- Never auto-use a candidate agenda Doc: the starter confirms or picks (anti-goal "guessing the wrong agenda Doc").
- In agenda mode: no title change, no "● LIVE" header in their title; our status line lives at the top of the notes section. Transcript tab only if the starter answers yes to "Lägg transkriptet i dokumentet?" (default **no**).
- Claude does not invent agenda items (no "add anchor" op). Nothing from the Må-runda reaches the notes; at most "Må-runda genomförd" may be written by the server.
- Previous meeting for Från förra veckan = latest `done` meeting of the same förening **and** the same `is_test`.
- Eval budget ≤ **$5** total for this plan (separate ledger `.notes-replay/spend-formats.json`); check the Anthropic org spend before the first paid run (org limit $70/month, ~$8 left until Dec 1).
- Picker: the browser only ever receives the signed-in user's **short-lived access token** (never the refresh token), from a `no-store` endpoint; the API key is restricted to the Picker API and our origins.

## Review Focus

1. **A human edits the agenda Doc while we write** (types a sub-bullet under the item we are writing to, deletes an agenda item, adds a new top-level item, edits an item label) → revision guard + retry; ours always go after their last paragraph of the item, never interleaved; a deleted item's anchor is gone and its notes are not re-added elsewhere by the server; a new item gets an anchor on the next tick. (A6, A12)
2. **The agenda Doc is not shaped like the fixture** ("Dagordning" instead of "Agenda:", headings instead of a list, numbers typed as text, no table, no tasks or notes heading, an empty Doc) → tolerant scan; missing section headings appended at the end as our own text; zero agenda items → start refuses agenda mode with a Swedish message and offers the fallback Doc. (A5, A7, A10)
3. **The starter cannot use the picked Doc** (no edit access, not a Google Doc, trashed, already used by another meeting, token cannot see the meeting folder) → a clear Swedish error and the fallback offer, nothing written. (A10, A11)
4. **The Må-runda never ends cleanly** (no clear transition, the detector fails, Må-runda not in the agenda, Må-runda is not item 2) → the exclusion window is capped at 20 minutes and closes after 3 failed detections; no Må-runda item → no exclusion; blocks already sent are never rewritten. (A8, A12)
5. **Från förra veckan with odd history** (previous meeting was a v1 meeting with `section='action'` rows and no `kind`; no previous meeting; all tasks done; tasks a human deleted; a Testmöte before a real meeting) → legacy rows count as tasks, deleted/done ones are skipped, nothing is written when nothing is open, test and real meetings never mix. (A9)

## File map

| File | Responsibility |
|---|---|
| `scripts/check-agenda-render.ts` | A1: real-Doc measurements, writes the fictional agenda Doc fixture |
| `fixtures/agenda/veckomote.doc.json` | `documents.get` dump of the fictional Veckomöte agenda Doc (scanner/render fixture) |
| `supabase/migrations/0023_meeting_formats.sql` | tables/columns of the spec's data model + what this plan adds |
| `supabase/migrations/0024_save_note_rows_v2.sql` | `save_note_rows` writing the new `note_items` columns |
| `lib/formats/schema.ts` | `FormatProfile` type + zod schema |
| `lib/formats/standard.ts` | the three standard profiles |
| `lib/formats/store.ts` | read/write `format_profiles`, org default |
| `lib/formats/skeleton.ts` | profile → Doc skeleton blocks (fallback Doc, Testmöte Doc, Phase B preview) |
| `lib/people/roles.ts` | role validation and owner labels |
| `lib/docs/tab.ts` | parse a Doc tab incl. bullets, styles and tables (extracted from `lib/docs/notes.ts`) |
| `lib/agenda/scan.ts` | find title, info table, agenda items, tasks/notes headings |
| `lib/agenda/roles.ts` | match fixed items (Må-runda, Från förra veckan, …) to agenda anchors |
| `lib/agenda/anchor.ts` | the start-time batch: anchor ranges, missing headings, LIVE line, cell fills, carried tasks |
| `lib/agenda/candidates.ts` | list and rank candidate agenda Docs in the meeting folder |
| `lib/agenda/followup.ts` | previous meeting's open tasks → carried items; done propagation |
| `lib/docs/notes.ts` | render: anchors, nested bullets, task copies (extends v1) |
| `lib/docs/skeleton.ts` | skeleton blocks → Docs requests |
| `lib/notes/agenda-prompt.ts`, `lib/notes/schema.ts`, `lib/notes/engine.ts` | agenda-mode engine |
| `lib/notes/checkin.ts` | Må-runda window detection and transcript placeholders |
| `lib/meetings/start.ts`, `lib/meetings/tick.ts` | start modes; tick in format layout |
| `app/api/google/picker-token/route.ts`, `components/google/Picker.tsx` | Picker |
| `app/api/orgs/[id]/agenda-candidates/route.ts`, `app/api/orgs/[id]/meeting-folder/route.ts`, `app/api/orgs/[id]/format/route.ts` | start and settings APIs |
| `components/views/FormatCard.tsx`, `components/views/PersonRow.tsx`, `components/live/AgendaStep.tsx` | UI |
| `lib/testmeeting/*`, `fixtures/notes/veckomote-*.{jsonl,expected.json}` | agenda Testmöte + eval fixtures |
| `scripts/lib/notes-score.ts`, `scripts/lib/notes-run.ts`, `scripts/notes-eval.ts` | agenda eval |
| Phase B: `lib/formats/learn.ts`, `lib/formats/structure.ts`, `app/api/orgs/[id]/formats/*`, `components/views/FormatEditor.tsx` | learn a format |
| Phase C: `lib/formats/stadgar.ts`, `fixtures/notes/styrelse-*` | stadgar → requiredItems |

## Calls made in this plan (not in the spec; Simon can override)

- **Enkel = today's v1 Doc** when there is no agenda Doc (`meetings.layout = 'v1'`); in agenda mode Enkel uses the format machinery like the others. No org format chosen → Enkel.
- **No "now" item and no Claude attendee items in the format layout.** Närvarande comes from the name round (spec) and is written by the server into the info-table cell (or a "Närvarande: …" line under the LIVE line when there is no such cell). The LIVE line is the health signal.
- **The tasks-section copy is its own `note_items` row** with id `<id>-t` and `copy_of = <id>` (range `ss-<m>-<id>-t`, as the spec names it), so v1's per-row diff/lock machinery works unchanged; Claude only sees the primary.
- **Må-runda window by a small boundary call** (`detectCheckin`, name-round style) on the new, not yet sent lines of each tick while the window is open, because the spec requires both "excluded from Claude's notes input" and append-only cached blocks. The spec's rule "ends at the first segment placed under a later item" is what the detector is asked to find. Fail-safes: 20 min cap, closes after 3 failed calls.
- Format profiles are immutable versions: choosing a standard format inserts a row (copy of the constant); `meetings.format_profile_id` pins the version used.
- Carried tasks have ids `c<k>`; done propagates to the directly preceding source row only (that is all the next prefill reads).

---

# Phase A — Veckomöte in the agenda Doc

### Task A1: Measure the Docs API on a real agenda-shaped Doc (gating)

**Files:** Create `scripts/check-agenda-render.ts`, `fixtures/agenda/veckomote.doc.json`; Modify `package.json` (script `check-agenda-render`), `docs/learnings.md`.

**Interfaces:** Produces the fixture consumed by A5/A6/A7 tests, and a learnings entry that fixes A6's insert sequence (`NESTED_INSERT` choice) and A7's table/skeleton requests.

Stages (as `scripts/check-notes-render.ts`: `npm run check-agenda-render -- <userId|email> <stage>`, state in `.check-notes/agenda.json`, env via `scripts/lib/google-env.ts`, prints PASS/FAIL per measurement, no DB writes):

- `build`: creates a fictional Veckomöte agenda Doc with raw requests: title paragraph "Mötesprotokoll:", a 2×4 table (Datum / Tid / Närvarande / Sekreterare; only Sekreterare filled, fictional name), "Agenda:" (plain) — numbered list (`NUMBERED_DECIMAL_ALPHA_ROMAN`) of 6 items "Godkänn dagordning", "Må-runda", "Från förra veckan", "Kommande event", "Ekonomi", "Övrigt", where "Kommande event" has two nested sub-bullets prepared before the meeting; a `HEADING_3` "5. Banbokning" variant item in a second Doc copy; "Vad ska vi göra till nästa gång?" (`HEADING_2`) with one line "Ordförande: Boka lokal."; "Anteckningar:" (`HEADING_1`). Dumps `documents.get` (`includeTabsContent`, `SUGGESTIONS_INLINE`) to `fixtures/agenda/veckomote.doc.json` (fictional content only; `documentId`, `revisionId` and any user ids/emails scrubbed to placeholders — the repo is public).
- `auto`: measurements, each on a fresh copy:
  - **M1** `insertText "\n<line>"` before the newline of top-level item 5 (no sub-bullets): the new paragraph's `bullet.listId`, `nestingLevel`, and whether items after it renumber (read the list's glyphs via `lists[listId].listProperties.nestingLevels` + paragraph order).
  - **M2** the same plus each candidate for "one level deeper": (a) text `"\n\t<line>"` then `createParagraphBullets` on the new paragraph with the list's preset; (b) insert after the item's last nested sub-bullet (item 4), inheriting level 1; (c) `deleteParagraphBullets` + `updateParagraphStyle indentStart/indentFirstLine` (non-list paragraph, "– " prefix). For each: `listId` same as the human list?, `nestingLevel`, top-level numbering unchanged?, index shift caused by removed tabs.
  - **M3** insert after a `HEADING_3` item: inherited style; `NORMAL_TEXT` + `createParagraphBullets BULLET_DISC_CIRCLE_SQUARE` result.
  - **M4** paragraph text read back for a list item excludes the glyph/number (so `last_rendered_text` compares equal).
  - **M5** named range over a list item's text survives a label edit in the middle; deleting the item including its newline removes the range entirely.
  - **M6** table cells: start/end indices of each cell's paragraph; `insertText` at an empty cell's paragraph start + `createNamedRange` over it; read-back of that range (range text = cell paragraph text?) and `replaceNamedRangeContent` on it; `parseNotesTab` today skips `el.table` (confirm).
  - **M7** one batch with `createParagraphBullets` + `createNamedRange` + `writeControl.requiredRevisionId`: are range indices computed before or after the tab removal (requests apply in order)?
  - **M8** appending headings at the end of the tab (missing sections) and the LIVE line directly after an existing `HEADING_1`: styles of the new paragraphs.
- `human` (Simon, in the Docs editor, after `auto`'s last Doc): presses Enter at the end of one of our bullets and types; presses Tab on another of our bullets; types a new sub-bullet under the same item after ours; edits the Närvarande cell we filled. Then `inspect` prints paragraphs, `bullet`, ranges and `itemSpan` per range.

- [ ] **Step 1:** Implement the script (no tests; throwaway-grade like `check-notes-render.ts`).
- [ ] **Step 2:** Run `npm run check-agenda-render -- simon.harrysson@gmail.com build` then `auto`. Expected: every measurement prints a result (PASS/FAIL is about the script running, the values are the finding).
- [ ] **Step 3:** Simon runs the `human` stage; run `inspect`.
- [ ] **Step 4:** Write `docs/learnings.md` "2026-11-2x · Formats A1 · The agenda Doc model": each M-result, the chosen nested-insert sequence (**decision rule:** pick the first of (b) when the item has nested sub-bullets, then (a), then (c), that keeps the human list's `listId` and top-level numbering unchanged; if (a) and (b) both fail, (c) is used for all items), what Enter/Tab on our bullet does to `itemSpan` (if Tab changes only `nestingLevel`, the item stays unlocked: record it), and cell-index rules. Update A6/A7 of this plan if a finding contradicts them.
- [ ] **Step 5:** Commit `chore: agenda Doc measurements and fixture`.

### Task A2: Schema — formats, roles, agenda meetings, note item kinds

**Files:** Create `supabase/migrations/0023_meeting_formats.sql`, `supabase/migrations/0024_save_note_rows_v2.sql`, `tests/db/formats.test.ts`; Modify `lib/db/types.ts`, `lib/meetings/tick.ts` (`saveRows` passes new fields).

**Interfaces (produces):**
- SQL (0023, additive):
  - `format_profiles (id uuid pk default gen_random_uuid(), org_id uuid not null references orgs on delete cascade, kind text not null check (kind in ('veckomote','styrelseprotokoll','enkel','learned')), profile jsonb not null, approved_by uuid references auth.users on delete set null, approved_at timestamptz, created_at timestamptz not null default now(), is_default boolean not null default false)`; unique partial index `(org_id) where is_default`. Grants: `select, insert, update, delete` to `service_role`, `select` to `authenticated`; `execute` on both functions to `authenticated`. RLS: select for `is_org_member(org_id)`; no direct insert/update grants to `authenticated` — writes go through `set_default_format(p_org_id uuid, p_kind text, p_profile jsonb) returns uuid` (security definer, checks `is_org_admin`, inserts a version row with `approved_by = auth.uid()`, `approved_at = now()`, moves `is_default`) and `set_default_format_id(p_org_id uuid, p_profile_id uuid)`.
  - `orgs.meeting_folder_id text null` (+ `grant update (meeting_folder_id)` to authenticated; the existing `orgs_update` policy (admins) applies).
  - `people.role text null check (role is null or length(btrim(role)) between 1 and 40)`.
  - `meetings.agenda_doc boolean not null default false`, `meetings.format_profile_id uuid null references format_profiles on delete set null`, `meetings.layout text not null default 'v1' check (layout in ('v1','format'))`, `meetings.is_test boolean not null default false`, `meetings.agenda_roles jsonb not null default '{}'` (`{anchorKey: ItemRole}`), `meetings.checkin_window jsonb null` (`CheckinWindow`).
  - `note_items.kind text null check (kind in ('decision','task','note','attendee','now'))`, `anchor text null`, `done boolean not null default false`, `owner_person_id uuid null references people on delete set null`, `carried_from_meeting uuid null`, `carried_from_id text null`, `copy_of text null`; widen `note_items.section` check to `('decision','action','now','attendees','note')`.
  - widen `meeting_events_kind_check` with `'agenda_anchored','format_learned','followup_prefilled','checkin'`.
- SQL (0024): `save_note_rows` replaced (same name and params) so it also writes `kind, anchor, done, owner_person_id, carried_from_meeting, carried_from_id, copy_of`, using `coalesce(r.done, false)` so callers sending the old row shape keep working.
- TS (`lib/db/types.ts`): `NoteSection` adds `"note"`; `NoteKind = "decision"|"task"|"note"|"attendee"|"now"`; `ItemRole = "procedural"|"checkin"|"followup"|"other"|"topic"`; `CheckinWindow = { startMs: number|null; endMs: number|null; closed: boolean; failures: number }`; `NoteItemRow` adds `kind?: NoteKind|null; anchor?: string|null; done?: boolean; owner_person_id?: string|null; carried_from_meeting?: string|null; carried_from_id?: string|null; copy_of?: string|null`; `PersonRow.role?: string|null`; `OrgRow.meeting_folder_id?: string|null`; `MeetingRow` adds `agenda_doc?, format_profile_id?, layout?: "v1"|"format", is_test?, agenda_roles?: Record<string, ItemRole>, checkin_window?: CheckinWindow|null`; `MeetingEventKind` adds the four kinds. `kindOfSection(section: NoteSection): NoteKind` (`action→task`, `attendees→attendee`, else same) and `sectionOfKind(kind: NoteKind): NoteSection` exported from `lib/db/types.ts`.

- [ ] **Step 1: Failing DB tests** in `tests/db/formats.test.ts` (pattern of `tests/db/rls.test.ts`): a member can select the org's `format_profiles`, a non-member gets 0 rows; a member calling `set_default_format` gets an error, an admin gets a uuid and exactly one row has `is_default`; a second call leaves one default (the new one); `save_note_rows` with old-shape rows (no new keys) stores `done=false`, `kind=null`; with new keys stores them; `note_items.section='note'` accepted; `people.role` of 41 chars rejected; `meetings.layout` defaults to `'v1'`.
- [ ] **Step 2:** `npx supabase db reset && npx vitest run tests/db/formats.test.ts` → FAIL.
- [ ] **Step 3:** Write both migrations and the types; `saveRows` in `tick.ts` sends the new fields (unchanged values for v1 rows).
- [ ] **Step 4:** Same command → PASS; `npx vitest run && npx tsc --noEmit` → PASS (v1 tests unchanged).
- [ ] **Step 5:** Commit `feat: schema for meeting formats and agenda meetings`.

### Task A3: Format profiles — data, standard formats, org default

**Files:** Create `lib/formats/schema.ts`, `lib/formats/standard.ts`, `lib/formats/store.ts`, `lib/formats/schema.test.ts`, `app/api/orgs/[id]/format/route.ts`, `components/views/FormatCard.tsx`, `tests/api/format.test.ts`; Modify `components/views/OrgDetailView.tsx`, `app/(app)/orgs/[id]/page.tsx`, `app/design/page.tsx` (preview states).

**Interfaces (produces):**
- `lib/formats/schema.ts`: `FormatKind`, `FixedItem = { key: string; label: string; role: ItemRole; position?: "last" }`, `FormatProfile` exactly the spec's JSON (`kind, title, infoTable: string[]|null, agendaHeading: string|null, fixedAgendaItems: FixedItem[], numbering: "numbered"|"paragraph"|"none", tasksSection: {label: string; groupBy: "role"|"person"}|null, notesSection: {label: string}|null, decisionPrefix: string, taskStyle: "role-first", tone: "full-sentences", signatures: string[]|null, requiredItems: string[]`), `FormatProfileSchema` (zod; every label 1–80 chars, ≤ 8 `infoTable` fields, ≤ 20 fixed items, ≤ 15 `requiredItems`, unique fixed-item keys, at most one item per role `checkin`/`followup`), `parseProfile(json: unknown): FormatProfile | null`.
- `lib/formats/standard.ts`: `VECKOMOTE`, `STYRELSEPROTOKOLL`, `ENKEL: FormatProfile`, `STANDARD: Record<"veckomote"|"styrelseprotokoll"|"enkel", FormatProfile>`, `FORMAT_NAMES: Record<FormatKind, string>` = `{veckomote: "Veckomöte", styrelseprotokoll: "Styrelseprotokoll", enkel: "Enkel", learned: "Eget"}`. Values:
  - `VECKOMOTE`: the spec's example verbatim (title "Mötesprotokoll", infoTable `["Datum","Tid","Närvarande","Sekreterare"]`, agendaHeading "Agenda", fixed items approve "Godkänn dagordning" procedural / checkin "Må-runda" / followup "Från förra veckan" / other "Övrigt" position last, numbering "numbered", tasksSection `{label: "Vad ska vi göra till nästa gång?", groupBy: "role"}`, notesSection `{label: "Anteckningar"}`, decisionPrefix "Beslut:", signatures null, requiredItems []).
  - `STYRELSEPROTOKOLL`: title "Styrelseprotokoll", infoTable `["Datum","Tid","Plats","Närvarande"]`, agendaHeading "Dagordning", fixed items: "Mötets öppnande" (procedural), "Val av mötesordförande" (procedural), "Val av mötessekreterare" (procedural), "Val av justerare" (procedural), "Godkännande av dagordning" (procedural), "Föregående protokoll" (followup), "Övriga frågor" (other, last), "Mötets avslutande" (procedural, last); numbering "paragraph"; tasksSection `{label: "Att göra", groupBy: "role"}`; notesSection null; signatures `["Mötesordförande","Mötessekreterare","Justerare"]`; requiredItems [].
  - `ENKEL`: title "Anteckningar", infoTable null, agendaHeading null, fixed items [], numbering "none", tasksSection `{label: "Att göra", groupBy: "person"}`, notesSection `{label: "Anteckningar"}`, rest as Veckomöte.
- `lib/formats/store.ts` (server-only): `orgDefaultFormat(db: SupabaseClient, orgId: string): Promise<{ id: string|null; profile: FormatProfile }>` (no default row → `{id: null, profile: ENKEL}`); `formatById(id: string): Promise<FormatProfile|null>` (service role); `listOrgFormats(db, orgId): Promise<{id, kind, isDefault, createdAt}[]>`; `chooseStandardFormat(db, orgId, kind: "veckomote"|"styrelseprotokoll"|"enkel"): Promise<string>` (calls `set_default_format` with the constant).
- `POST /api/orgs/[id]/format` body `{ kind: "veckomote"|"styrelseprotokoll"|"enkel" } | { profileId: string }` → `{ id }`; 403 `"Bara administratörer kan byta mötesformat."` for members.
- `FormatCard` (server component props `{ orgId, current: {kind, name}, isAdmin, meetingFolder: {id: string|null}, formats }`): shows "Mötesformat: <name>", "Byt" (select of the three + earlier learned versions; admin only), "Mötesmapp: vald / inte vald" (button wired in A10), "Lär Simon Says ert format" (disabled placeholder until Phase B; hidden for members).

- [ ] **Step 1: Failing tests** `lib/formats/schema.test.ts`: each of the three constants passes `FormatProfileSchema`; a profile with two `checkin` items fails; a 81-char label fails; `parseProfile({})` → null. `tests/api/format.test.ts`: admin POST `{kind:"veckomote"}` → 200 and `orgDefaultFormat` returns `VECKOMOTE`; member → 403; org without rows → `ENKEL` with `id: null`.
- [ ] **Step 2:** `npx vitest run lib/formats tests/api/format.test.ts` → FAIL.
- [ ] **Step 3:** Implement; add `FormatCard` to `OrgDetailView` above the people panel; `/design` gets admin and member states.
- [ ] **Step 4:** Same command → PASS; `npx tsc --noEmit` → PASS.
- [ ] **Step 5:** Commit `feat: format profiles and org default format`.

### Task A4: Roles on people

**Files:** Create `lib/people/roles.ts`, `lib/people/roles.test.ts`; Modify `lib/db/orgs.ts` (`setPersonRole`), `app/(app)/orgs/actions.ts` (`setPersonRoleAction`), `components/views/PersonRow.tsx`, `components/views/OrgDetailView.tsx`, `lib/names/validate.ts` (shared char rule only if reused), `tests/db/rls.test.ts` (role update as member/admin).

**Interfaces (produces):**
- `validRole(raw: unknown): string | null` — NFC, single spaces, trimmed, 1–40 chars, `/^[\p{L}\p{M}\p{N}' .&\/-]+$/u`, at most 4 words; "" → null (clears).
- `ownerLabel(person: { name: string; role?: string|null } | null, ownerText: string, groupBy: "role"|"person"): string` — role if `groupBy === "role"` and the person has one, else the person's name, else `ownerText`.
- `resolveOwner(ownerText: string, people: { id: string; name: string; role?: string|null }[]): { id: string; name: string; role?: string|null } | null` — exact (case/NFC-insensitive) full name, then a unique first-name match, then a unique role match ("kassören" → role "Kassör": strip Swedish definite suffix -en/-n/-et before comparing).
- `setPersonRole(db, personId: string, role: string|null): Promise<boolean>` (RLS: members may update `people` today; keep that).

- [ ] **Step 1: Failing tests** `lib/people/roles.test.ts`: `validRole(" Kassör ")` → `"Kassör"`; `validRole("PR & Event")` → `"PR & Event"`; `validRole("a".repeat(41))` → null; `validRole("Kassör: x")` → null; `ownerLabel({name:"Anna Berg", role:"Kassör"}, "Anna", "role")` → `"Kassör"`; same with `"person"` → `"Anna Berg"`; `resolveOwner("kassören", [{id:"p1",name:"Anna Berg",role:"Kassör"}])?.id` → `"p1"`; two people named Anna → `resolveOwner("Anna", …)` → null.
- [ ] **Step 2:** `npx vitest run lib/people` → FAIL.
- [ ] **Step 3:** Implement; `PersonRow` gets a role field (inline edit like the name, placeholder "Roll (t.ex. Kassör)"), list shows "Anna Berg · Kassör".
- [ ] **Step 4:** `npx vitest run lib/people tests/db/rls.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat: roles on people`.

### Task A5: Read and scan an agenda Doc

**Files:** Create `lib/docs/tab.ts`, `lib/agenda/scan.ts`, `lib/agenda/scan.test.ts`, `lib/agenda/roles.ts`, `lib/agenda/roles.test.ts`; Modify `lib/docs/notes.ts` (re-export `parseNotesTab` from `tab.ts`; no behaviour change).

**Interfaces:**
- Consumes: `fixtures/agenda/veckomote.doc.json` (A1), `FormatProfile` (A3).
- Produces (`lib/docs/tab.ts`): `Paragraph` gains `style: string` (`namedStyleType`, default `"NORMAL_TEXT"`), `bullet: { listId: string; level: number } | null`, `bold: boolean` (every non-whitespace text run bold), `inTable: { table: number; row: number; col: number } | null`; `NotesTab` gains `tables: { start: number; end: number; rows: { cells: { start: number; end: number; text: string; paragraphStart: number }[] }[] }[]`. `paragraphs` now also holds table-cell paragraphs in document order (marked `inTable`), so `itemSpan` finds our ranges inside cells (`info-narvarande`, `info-tid`) and they are not taken for human-deleted; v1 notes tabs have no tables, so v1 callers are unchanged. The scanner and every block/insert-point rule skip `inTable` paragraphs.
- Produces (`lib/agenda/scan.ts`):
  ```ts
  interface AgendaItem { key: string /* ag-<n>, 1-based in Doc order */; label: string; kind: "list" | "heading"; paraStart: number; paraEnd: number; level: number; blockEnd: number /* end of the last non-empty paragraph belonging to the item */; humanText: string /* the block's paragraphs after the item line */ }
  interface InfoCell { field: string; labelCell: {start,end}; valueCell: { paragraphStart: number; empty: boolean; text: string } }
  interface AgendaScan { title: { start: number; end: number; text: string } | null; info: InfoCell[]; agendaHeading: { start: number; end: number } | null; items: AgendaItem[]; tasksHeading: { start: number; end: number; text: string } | null; notesHeading: { start: number; end: number; text: string } | null }
  function scanAgenda(tab: NotesTab, profile: FormatProfile): AgendaScan
  function normLabel(s: string): string // lowercase, NFC, strip trailing ":"/"?", leading "§1."/"1."/"4." numbers, collapse spaces
  ```
  Rules (spec answer 2): heading-like = `HEADING_*` style, or a fully bold paragraph, or a plain paragraph whose `normLabel` equals a known label. Agenda heading: `normLabel` in `["agenda","dagordning", normLabel(profile.agendaHeading)]`. Tasks heading: `normLabel` equals `profile.tasksSection.label` or one of `["vad ska vi göra till nästa gång","att göra","till nästa gång","uppgifter"]`; notes heading: `profile.notesSection.label` or `["anteckningar","övriga anteckningar","noteringar"]`. Agenda items = between the agenda heading (or, with none, the first list after the info table) and the first of tasks/notes heading/end: list paragraphs at the region's minimum nesting level, and heading-like paragraphs; following paragraphs belong to the preceding item. Info table = the first table whose first-column `normLabel`s include ≥ 2 of `profile.infoTable` (or of Datum/Tid/Närvarande).
- Produces (`lib/agenda/roles.ts`): `fuzzyRoles(items: Pick<AgendaItem,"key"|"label">[], fixed: FixedItem[]): Record<string, ItemRole>` (normalized label equality, then a contains-match on synonyms `{checkin: ["må-runda","måsrunda","incheckning","check-in","hur mår"], followup: ["från förra","förra veckan","föregående protokoll","uppföljning"], procedural: ["godkänn","dagordning","öppnande","val av","justerare","avslutande"], other: ["övrigt","övriga frågor"]}`; unmatched → `"topic"`); `matchFixedItems(items, fixed, opts: { orgId: string; client?: NotesClient }): Promise<Record<string, ItemRole>>` — one Claude call (settings as `lib/names/extract.ts`, structured output `{roles: {key, role}[]}`, labels only, usage via `recordClaudeUsage`); skipped (fuzzy only) under `KILL_SWITCH` / dollar cap; any failure, refusal or invalid key → `fuzzyRoles`. At most one `checkin` and one `followup` (first wins).

- [ ] **Step 1: Failing tests** `lib/agenda/scan.test.ts` on the fixture: 6 items `ag-1…ag-6` with labels "Godkänn dagordning" … "Övrigt"; item `ag-4` `humanText` holds its two sub-bullets and `blockEnd` = end of the second; `info` has 4 fields, Datum/Tid/Närvarande `empty: true`, Sekreterare `empty: false`; tasks heading text "Vad ska vi göra till nästa gång?"; notes heading "Anteckningar:". Variants built by editing the fixture JSON in the test: "Dagordning" as `HEADING_1` → same items; items as `HEADING_3` "### 4. Kommande event" style → `kind: "heading"`; no tasks heading → `tasksHeading: null`; a trailing empty paragraph after item 4's sub-bullets does not move `blockEnd`; an empty Doc → `items: []`; numbers typed as text ("1. Godkänn dagordning", no list) under the agenda heading → found via plain-paragraph rule only when the paragraph matches `/^\d+\.\s/`. `lib/agenda/roles.test.ts`: `fuzzyRoles` maps the fixture labels to procedural/checkin/followup/topic/topic/other; "Måsrunda" → checkin; a mocked client returning an unknown key → falls back to fuzzy; refusal → fuzzy; kill switch → no client call.
- [ ] **Step 2:** `npx vitest run lib/agenda lib/docs` → FAIL (v1 `lib/docs/notes.test.ts` still PASS).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat: scan agenda Docs`.

### Task A6: Render notes under agenda anchors

**Files:** Create `lib/docs/format-render.ts`, `lib/docs/format-render.test.ts`; Modify `lib/docs/notes.ts` (export `ownedSpan`, `isEmptyItem`, the delete-run builder as `deleteRuns(tab, rows, removed)`, and give `renderItems` an optional 7th parameter `format?: { profile: FormatProfile; ownerLabel(owner: string): string; newAnchors?: { key: string; start: number; end: number }[] }`, used to call `planFormatRender` when `meeting.layout === "format"`; `toNotesItem` also maps `anchor`, `done`, `copy_of → copyOf`, `carried = carried_from_id != null`; `renderedRows` keeps/writes `kind`, `anchor`, `done`, `copy_of`, `owner_person_id`, `carried_from_*`), `lib/notes/schema.ts` (`NotesItem` fields below).

**Interfaces:**
- Consumes: `NotesTab` with `bullet`/`style`/`tables` (A5), `FormatProfile` (A3), `ownerLabel` (A4), A1's learnings entry.
- Produces:
  - `NotesItem` (in `lib/notes/schema.ts`) gains `anchor?: string; done?: boolean; copyOf?: string; carried?: boolean`. `NotesSection` gains `"note"`.
  - Anchor keys (stored in `meetings.section_ranges`, value = named range name): `ag-<n>` → `ss-<m>-ag-<n>`; `tasks` → `ss-<m>-sec-tasks`; `notes` → `ss-<m>-sec-notes`; `live` → `ss-<m>-live` (also `meetings.header_range`); `info.<slug>` (`info.datum`, `info.tid`, `info.narvarande`) → the cell's position is found by scan, the value range is the row's `range_name` `ss-<m>-info-<slug>`.
  - `formatLine(item: NotesItem, ctx: LineCtx): string` with `LineCtx = { profile: FormatProfile; ownerLabel(owner: string): string }`: decision → `"<decisionPrefix> <sentence>"` ("Beslut: Vi köper nya flaggor för 2 000 kr."); task → `"<label>: <text without final period>[ (<due>)].[ ✓ klart]"` ("Kassör: Mejla klubben om avgiften (fre)."; no owner → no `"<label>: "`); note → `<sentence>`; attendee (row `info-narvarande`) → the text as is. `sentence(s)` = cleaned text with a final "." added unless it ends in `.`, `!`, `?`. Never contains a newline.
  - `expandCopies(items: NotesItem[], rows: NoteItemRow[], profile: FormatProfile): NotesItem[]` — for each unlocked task primary (not `carried`) when `profile.tasksSection` exists: copy `{ ...item, id: "<id>-t", anchor: "tasks", copyOf: id }`; when the primary is locked or deleted, an existing copy row is kept exactly as it was and no new copy is made.
  - `planFormatRender(meeting: MeetingRow, tab: NotesTab, rows: NoteItemRow[], desired: NotesItem[], opts: { profile: FormatProfile; ownerLabel(owner: string): string; headerText?: string; newAnchors?: { key: string; start: number; end: number }[] }): RenderPlan` (same `RenderPlan` as v1). Rules:
    - changes / removals / locks exactly as v1 (`ownedSpan`, delete runs, `replaceNamedRangeContent`), with `formatLine` instead of `formatItem`;
    - new items for `ag-*`: insertion point = end of the item's block (the last non-empty paragraph after the anchor paragraph and before the next `ag-*` anchor paragraph, the `tasks`/`notes` anchor, or the end of the tab — human sub-bullets and our own bullets alike), so ours always come after everything already there and are never interleaved; inserted under the item by the A1-measured rule (`NESTED_INSERT`): (b) `"inherit-after-subitem"` when the item has nested list children: `insertText "\n<line>"` after the item's last nested sub-bullet (inherits level 1 and the same `listId`; no tabs, no bullet request; never use tab + `createParagraphBullets` on a list paragraph: the tab stays as text); else (c) `"indent-no-list"`: insert `"\n<line>"` after the item, `deleteParagraphBullets`, `updateParagraphStyle indentStart 54pt / indentFirstLine 36pt`, then insert the `"– "` prefix at the paragraph start (last, so no index shift). Per Ruling R-A1 our named range covers the whole paragraph INCLUDING the `"– "` prefix and `last_rendered_text` stores it with the prefix (like v1's glyphs), so `ownedSpan`'s `rangeText === paraText` holds. "Ours go after the item's last paragraph" is found by list position and level (the last paragraph of the item's block), never by our last range: a human may have typed after ours. A human re-indent (Tab) changes only `nestingLevel`, not text, so never re-apply levels to existing items; heading items get `NORMAL_TEXT` + a new `BULLET_DISC_CIRCLE_SQUARE` list;
    - new items for `tasks`: plain `NORMAL_TEXT` paragraphs; a copy goes right after the last line (ours or human) whose text starts with the same `"<label>: "`, else at the end of the tasks block;
    - new items for `notes`: at the end of the notes block, `NORMAL_TEXT`;
    - row `info-narvarande` (section `attendees`, anchor `info.narvarande`): without a range, inserted at the Närvarande value cell's `paragraphStart` only when that cell is empty in `tab`, else not rendered; with no Närvarande cell in the scan it is inserted as `"Närvarande: <names>"` directly after the LIVE line;
    - items whose anchor range is gone (`itemSpan` null) or unknown are not inserted (stay in rows without a range; Claude is told the anchor is gone in A8);
    - `newAnchors` → one `createNamedRange` each (`ss-<m>-<key>` over `[start, end)`);
    - the header (LIVE line) exactly as v1's header rule.
- [ ] **Step 1: Failing tests** `lib/docs/format-render.test.ts`, on `fixtures/agenda/veckomote.doc.json` with anchor ranges added in the test (`ss-m1-ag-1…6`, `ss-m1-sec-tasks`, `ss-m1-sec-notes`, `ss-m1-live`) and `VECKOMOTE`:
  - `formatLine({section:"action", text:"Mejla klubben om avgiften.", owner:"Anna Berg", due:"fre"}, ctx /* Anna = Kassör */)` → `"Kassör: Mejla klubben om avgiften (fre)."`; with `done: true` → `"… (fre). ✓ klart"`; decision `"vi köper flaggor"` → `"Beslut: vi köper flaggor."`.
  - a (c)-style line (item without sub-bullets) is rendered with the `"– "` prefix, its named range covers the whole paragraph including the prefix, and `ownedSpan` returns non-null (`rangeText === paraText`) with `last_rendered_text` equal to the prefixed text; a Tab (level change only) on one of ours leaves its text and `ownedSpan` unchanged and nothing re-applies levels.
  - a note for `ag-4` is inserted at `blockEnd - 1` of ag-4 (after its second human sub-bullet), with the nesting level item+1; a second note next render (our first now in the Doc) goes after ours; with a human paragraph typed after ours, the third goes after the human's.
  - a task for `ag-5` yields two inserts: under ag-5 and its `-t` copy right after "Ordförande: Boka lokal." only if same label, else at the end of the tasks block; a second Kassör task's copy lands right after the first Kassör copy.
  - copy paragraph edited by a human → copy locked, primary still updated next render; primary locked → copy row unchanged, no request touches it.
  - anchor `ag-6` range removed → its new items produce no request; existing items under it keep their rows.
  - empty Närvarande cell + row text "Anna Berg, Erik Lund" → `insertText` at the cell's `paragraphStart` and `createNamedRange ss-m1-info-narvarande`; cell holding human text → no request; once rendered (range in the fixture), `readState` reads the row back as its text (not deleted), a third name gives one `replaceNamedRangeContent`, and a human edit in the cell locks the row.
  - `renderItems` for a `layout: "format"` meeting called **without** `format` writes nothing (returns ok with no requests), so a format meeting started before A12 is deployed never gets v1 inserts at the end of a human Doc.
  - `newAnchors: [{key:"ag-7", start, end}]` → `createNamedRange` `ss-m1-ag-7`.
  - requests sorted by descending index; every request carries `tabId`; a v1 meeting (`layout` undefined) through `renderItems` produces exactly the v1 requests (existing `lib/docs/notes.test.ts` unchanged and passing).
- [ ] **Step 2:** `npx vitest run lib/docs` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run lib/docs` → PASS.
- [ ] **Step 5 (Early check):** extend `scripts/check-agenda-render.ts` with stage `render`: anchors the `build` Doc by hand-made ranges, renders 6 items (notes under ag-4 and ag-5, a decision, two Kassör tasks, one note in `notes`), then Simon types a sub-bullet under ag-5 and edits one copy; stage `tick` re-renders reworded items. Expected: human bullet and edited copy intact; the human list's numbering unchanged; our lines under the item by the A1 rule, and a human Tab on one of ours leaves it unlocked and unrewritten. Add the result to the A1 learnings entry.
- [ ] **Step 6:** Commit `feat: render notes under agenda items`.

### Task A7: Anchoring at start, skeleton Docs and the fallback Doc

**Files:** Create `lib/agenda/anchor.ts`, `lib/agenda/anchor.test.ts`, `lib/formats/skeleton.ts`, `lib/formats/skeleton.test.ts`, `lib/docs/skeleton.ts`; Modify `lib/docs/create.ts` (`createFormatDoc`), `lib/meetings/tick.ts` (`liveHeader`/`endedHeader` take a layout), `scripts/check-agenda-render.ts` (stage `fallback <kind>`).

**Interfaces:**
- Consumes: `scanAgenda`, `matchFixedItems` (A5), `planFormatRender`, `renderItems` (A6), `FormatProfile` (A3).
- Produces:
  - `liveHeader(now: Date, layout: "v1"|"format" = "v1")`: format → `"Simon Says antecknar live · uppdaterad HH:mm"`; `endedHeader(endedAt: Date, layout = "v1")`: format → `"Simon Says · avslutat HH:mm"`; `INITIAL_LIVE_LINE = "Simon Says antecknar live · uppdaterad –"`.
  - `class AgendaShapeError extends Error { code: "no_items" }`.
  - `planAnchoring(scan: AgendaScan, tab: NotesTab, opts: { meetingId: string; profile: FormatProfile; startedAt: Date }): { requests: DocsRequest[]; sectionRanges: Record<string,string>; headerRange: string; rows: NoteItemRow[]; appended: string[] }` (pure): `createNamedRange` over each item's text (paragraph without its newline); ranges over the tasks/notes headings, or — when missing and the profile has the section — `"\n<label>"` appended at the end of the tab as `HEADING_2` with a range (`appended` lists the labels); the LIVE line `INITIAL_LIVE_LINE` as a `NORMAL_TEXT` paragraph right after the notes heading (no notes section → appended at the end); empty Datum → `"YYYY-MM-DD"`, empty Tid → `"HH:mm"` (Stockholm) inserted at the cell's paragraph start, Tid with row `info-tid` (`section: "note"`, `anchor: "info.tid"`, range `ss-<m>-info-tid`, so the final pass can make it `"18:05–19:10"` while unchanged); Datum no range; Sekreterare and every non-empty cell untouched; descending order.
  - `anchorAgenda(auth: OAuth2Client, input: { meetingId: string; orgId: string; docId: string; tabId?: string; profile: FormatProfile; startedAt: Date; roles?: Record<string, ItemRole> }): Promise<{ tabId: string; revisionId: string; sectionRanges: Record<string,string>; headerRange: string; headerRendered: string; agendaRoles: Record<string, ItemRole>; rows: NoteItemRow[]; scan: AgendaScan; appended: string[] }>` — read (first tab when `tabId` absent) → scan → `AgendaShapeError("no_items")` when `scan.items` is empty → roles (`input.roles` ?? `matchFixedItems`) → one guarded batch; on revision conflict re-read, re-scan, retry (`CONFLICT_RETRIES`, `retryDelayMs`).
  - `skeletonBlocks(profile: FormatProfile, opts?: { items?: { label: string; sub?: string[] }[]; filled?: Record<string, string> }): SkeletonBlock[]` with `SkeletonBlock = { type: "title"|"heading"|"item"|"subitem"|"para"; text: string } | { type: "table"; rows: [string, string][] }`. Default items = fixed items without `position: "last"`, then `"Övriga punkter"` (role `topic`), then the `last` ones (spec answer 5); `opts.items` replaces that list (Testmöte); `opts.filled` pre-fills table values by field. Item text: numbered → label (list numbering), paragraph → `"§<n> <label>"`, none → label. Signatures (when set) as `para` lines `"<role>: ____________________"` at the end.
  - `skeletonRequests(tabId: string, blocks: SkeletonBlock[], numbering: FormatProfile["numbering"]): DocsRequest[]` (title `HEADING_1`, headings `HEADING_2`, numbered items one `NUMBERED_DECIMAL_ALPHA_ROMAN` list; sub-items are written with leading tabs and ONE `createParagraphBullets` call over the whole item range, which removes the tabs (N tabs = level N) and makes one new list, so every `createNamedRange` goes AFTER that request (A1 M7c) and indices after it shift by the removed tabs; `insertTable` leaves an undeletable empty paragraph before the table and one after it, so table indices are re-read, never assumed; cell anchors need a whole-cell text diff and a cell-aware span reader because `parseNotesTab`/`itemSpan` skip tables (A5), paragraph/none items `HEADING_3`, table per A1 M6).
  - `rolesFromSkeleton(profile): Record<string, ItemRole>` (anchor key `ag-<n>` → the fixed item's role in skeleton order; "Övriga punkter" → `topic`).
  - `createFormatDoc(auth, input: CreateMeetingDocInput & { profile: FormatProfile }): Promise<{ docId: string; tabId: string; transcriptTabId: string|null; shareFailed: string[] }>` — same folder, title (`meetingTitle`), sharing and transcript-tab rules as `createMeetingDoc`; body = `skeletonRequests(skeletonBlocks(profile))`. Enkel never calls this (v1 `createMeetingDoc`).
- [ ] **Step 1: Failing tests.** `lib/formats/skeleton.test.ts`: `skeletonBlocks(VECKOMOTE)` = title "Mötesprotokoll", table rows Datum/Tid/Närvarande/Sekreterare with empty values, heading "Agenda", items "Godkänn dagordning", "Må-runda", "Från förra veckan", "Övriga punkter", "Övrigt", headings "Vad ska vi göra till nästa gång?", "Anteckningar"; `STYRELSEPROTOKOLL` items start "§1 Mötets öppnande" and end with three signature lines; `rolesFromSkeleton(VECKOMOTE)` = `{ "ag-1":"procedural","ag-2":"checkin","ag-3":"followup","ag-4":"topic","ag-5":"other" }`. `lib/agenda/anchor.test.ts` on the fixture: 6 `createNamedRange` over exactly the items' text; Datum cell gets `"2026-11-25"` and Tid `"18:05"` for `startedAt = 2026-11-25T17:05:00Z`; no request whose index lies inside the Sekreterare cell or any human paragraph's text (only at paragraph ends or empty cells); fixture without the tasks heading → `"\nVad ska vi göra till nästa gång?"` at the end with `HEADING_2`, `appended` = that label; empty Doc → `AgendaShapeError` with code `no_items`; mocked `batchUpdate` failing once with a revision conflict → two reads, two writes, success.
- [ ] **Step 2:** `npx vitest run lib/agenda lib/formats` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5 (Early check):** `npm run check-agenda-render -- <user> fallback veckomote` and `fallback styrelseprotokoll`: creates the Doc with `createFormatDoc`, runs `anchorAgenda`, prints the scan. Expected: 5 (resp. 9) items found with the right roles, LIVE line under "Anteckningar", Datum/Tid filled. Note the result in learnings.
- [ ] **Step 6:** Commit `feat: anchor agenda Docs and build format Docs`.

### Task A8: Notes engine in agenda mode, and the Må-runda window

**Files:** Create `lib/notes/agenda-prompt.ts`, `lib/notes/checkin.ts`, `lib/notes/checkin.test.ts`; Modify `lib/notes/schema.ts`, `lib/notes/engine.ts`, `lib/notes/engine.test.ts`.

**Interfaces:**
- Produces (`schema.ts`): `RawAgendaOpSchema` = `{ op: "add"|"change"|"remove"; id: string; kind?: "decision"|"task"|"note"; anchor?: string; text?: string; owner?: string; due?: string; done?: boolean }`, `AGENDA_OPS_JSON_SCHEMA` (same shape as JSON schema; byte-stable), `toAgendaOp(raw): NotesOp | null` (kind → section via `sectionOfKind`, `anchor` copied onto the item); `NotesOp` change gains `done?: boolean`. `SYSTEM_PROMPT` and `OPS_JSON_SCHEMA` stay byte-identical.
- Produces (`agenda-prompt.ts`): `AGENDA_SYSTEM_PROMPT` (frozen; nothing per meeting) with these rules: the meeting follows an agenda; place every point under the agenda item being discussed (follow the transcript's flow and the item labels); kinds: decision (only agreed, one full sentence, without the "Beslut:" prefix — it is added when rendered), task (owner = the person's full name from the people list, due in the words used, the text a full tidy sentence without the owner), note (a short full sentence of what was said that matters; no small talk); loose remarks that fit no item → anchor `notes`; transcript lines `[Må-runda — utelämnad]` are deliberately removed: never write about the Må-runda and never use an anchor whose role is `checkin`; never add under the `followup` item — items `c*` there are last meeting's tasks: when someone reports one done, `change` it with `"done": true` (never reword or remove it); never duplicate what a person already wrote under the item (`human_text`) or anywhere in the Doc; never invent agenda items; anchors marked gone take no new items; change as little as possible (v1 rules 2–5, 7, 9 carried over verbatim in substance); FINAL pass may tidy as v1. `agendaTailText(t: TailInput & { agenda: AgendaContext }): string` adds `<format>` (name, decision prefix, groupBy), `<agenda>` (one line per anchor `key · label · role[ · gone]` followed by `<human_text>` of that item, truncated to 1 500 chars per item), `<people>` (`Name (Role)` lines) before v1's tail parts.
  - `AgendaContext = { formatName: string; decisionPrefix: string; groupBy: "role"|"person"; anchors: { key: string; label: string; role: ItemRole; humanText: string; gone?: boolean }[]; people: { name: string; role: string|null }[] }`.
- Produces (`engine.ts`): `UpdateNotesInput.agenda?: AgendaContext`; `buildRequest` uses `AGENDA_SYSTEM_PROMPT` + `AGENDA_OPS_JSON_SCHEMA` + `agendaTailText` when `agenda` is set; `applyOps(items, ops, opts & { agenda?: { anchors: Map<string, ItemRole | "notes"> } })` additionally drops: `add` without a known anchor (`ag-*` not gone, or `notes`); `add` whose anchor role is `checkin` or `followup`; `add` with kind `now`/`attendees`; on `change`: any `anchor` change, any `text`/`owner`/`due` change of a `carried` item, `done` on a non-task; `remove` of a `carried` item. `done` changes don't count as rewrites. With `agenda` set, `humanTabText` strips our lines by the rows' `last_rendered_text` (passed as `UpdateNotesInput.ownLines?: string[]`) instead of `formatItem`, so Claude never sees its own lines as human text.
- Produces (`checkin.ts`):
  - `CHECKIN_PLACEHOLDER = "[Må-runda — utelämnad]"`, `CHECKIN_MAX_MS = 20 * 60_000`, `CHECKIN_SEARCH_MS = 30 * 60_000`, `CHECKIN_MAX_FAILURES = 3`.
  - `nextWindow(prev: CheckinWindow, found: { startMs: number|null; endMs: number|null } | "failed", newSpan: { firstMs: number; lastMs: number }): CheckinWindow` (pure): start/end never earlier than `newSpan.firstMs` (so a block already sent is never changed); `startMs` set once; open window with `lastMs ≥ startMs + CHECKIN_MAX_MS` → `endMs = startMs + CHECKIN_MAX_MS`, closed; no start and `lastMs ≥ CHECKIN_SEARCH_MS` → closed without a window; `"failed"` increments `failures`, at `CHECKIN_MAX_FAILURES` → closed with `endMs = startMs === null ? null : newSpan.firstMs`.
  - `maskCheckin<T extends { text: string; speaker: string }>(segments: T[], w: CheckinWindow | null, atMs: (s: T) => number): T[]` (pure; `atMs` reads `start_ms` in the tick, `startMs` in the eval): segments with `atMs ≥ w.startMs` and (`w.endMs === null` or `< w.endMs`) → the first of each contiguous run becomes `{ ...seg, speaker: "–", text: CHECKIN_PLACEHOLDER }`, the rest dropped.
  - `detectCheckin(input: { lines: { atMs: number; speaker: string; text: string }[]; context: { atMs: number; speaker: string; text: string }[]; agenda: { key: string; label: string; role: ItemRole }[]; window: CheckinWindow }, opts: { orgId: string; client?: NotesClient }): Promise<{ found: { startMs: number|null; endMs: number|null } | "failed"; usage: NotesUsage | null }>` — one Claude call (settings as `lib/names/extract.ts`, structured output `{ start_at: string|null, end_at: string|null }` as `HH:MM:SS` of a line in `lines`), asked for the first line where the Må-runda begins and the first line that belongs to a **later** agenda item (spec: the window ends at the first segment placed under a later item); a time not among `lines` → `"failed"`; usage recorded by the caller.
- [ ] **Step 1: Failing tests.** `engine.test.ts`: agenda input → `system === AGENDA_SYSTEM_PROMPT`, schema is `AGENDA_OPS_JSON_SCHEMA`, tail contains `"ag-2 · Må-runda · checkin"` and `"Anna Berg (Kassör)"`; v1 input → `system === SYSTEM_PROMPT` and `output_config.format.schema === OPS_JSON_SCHEMA` (unchanged); add under `ag-2` (checkin) dropped; add under `ag-3` (followup) dropped; add with anchor `ag-9` dropped; add with anchor `notes` accepted; `change c1 {done:true}` accepted and `items` has `done: true`; `change c1 {text}` dropped; `remove c1` dropped; `change n1 {anchor:"ag-5"}` dropped; adding kind `now` dropped. `checkin.test.ts`: `nextWindow` clamps a start found at 10 000 ms to `firstMs` 30 000; window open from 60 000 with `lastMs` 1 300 000 → closed, `endMs` 1 260 000; three `"failed"` → closed; no start by 1 800 000 → closed, `startMs` null; `maskCheckin` over segments 0–9 with window [3, 6) → segments 0,1,2, placeholder, 6…9; `detectCheckin` with a mocked client answering a time not in `lines` → `"failed"`; refusal → `"failed"`.
- [ ] **Step 2:** `npx vitest run lib/notes` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run lib/notes` → PASS.
- [ ] **Step 5:** Commit `feat: agenda-mode notes engine and Må-runda window`.

### Task A9: Från förra veckan — carry open tasks, propagate done

**Files:** Create `lib/agenda/followup.ts`, `lib/agenda/followup.test.ts`, `tests/db/followup.test.ts`.

**Interfaces:**
- Consumes: `NoteItemRow` new fields (A2), `ownerLabel`/`resolveOwner` (A4).
- Produces:
  - `openTasks(rows: NoteItemRow[]): NoteItemRow[]` (pure) — tasks = `kind === "task"` or (`kind == null` and `section === "action"`, v1 rows); excluded: `copy_of` set, `done`, `deleted_by_human`, ids ending `-t`; a locked row keeps its human text (owner/due null); order: by owner label then `position`.
  - `carriedItems(prevMeetingId: string, open: NoteItemRow[], followupAnchor: string, people: { id: string; name: string; role?: string|null }[]): NoteItemRow[]` (pure) — ids `c1…cN`, `section: "action"`, `kind: "task"`, `anchor: followupAnchor`, text/owner/due copied, `owner_person_id` via `resolveOwner`, `carried_from_meeting = prevMeetingId`, `carried_from_id = row.id`, `range_name: null`, `last_rendered_text: null`, `position` = index.
  - `previousMeeting(orgId: string, isTest: boolean, before: Date): Promise<{ id: string } | null>` — latest `status = 'done'` meeting of the org with the same `is_test`, `started_at < before`.
  - `propagateDone(rows: NoteItemRow[]): Promise<number>` — for rows with `done` and `carried_from_*`, set `done = true` on the source row (service role; only where it is false); returns rows updated.
- [ ] **Step 1: Failing tests.** Unit: v1 row `{section:"action", kind:null}` is open; `{done:true}`, `{deleted_by_human:true}`, `{id:"n3-t", copy_of:"n3"}` are not; locked row → human text, owner null; `carriedItems` with Kassör/Ordförande owners groups Kassör lines together and numbers `c1…`. DB (`tests/db/followup.test.ts`): org with a done real meeting (older) and a done test meeting (newer) → `previousMeeting(org, false, now)` returns the real one and `(org, true, now)` the test one; a `live` meeting is never returned; `propagateDone([{…done:true, carried_from_meeting:M1, carried_from_id:"n4"}])` → M1's n4 `done = true`, returns 1; second call → 0.
- [ ] **Step 2:** `npx vitest run lib/agenda/followup.test.ts tests/db/followup.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat: carry open tasks to Från förra veckan`.

### Task A10: Start a meeting in agenda mode or in a format Doc (server)

**Files:** Modify `lib/meetings/start.ts`, `app/api/meetings/route.ts`, `lib/formats/store.ts` (`ensureStandardRow`), `tests/api/start-meeting.test.ts`; Create `lib/agenda/access.ts`.

**Interfaces:**
- Consumes: `anchorAgenda`, `createFormatDoc`, `rolesFromSkeleton` (A7), `previousMeeting`/`openTasks`/`carriedItems` (A9), `renderItems` (A6), `orgDefaultFormat`/`formatById` (A3).
- Produces:
  - `StartOptions = { agendaDocId?: string | null; formatProfileId?: string | null; formatKind?: "veckomote"|"styrelseprotokoll"|"enkel"; transcriptInDoc?: boolean; isTest?: boolean }`; `startMeeting(supabase, user, orgId, eventKind = "started", opts: StartOptions = {})` returns the existing `StartResult` plus `{ agenda: boolean; appended: string[]; carried: number }` on success.
  - `ensureStandardRow(orgId: string, kind): Promise<string>` (service role) — a non-default `format_profiles` row equal to the constant, reused when one exists (for the override dropdown and Testmöte; never changes the org default).
  - `checkAgendaDoc(auth, docId: string): Promise<{ ok: true; name: string } | { ok: false; error: "not_found"|"not_doc"|"no_edit"|"trashed" }>` (`drive.files.get` `fields: "id,name,mimeType,trashed,capabilities(canEdit)"`).
  - Profile resolution: `formatProfileId` (must belong to the org, else 400 `bad_format`) → `formatKind` (`ensureStandardRow`) → org default; `format_profile_id null` with `layout 'format'` means `ENKEL` (`profileFor(meeting): Promise<FormatProfile>` in `lib/formats/store.ts`).
  - Modes: **agenda** (`agendaDocId` set): `checkAgendaDoc` with the starter's token; Doc already the `doc_id` of a `live`/`ending` meeting → 409 (an earlier `done`/`abandoned` meeting on the same Doc, e.g. after a false start, is allowed: the new meeting anchors with its own `ss-<newId>-…` ranges and the old meeting's lines are human text to it); `anchorAgenda`; no sharing (their Doc); transcript tab added (`addDocumentTab "Transkript"`) only when `transcriptInDoc === true`; row `agenda_doc: true, layout: "format"`. **fallback** (no `agendaDocId`): Enkel → today's `createMeetingDoc`, `layout: "v1"`; other formats → `createFormatDoc` + `anchorAgenda(…, roles: rolesFromSkeleton(profile))`, `layout: "format"`, transcript tab per `org.share_transcript` as today. Both: `is_test = opts.isTest ?? eventKind === "test_started"`, `section_ranges` = anchor map, `header_range`/`header_rendered` = LIVE line, `agenda_roles`, `checkin_window = { startMs: null, endMs: null, closed: false, failures: 0 }` when a role `checkin` exists else null.
  - After the start guard (format layout only): the `info-tid` row (from `anchorAgenda`) and, if a `followup` anchor exists and `previousMeeting` has open tasks, the carried rows are first **inserted** into `note_items` with a plain service-role insert (`range_name: null`), then rendered with `renderItems` (guarded, retries), then the rendered fields (`range_name`, `last_rendered_text`, `position`) are written with a plain update. No tick lease exists yet, so `save_note_rows` is not used here; unrendered rows are rendered by the first tick like any new item; `logEvent("followup_prefilled", { count })`; `logEvent("agenda_anchored", { items, appended, roles })` (counts and role names only, no Doc text). A failure here logs and the meeting continues (the first tick re-renders unrendered rows).
  - Errors (Swedish, `failed(error, status, message)`): `agenda_not_found` 404 "Simon Says kommer inte åt dokumentet. Välj det i Google-väljaren igen."; `agenda_not_doc` 400 "Det du valde är inte ett Google-dokument."; `agenda_no_edit` 403 "Ditt Google-konto kan inte redigera dokumentet. Be den som äger det att dela det med dig, eller skapa ett nytt dokument."; `agenda_used` 409 "Dokumentet används redan av ett annat möte. Välj ett annat eller skapa ett nytt."; `agenda_no_items` 422 "Vi hittade ingen dagordning i dokumentet (en lista under ”Agenda” eller ”Dagordning”). Skapa ett nytt dokument i stället?". Nothing written to the DB in any of these.
  - `POST /api/meetings` body adds `agendaDocId?: string` (`/^[A-Za-z0-9_-]{10,200}$/`), `formatProfileId?: string` (uuid), `formatKind?`, `transcriptInDoc?: boolean`; response adds `agenda`, `appended`, `carried`.
- [ ] **Step 1: Failing tests** (`tests/api/start-meeting.test.ts`, Google mocked as the existing tests do): agenda happy path → row `layout 'format'`, `agenda_doc true`, `transcript_tab_id null`, `section_ranges` has `ag-1`…`ag-6`, `tasks`, `notes`, `live`; `transcriptInDoc: true` → a transcript tab id; `no_edit` → 403 with the message and no row; doc used by a live meeting → 409, by an abandoned one → allowed; zero items → 422, no row; fallback with org default Veckomöte → `createFormatDoc` called, `layout 'format'`; org without format → `createMeetingDoc`, `layout 'v1'`; `formatProfileId` of another org → 400; previous done meeting with 2 open tasks → 2 carried rows `c1`,`c2` saved with `anchor` of the followup item and event `followup_prefilled {count: 2}`; `isTest` → `is_test true`; an agenda without a Må-runda item → `checkin_window null`; a PDF id → 400 `agenda_not_doc`.
- [ ] **Step 2:** `npx vitest run tests/api/start-meeting.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; full `npx vitest run` → PASS.
- [ ] **Step 5:** Commit `feat: start meetings in agenda Docs and format Docs`.

### Task A11: Google Picker, meeting folder, agenda candidates and the start screen

**Files:** Create `app/api/google/picker-token/route.ts`, `components/google/Picker.tsx`, `app/api/orgs/[id]/meeting-folder/route.ts`, `app/api/orgs/[id]/agenda-candidates/route.ts`, `lib/agenda/candidates.ts`, `lib/agenda/candidates.test.ts`, `components/live/AgendaStep.tsx`, `scripts/check-picker-folder.ts`, `tests/api/picker-token.test.ts`, `tests/api/meeting-folder.test.ts`; Modify `lib/env.ts` (+ test), `.env.example`, `components/live/LiveMeetingController.tsx`, `components/live/ConsentStep.tsx`, `components/views/FormatCard.tsx`, `app/meetings/ny/[orgId]/page.tsx`, `app/design/page.tsx`, `docs/ui.md`.

**Interfaces:**
- Consumes: `POST /api/meetings` body (A10), `listOrgFormats` (A3).
- Produces:
  - env (server, optional): `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`. Absent → `pickerEnabled = false` and the UI shows "Google-väljaren är inte inställd än." with only the fallback.
  - `POST /api/google/picker-token` → `{ accessToken: string; expiresAt: number; developerKey: string; appId: string }`, `cache-control: no-store`; 401 `unauthenticated`; 401 `google_auth_lost` with the v1 message; 503 `picker_off` when env is absent. Never returns the refresh token.
  - `usePicker(): { ready: boolean; open(opts: { mode: "doc" | "folder" | "docs-multi" | "doc-or-pdf"; parentId?: string; title: string }): Promise<{ id: string; name: string; mimeType: string; parentId?: string }[] | null> }` (null = cancelled) — loads `https://apis.google.com/js/api.js` once, `gapi.load("picker")`; `DocsView` with `setMimeTypes` (doc: `application/vnd.google-apps.document`; doc-or-pdf adds `application/pdf`), `setParent(parentId)` when given, folder mode `DocsView(ViewId.FOLDERS).setSelectFolderEnabled(true)`, `MULTISELECT_ENABLED` for docs-multi; `setOAuthToken`, `setDeveloperKey`, `setAppId(appId)` (required for `drive.file` grants), `setLocale("sv")`.
  - `POST /api/orgs/[id]/meeting-folder { folderId }`: admin → `orgs.meeting_folder_id = folderId`; member → 204 only when `folderId === org.meeting_folder_id` (their pick just granted their own token), else 403.
  - `rankCandidates(files: { id: string; name: string; createdTime: string; modifiedTime: string }[], now: Date): typeof files` (pure): today's date in the title in any of `2026-11-25`, `20261125`, `25/11`, `25.11`, `25 nov`, `25 november` (case-insensitive, Stockholm date) > created in the current ISO week (Stockholm) > newer `modifiedTime`.
  - `listCandidates(auth, folderId: string, usedDocIds: Set<string>, now: Date): Promise<{ accessible: boolean; candidates: … }>` — `files.get(folderId)` 404/403 → `{accessible:false, candidates:[]}`; else `files.list` `q: "'<folderId>' in parents and mimeType='application/vnd.google-apps.document' and trashed=false and modifiedTime > '<now−7 d ISO>'"`, `fields: "files(id,name,createdTime,modifiedTime)"`, `pageSize: 50`, minus used ids, ranked.
  - `GET /api/orgs/[id]/agenda-candidates` → `{ folderId: string|null; accessible: boolean; candidates: …[]; suggestedId: string|null }` (starter's token; used ids = all `meetings.doc_id` of the org, service role); no-store.
  - `AgendaStep` props `{ orgId: string; formats: { id: string|null; kind: FormatKind; name: string; isDefault: boolean }[]; pickerEnabled: boolean; onChange(choice: AgendaChoice): void }`, `AgendaChoice = { agendaDocId: string|null; agendaName: string|null; formatProfileId: string|null; formatKind: string|null; transcriptInDoc: boolean; confirmed: boolean }`. States: suggestion ("Förslag: <name> · Använd · Välj annan"); none ("Ingen dagordning – skapa nytt dokument i formatet <X>" · "Välj dagordning"); folder not reachable for this starter ("Använd mötesmappen" → folder Picker → `meeting-folder` → reload candidates); picker off. "Lägg transkriptet i dokumentet?" checkbox (default off) only when an agenda Doc is chosen. Format override `<select>`. Start stays disabled until `confirmed` (Använd, a Picker pick, or "Skapa nytt dokument") — never auto-used.
- [ ] **Step 1: Failing tests.** `candidates.test.ts`: `"Möte 25/11"` (modified 3 days ago) ranks above `"Mall veckomöte"` (modified today) on 2026-11-25; `"2026-11-25 styrelse"` first; a doc created this week beats one created last week with the same modified time; `listCandidates` with mocked drive: folder 404 → `accessible:false`; used id removed; query string contains `trashed=false` and the 7-day bound. `tests/api/picker-token.test.ts`: no session → 401; ok → body has exactly `accessToken, expiresAt, developerKey, appId`, header `no-store`; env absent → 503. `tests/api/meeting-folder.test.ts`: admin sets the folder; member with the same id → 204; member with another id → 403. `lib/env.test.ts`: the two vars are optional.
- [ ] **Step 2:** `npx vitest run lib/agenda/candidates.test.ts tests/api/picker-token.test.ts tests/api/meeting-folder.test.ts lib/env.test.ts` → FAIL.
- [ ] **Step 3:** Implement; `ConsentStep` renders `AgendaStep` under the consent checkbox; `LiveMeetingController` sends `agendaDocId`, `formatProfileId`, `formatKind`, `transcriptInDoc` in the start POST and shows the server's Swedish error with a "Skapa nytt dokument i stället" button for `agenda_*` errors; `FormatCard` "Mötesmapp" opens the folder Picker (admin). `/design` gets the four `AgendaStep` states; `docs/ui.md` documents them.
- [ ] **Step 4:** Same command → PASS; `npx tsc --noEmit` → PASS.
- [ ] **Step 5 (Manual, Simon):** in the Google Cloud project of `GOOGLE_CLIENT_ID`: enable the Google Picker API; create an API key restricted to the Picker API and HTTP referrers `https://simonsays.harrysson.co/*`, the two `*.vercel.app` aliases and `http://localhost:3000/*`; set `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER` in Vercel (production + preview) and `~/simon-says-private/.env`.
- [ ] **Step 6 (Early check, gating for the folder branch):** first apply `0023`/`0024` to the deployed database if not done yet (procedure in A13 Step 5); then on a preview deploy Simon picks a Drive folder with 3 Docs he did not create via Simon Says, then `npm run check-picker-folder -- <user> <folderId>` lists `'<folderId>' in parents` with his stored token. Record in `docs/learnings.md` whether the children are listed under `drive.file`. **If not:** `agenda-candidates` keeps returning `accessible: false` for that case and `AgendaStep` opens the doc Picker with `parentId = folderId` instead of a suggestion (the code path already exists; remove the "Använd mötesmappen" button and say so in learnings). Also record whether a doc picked in that folder is readable and editable by `documents.get`/`batchUpdate` with the same token.
- [ ] **Step 7:** Commit `feat: pick the agenda Doc and the meeting folder`.

### Task A12: Ticks in the format layout

**Files:** Modify `lib/meetings/tick.ts`, `lib/agenda/scan.ts` (`newAgendaItems`), `tests/meetings/tick.test.ts`, `tests/meetings/name-round.test.ts`.

**Interfaces:**
- Consumes: everything from A5–A9.
- Produces:
  - `newAgendaItems(scan: AgendaScan, tab: NotesTab, sectionRanges: Record<string,string>): { key: string; start: number; end: number }[]` (pure) — scanned items whose paragraph no `ag-*` range touches; keys continue after the highest existing `ag-<n>`; their role is `topic`.
  - `buildTranscript(segments, sessions, speakers, window?: CheckinWindow | null)` — applies `maskCheckin` per session before building blocks; v1 calls (no window) are byte-identical.
  - `agendaContext(scan: AgendaScan, meeting: MeetingRow, profile: FormatProfile, people: PersonRow[]): AgendaContext` (pure) — `humanText` = the item's block text minus lines that are exactly one of our rendered rows; anchors in `section_ranges` whose range is gone → `gone: true`.
  - `attendeesText(speakers: SpeakerRead[]): string` (pure) — distinct named display names in first-heard order, `", "`-joined; `""` → the `info-narvarande` row is not rendered.
  - `runTick` in `layout === "format"`: profile via `profileFor`; after `assignTick` and the name round: (1) if `checkin_window` is open, `detectCheckin` on this tick's segments (context: the 20 previous lines) unless the kill switch / dollar cap is hit, `nextWindow`, store `checkin_window`, `recordClaudeUsage`, `logEvent("checkin", { state: "open"|"closed", startMs, endMs })` when it changes; (2) when the window has closed with a `startMs`, a server row `checkin-done` (`section "note"`, anchor = the checkin anchor, text "Må-runda genomförd.") is added once; (3) read → `scanAgenda` → `newAgendaItems` → `agendaContext` → `updateNotes({ …, agenda })` with the masked blocks; Claude's `items` = unlocked rows except `info-*`, `checkin-done` and `-t` copies; carried rows are included with `carried: true`; (4) desired = Claude items + `expandCopies` + `info-narvarande` (`attendeesText`) + `info-tid` (final pass: `"HH:mm–HH:mm"`); (5) guarded render (`planFormatRender` via `renderItems`, `newAnchors`, header `liveHeader(now, "format")` / `endedHeader(…, "format")`); on ok also persist new `section_ranges` and `owner_person_id` (`resolveOwner`); (6) after `saveRows`, `propagateDone(rows)`.
- [ ] **Step 1: Failing tests** (`tests/meetings/tick.test.ts`, fake deps as today): format meeting → `updateNotes` input has `agenda.anchors` with roles and `people` with roles; Doc read with a new top-level item → after the tick `section_ranges` has `ag-7` and the next tick's context lists it; checkin window open, detector returns start = second new line → the transcript block sent contains `"[Må-runda — utelämnad]"` and none of the Må-runda lines; the block sent in tick 1 is byte-identical in the request of tick 3 after the window closed in tick 2; detector failing 3 ticks → `checkin_window.closed` true; kill switch → neither detector nor notes call; `change c1 done:true` → the previous meeting's source row `done = true`; speaker_map with two named speakers → render desired has `info-narvarande` "Anna Berg, Erik Lund"; LIVE line text `"Simon Says antecknar live · uppdaterad 18:31"`; final pass header `"Simon Says · avslutat 19:10"` and `info-tid` `"18:05–19:10"`; a v1 meeting tick: every existing test unchanged. `name-round.test.ts`: segments inside an open checkin window still reach `extract`.
- [ ] **Step 2:** `npx vitest run tests/meetings` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run` → PASS; `npx tsc --noEmit` → PASS.
- [ ] **Step 5:** Commit `feat: ticks write into agenda Docs`.

### Task A13: Testmöte in agenda mode (fictional Veckomöte, two weeks)

**Files:** Create `fixtures/agenda/veckomote.agenda.json`, `fixtures/notes/veckomote-a.jsonl`, `fixtures/notes/veckomote-a.expected.json`, `fixtures/notes/veckomote-b.jsonl`, `fixtures/notes/veckomote-b.expected.json`, `lib/testmeeting/agenda.ts`, `lib/testmeeting/veckomote-a-lines.json`, `lib/testmeeting/veckomote-b-lines.json`; Modify `lib/testmeeting/fixture.ts`, `lib/testmeeting/feed.test.ts`, `app/api/meetings/test/route.ts`, `components/views/StartMeetingForm.tsx`, `tests/api/test-meeting.test.ts`.

**Interfaces:**
- Consumes: `skeletonBlocks`/`skeletonRequests` (A7), `startMeeting` options + `ensureStandardRow` (A10), `runFeed(meetingId, elSessionId, startedAt, deps, lines)` (existing).
- Produces:
  - Fixtures (fictional förening "Ekdala Padelklubb", five fictional people with roles Ordförande, Kassör, Sekreterare, PR-ansvarig, Eventansvarig; Swedish with one English speaker; `"source"` says fictional). `veckomote.agenda.json` = `{ sekreterare: string; items: { label: string; sub?: string[] }[] }` with items Godkänn dagordning, Må-runda, Från förra veckan, Kommande event (2 prepared sub-bullets), Ekonomi, Övrigt. **A** (last `startMs` ≤ 540 000): name round; approval; Må-runda (everyone shares how they feel, incl. personal plans like "jag ska boka tandläkaren" — traps that must not become tasks); Från förra veckan "inget sedan sist"; Kommande event (1 decision, 2 tasks with due); Ekonomi (1 decision, 1 task); Övrigt (1 task); one loose remark for Anteckningar. **B** (same length bound): Må-runda; Från förra veckan reporting two of A's four tasks done and one not done (by role: "Kassören: hyran är betald"); new items under Ekonomi and Övrigt. Expected files use the A14 fields (`agenda`, `anchor`, `ownerLabel`, `carried`, `checkin`).
  - `createTestAgendaDoc(auth: OAuth2Client, opts: { orgName: string; folderId: string | null; startedAt: Date }): Promise<{ docId: string }>` — title `"Mötesprotokoll <YYYY-MM-DD> (Testmöte)"`, in the org meeting folder when the token can write there, else the starter's "Simon Says – <org>" folder; body = `skeletonBlocks(VECKOMOTE, { items: agenda.items, filled: { Sekreterare: agenda.sekreterare } })`.
  - `testRun(orgId: string): Promise<"a" | "b">` — `"b"` when the org has a `done` meeting with `is_test` and `layout 'format'` and `agenda_doc`, else `"a"`.
  - `POST /api/meetings/test` body `{ orgId, mode?: "new" | "agenda" }` (default `"new"` = today's flow). Agenda: `createTestAgendaDoc` → `startMeeting(…, "test_started", { agendaDocId, formatProfileId: await ensureStandardRow(orgId, "veckomote"), transcriptInDoc: false, isTest: true })` → `runFeed(…, lines of run a/b)`. Total budget unchanged: replay ≤ 135 s at `SPEED` 4 + Doc creation/anchoring inside `END_DEADLINE_MS`.
  - `StartMeetingForm`: second admin button "Testmöte med dagordning".
- [ ] **Step 1: Failing tests.** `feed.test.ts`: the two bundled line files equal their `fixtures/notes/*.jsonl`; every fixture's last `startMs` ≤ 540 000; `tests/api/test-meeting.test.ts`: `mode: "agenda"` → `createTestAgendaDoc` then `startMeeting` with `isTest: true` and an `agendaDocId`; first run feeds A lines, after a done agenda Testmöte feeds B lines; `mode` absent → today's behaviour.
- [ ] **Step 2:** `npx vitest run lib/testmeeting tests/api/test-meeting.test.ts` → FAIL.
- [ ] **Step 3:** Write the fixtures (fictional only — no line, name or event from any real förening's minutes) and implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5 (Database):** migrations reach prod only from `main` (learnings, Task 2/Goal 2); before any preview/prod check, apply `0023` and `0024` to `simonsays-prod` (Management API SQL, as earlier migrations were; both are idempotent-safe to re-run via the GitHub integration — write them with `if not exists` / `create or replace`) and confirm whether the preview deploy uses the same database (it does unless a Supabase branch is configured); record it in learnings.
- [ ] **Step 5b (Early check on a preview deploy):** Simon runs "Testmöte med dagordning" twice in a test förening. Check in the Doc: our notes as nested bullets under the right items after the prepared sub-bullets; tasks under their item and under "Vad ska vi göra till nästa gång?" with roles; no Må-runda content (at most "Må-runda genomförd."); Närvarande cell filled, Sekreterare untouched; LIVE line → "Simon Says · avslutat HH:mm"; run 2 pre-fills Från förra veckan with run 1's open tasks before the first tick and marks two "✓ klart". Record timings and findings in `docs/learnings.md`.
- [ ] **Step 6:** Commit `feat: agenda-mode Testmöte`.

### Task A14: Eval — placement, roles, Från förra veckan, Må-runda (≤ $5)

**Files:** Modify `scripts/lib/notes-score.ts`, `scripts/lib/notes-score.test.ts`, `scripts/lib/notes-run.ts`, `scripts/notes-eval.ts`, `docs/learnings.md`.

**Interfaces:**
- Consumes: `detectCheckin`/`nextWindow`/`maskCheckin` (A8), `updateNotes` with `agenda` (A8), `ownerLabel`/`resolveOwner` (A4), fixtures (A13).
- Produces:
  - `Expected` gains `agenda?: { profile: "veckomote"; items: { key: string; label: string; role: ItemRole; sub?: string[] }[] }`, `people?: { name: string; role: string | null }[]`, `anchor?: string` on decisions and action items, `ownerLabel?: string` on action items, `carried?: { id: string; owner: string; text: string; done: boolean }[]`, `checkin?: { match: Match }`.
  - `Score` gains `placement: { ok: number; total: number }` (expected decisions/actions with `anchor` whose matched final item has that anchor), `roles: { ok; total }` (actions with `ownerLabel` equal to `ownerLabel(resolveOwner(item.owner, people), item.owner, "role")`), `followup: { ok; total }` (each carried item's final `done` equals expected), `checkinLeaks: string[]` (final or any live item matching `checkin.match`, or any item anchored on a checkin/followup-role anchor that is not carried).
  - `scorePasses` adds: `placement.ok / placement.total ≥ 0.9`, `roles.ok === roles.total`, `followup.ok === followup.total`, `checkinLeaks.length === 0`; existing bars unchanged.
  - `runReplay({ …, agenda?: true })`: `notesTabText` = the fixture agenda as plain lines (labels + `sub` lines) followed by our items formatted with `formatLine`, and `ownLines` = those formatted lines; carried items pre-filled as `c1…`; per tick `detectCheckin` on the tick's new lines while the window is open, `maskCheckin` before building that tick's block; `updateNotes` with `agendaContext` from `expected.agenda` (`humanText` = the item's `sub` lines). Detector usage counted in the run's cost.
  - `notes-eval --ledger <file>` (default `.notes-replay/spend.json`).
- [ ] **Step 1: Failing tests** `notes-score.test.ts`: a fixed item set where 9 of 10 anchored points sit under the expected item → `placement {ok:9,total:10}` and passes; 8/10 fails; an action owned by "Anna Berg" (Kassör) with `ownerLabel: "Kassör"` → roles ok; carried `c2` expected done but not → followup fails; an item "Jag ska boka tandläkaren" matching `checkin.match` → leak; `--check` reports an expected `anchor` missing from `agenda.items`.
- [ ] **Step 2:** `npx vitest run scripts/lib` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run scripts/lib` → PASS; `npm run notes-eval -- --check` → no problems ($0).
- [ ] **Step 5 (Paid run, gate):** check the Anthropic Console org spend first (stop and ask Simon if less than $6 is left this month). `npm run notes-eval -- --only veckomote-a,veckomote-b --repeat 2 --ledger .notes-replay/spend-formats.json --budget 5`. **Gate:** both fixtures PASS every bar incl. churn ≤ 15 %, recall 100 %, ≤ $1.50/h. On a miss: tune `AGENDA_SYSTEM_PROMPT` (never `SYSTEM_PROMPT`) and rerun, at most 3 rounds and within the ledger budget; if still missing, stop and report to Simon with the per-bar numbers.
- [ ] **Step 6:** Record numbers (placement, roles, followup, leaks, churn, $/h, spend so far) in `docs/learnings.md`; commit `test: agenda-mode notes eval`.

**Phase A is done when** A13's Testmöte check and A14's gate pass on prod; the first real Hook & Look meeting needs nothing from Phase B or C.

---

# Phase B — Learn a format

### Task B1: Propose a format from picked Docs (server)

**Files:** Create `lib/formats/structure.ts`, `lib/formats/structure.test.ts`, `lib/formats/learn.ts`, `lib/formats/learn-prompt.ts`, `lib/formats/learn.test.ts`, `app/api/orgs/[id]/formats/propose/route.ts`, `app/api/orgs/[id]/formats/route.ts`, `tests/api/formats.test.ts`.

**Interfaces:**
- Consumes: `parseNotesTab`/`scanAgenda` helpers (A5), `FormatProfileSchema` (A3), `set_default_format` (A2).
- Produces:
  - `docStructure(doc: docs_v1.Schema$Document): DocStructure` (pure), `DocStructure = { title: string | null; headings: { level: number; text: string }[]; tableLabels: string[]; topItems: string[]; nestedCounts: number[]; numbering: "numbered" | "paragraph" | "none"; linePrefixes: { prefix: string; count: number }[]; taskLines: { total: number; withDate: number; withOwner: number } }` — only headings, first-column table labels and top-level agenda labels (each cut to 80 chars), and the text before ":" when it is ≤ 3 words; **no body text, no sub-bullet text, no cell values**.
  - `proposeFormat(input: { orgId: string; docs: { isTemplate: boolean; structure: DocStructure }[] }, opts?: { client?: NotesClient }): Promise<{ ok: true; profile: FormatProfile; explanation: string; qualityNote: string; usage: NotesUsage } | { ok: false; error: "spend" | "refusal" | "malformed" | "error" }>` — one Claude call (structured output: the profile JSON schema + `explanation`, `quality_note`), `kind` forced `"learned"`, `tone`/`taskStyle`/`decisionPrefix` forced to the standard values (G4: never copy poor quality), validated with `FormatProfileSchema`; usage recorded; `"spend"` under kill switch / dollar cap. `LEARN_SYSTEM_PROMPT`: structure only, Swedish explanation ≤ 3 sentences, quality note about what the old minutes often lack (owner, due, decisions as sentences); template docs outweigh minutes.
  - `POST /api/orgs/[id]/formats/propose { docIds: string[] }` (admin; 1–5 ids) → reads each with the admin's token (`documents.get`), `isTemplate = /^(mall|template)/i.test(title)`, `folderId` = first doc's `parents[0]` (`drive.files.get fields parents`) → `{ profile, explanation, qualityNote, folderId }`. Stores nothing; logs only counts.
  - `POST /api/orgs/[id]/formats { profile: FormatProfile; folderId?: string }` (admin) → validate → `set_default_format(org, "learned", profile)` → sets `orgs.meeting_folder_id` when it is null and `folderId` is given → `{ id }`.
- [ ] **Step 1: Failing tests.** `structure.test.ts` on `fixtures/agenda/veckomote.doc.json`: `topItems` = the six labels, `tableLabels` = the four fields, `numbering "numbered"`; **privacy:** `JSON.stringify(docStructure(doc))` contains neither of ag-4's sub-bullet texts nor the Sekreterare cell value. `learn.test.ts`: mocked answer with a valid profile → `ok`, `kind "learned"`, `decisionPrefix "Beslut:"` even when Claude said otherwise; invalid profile → `malformed`; kill switch → `spend` without a call. `tests/api/formats.test.ts`: member → 403 on both routes; 6 ids → 400; approve → the org default is the learned row and `meeting_folder_id` set once (not overwritten later); the stored row's `profile` has only schema keys.
- [ ] **Step 2:** `npx vitest run lib/formats tests/api/formats.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat: propose a meeting format from old minutes`.

### Task B2: Learn-a-format UI — Picker, preview, edit, approve

**Files:** Create `components/views/FormatEditor.tsx`, `lib/formats/editor.ts`, `lib/formats/editor.test.ts`; Modify `components/views/FormatCard.tsx`, `app/design/page.tsx`, `docs/ui.md`.

**Interfaces:**
- Consumes: `usePicker` (A11), `skeletonBlocks` (A7), the two B1 routes.
- Produces: `EditorState` (title, infoTable as string[], fixed items `{label, role, last}[]`, numbering, tasks label + groupBy, notes label or off); `profileToEditor(p: FormatProfile): EditorState`, `editorToProfile(s: EditorState): { ok: true; profile: FormatProfile } | { ok: false; errors: string[] }` (Swedish errors, keys `ag-…` regenerated from labels, validated by `FormatProfileSchema`). `FormatEditor` shows the explanation, the quality note, a paper-style preview of `skeletonBlocks(profile)` and the fields; "Godkänn och använd" posts; "Avbryt" drops everything.
- [ ] **Step 1: Failing tests** `editor.test.ts`: round trip `editorToProfile(profileToEditor(VECKOMOTE))` equals `VECKOMOTE` except `kind`; two items with role checkin → error "Bara en punkt kan vara Må-runda."; empty title → error.
- [ ] **Step 2:** `npx vitest run lib/formats/editor.test.ts` → FAIL.
- [ ] **Step 3:** Implement; "Lär Simon Says ert format" in `FormatCard` opens the Picker (`docs-multi`, 1–5), then "Simon Says läser strukturen …", then `FormatEditor`.
- [ ] **Step 4:** Same command → PASS; `/design` states: proposing, editor with quality note, error.
- [ ] **Step 5 (Early check):** Simon runs it on Hook & Look's own old minutes in his browser and compares the preview with them; then checks the stored `format_profiles` row holds labels only. Learnings record what the proposal got right/wrong in structural terms only (no content).
- [ ] **Step 6:** Commit `feat: learn a meeting format`.

---

# Phase C — Styrelseprotokoll with stadgar

### Task C1: Required items from the stadgar

**Files:** Create `lib/formats/stadgar.ts`, `lib/formats/stadgar.test.ts`, `fixtures/stadgar/fiktiv-forening.txt`, `app/api/orgs/[id]/formats/stadgar/route.ts`; Modify `components/views/FormatCard.tsx`, `components/views/FormatEditor.tsx` (editable `requiredItems` list), `tests/api/formats.test.ts`.

**Interfaces:**
- Produces: `extractRequiredItems(input: { kind: "doc"; text: string } | { kind: "pdf"; base64: string }, opts: { orgId: string; client?: NotesClient }): Promise<{ ok: true; items: string[]; usage: NotesUsage } | { ok: false; error: "spend" | "refusal" | "malformed" | "error" }>` — Claude (a PDF goes as a base64 `document` block; Doc text capped at 100 000 chars), output ≤ 15 items, each ≤ 80 chars, phrased as agenda items ("Val av justerare", "Fråga om mötets behöriga utlysande"); stadgar text never stored or logged. `POST /api/orgs/[id]/formats/stadgar { fileId }` (admin, admin's token): Google Doc → plain text; PDF → `files.get alt=media`, > 10 MB → 413 "Filen är för stor (max 10 MB)."; other types → 400. Returns `{ requiredItems }`; the admin approves them inside a Styrelseprotokoll profile in `FormatEditor` (`set_default_format(org, "styrelseprotokoll", profile)`).
- [ ] **Step 1: Failing tests** (mocked client, fictional stadgar fixture): items returned and trimmed; 20 items → 15; PDF input sends a `document` block with `media_type "application/pdf"`; kill switch → `spend`; route: 11 MB PDF → 413; member → 403.
- [ ] **Step 2:** `npx vitest run lib/formats/stadgar.test.ts tests/api/formats.test.ts` → FAIL.
- [ ] **Step 3:** Implement (Picker mode `doc-or-pdf`).
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat: required agenda items from the stadgar`.

### Task C2: Styrelseprotokoll in the Doc — required items, § numbering, warnings, eval

**Files:** Modify `lib/formats/skeleton.ts`, `lib/agenda/scan.ts` (`missingRequired`), `lib/meetings/start.ts`, `components/live/AgendaStep.tsx`, `lib/notes/agenda-prompt.ts` (tail format note only); Create `fixtures/notes/styrelse-ekdala.jsonl`, `fixtures/notes/styrelse-ekdala.expected.json`; tests in `lib/formats/skeleton.test.ts`, `lib/agenda/scan.test.ts`, `tests/api/start-meeting.test.ts`.

**Interfaces:**
- Produces: `mergeRequiredItems(profile: FormatProfile): FixedItem[]` — required items whose `normLabel` fuzzy-matches no fixed label are inserted after the last non-`last` procedural item, role `procedural`; `skeletonBlocks` uses it. `missingRequired(scan: AgendaScan, profile: FormatProfile): string[]`. Start response gains `warnings: string[]`; `AgendaStep` shows "Dagordningen saknar: <items>. Simon Says lägger inte till punkter i ert dokument." (never writes them into a human agenda). The agenda tail's `<format>` line says "§-numbered board minutes: decisions as 'Styrelsen beslutade att …'" when `numbering === "paragraph"` (no system prompt change).
- [ ] **Step 1: Failing tests:** `mergeRequiredItems` with required "Val av justerare" (already fixed) and "Fråga om mötets behöriga utlysande" → only the second added, after "Val av justerare"; `skeletonBlocks` of that profile numbers "§1 …" through "§9 …" with signatures last; `missingRequired` on the Veckomöte fixture with required "Val av justerare" → `["Val av justerare"]`; start in agenda mode returns that warning and writes no agenda item.
- [ ] **Step 2:** `npx vitest run lib/formats lib/agenda tests/api/start-meeting.test.ts` → FAIL.
- [ ] **Step 3:** Implement; write the fictional § fixture (same rules as A13).
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5 (Paid, within the remaining ledger):** `npm run notes-eval -- --only styrelse-ekdala --ledger .notes-replay/spend-formats.json --budget 5` → PASS every bar. Record in learnings.
- [ ] **Step 6:** Commit `feat: Styrelseprotokoll with required items`.
