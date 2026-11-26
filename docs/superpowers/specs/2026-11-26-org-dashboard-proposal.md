# Org dashboard — proposal (todo #2, 2026-11-26)

Simon's idea: "now that we know everything about the org we should be able to give them a pretty good dashboard of goals and what's going on in the org."

This is a proposal for Simon to react to, not an approved design. Nothing is built.

## What Simon Says already knows per förening

From every meeting: decisions (with the agenda item they belong to), tasks (owner/role, due, done or open, carried how many weeks), who attended, which agenda items recur, meeting length and cadence. Todo #4's `meetingChainSummary` gives open/closed task counts per meeting.

## What a board member would want to see (proposal)

1. **Open tasks** — grouped by role/person, with how many meetings each has been carried ("3 veckor"), oldest first. The single most useful view: what is slipping.
2. **Recent decisions** — the last N decisions with date and agenda item, searchable ("när bestämde vi hyran?").
3. **Topics over time** — the agenda items that recur (e.g. "Ekonomi", "Kommande event") and what was decided under each, per month.
4. **Goals** — the open question. Three ways to get them:
   - (a) the admin writes 3–5 goals for the year; Simon Says links decisions/tasks to them (Claude tags each new item with the goal it serves);
   - (b) Simon Says proposes goals from what keeps coming up in meetings, the admin approves (like learning a format);
   - (c) read them from the stadgar / verksamhetsplan Doc the admin picks.
   My pick: (b) with (a) as the edit path — same "propose → approve" pattern the förening already knows.
5. **Attendance** — who comes, trend per person (sensitive: show only to admins? needs Simon's call).

## Questions only Simon can answer

1. Goals: (a), (b) or (c)?
2. Who sees the dashboard — all members or admins only? Attendance per person especially.
3. Where — a tab on the förening page, or a Google Doc/Sheet Simon Says keeps updated (fits "everything lives in Google")?

## Cost

Views 1–3 and 5 are plain database queries (no Claude). Goals (b) is one Claude call per month per förening.

## Simon's answers (2026-11-26)

1. Goals: **(b)** — Simon Says proposes goals from what keeps coming up in meetings; the admin approves/edits (edit path = (a)).
2. Who sees: **all members see everything**, including attendance per person.
3. Where: **a tab ("Översikt") on the förening page**.

## Builder decisions (2026-11-26, v1 of the dashboard)

One line each: the call, then why.

- **Agenda labels get stored**: new `meetings.agenda_labels jsonb` (`ag-<n>` → label), written at start and when the tick adds an item. Labels were only ever in the Doc, and views 2, 3 and 5 need them.
- **Only safe labels are stored**: the format-learning filter (`safeItemLabel`: ≤ 8 words, no digits, no person's name). A label that fails is not stored, so no name or amount leaves the Doc.
- **Labels are written best-effort through `merge_agenda_labels` (service role)**: a missing column/function (deploy order) only logs, so a start or tick never fails on the dashboard.
- **History is thin at first**: meetings from before 0028 have no labels. Their decisions show without an agenda item, and topics start counting from the first meeting after deploy.
- **What counts**: meetings of the org with `is_test = false` and status `done` or `abandoned` (ended). Live and ending meetings are left out until they are finished, so a running meeting never shuffles the numbers.
- **Open task = the tip of a carry chain**: the last copy (no later row is `carried_from` it) that is not done on the row or its `-t` copy and not deleted by a human. Same task/decision rules as `meetingChainSummary` (shared helpers).
- **"N veckor" = whole weeks since the meeting where the task was first written** (start of its carry chain), not a count of meetings. Boards that meet monthly would otherwise see "1 vecka" for a month-old task.
- **Grouped by person, else by the owner text, else "Utan ansvarig"**: owner_person_id → the person's name (and role), else the owner text as written (role-first tasks: "Kassören"). Groups ordered by their oldest task.
- **Decisions: newest first, the last 12 months, search in the browser** over decision and agenda item text. Search is a filter on what is already on the page: no query, no Claude.
- **Recurring topics = labels (normLabel) in ≥ 2 counted meetings**, roles topic only (procedural, Må-runda, Från förra veckan and Övrigt are on every agenda and say nothing). Decisions under each, grouped per month.
- **Attendance = who was heard and named**: distinct `speaker_map.person_id` per meeting (through merges, `resolveSpeaker`), over meetings where anyone was named. The copy says "hörd och namngiven", since a silent attendee isn't in the data.
- **Goals storage: `org_goals`** (title ≤ 80, why ≤ 240, position), approved rows only. A proposal is never stored: it goes to the browser, the admin edits and approves, as with a learned format.
- **Approve replaces the whole set** through `set_org_goals(org, jsonb)` (security definer, admins only, 0–5 goals). One atomic write; members read through RLS.
- **"Föreslå mål" = one `oneShot` call** (model, kill switch, day cap, usage on the org already in it). It needs ≥ 3 counted meetings, else no call and a message.
- **What Claude gets**: topic labels with counts, up to 60 decisions and 30 open tasks (text, month, agenda label). No owners, no attendance, no Doc text, no test meetings, nothing under a Må-runda item. People's names in the texts are replaced by "en person".
- **Tab = server links (`?flik=oversikt`)** with `aria-current`, not a client tab widget. Data loads only when the tab is open, and the URL can be shared.
- **The view lives in new files** (`components/views/OverviewView.tsx`, `lib/dashboard/*`). OrgDetailView only gets a tab bar and an `overview` slot, to stay out of the way of the format-card work.
- **PostgREST row cap**: note_items are read in pages of 1000 and meeting ids in chunks of 100, and only decision/task rows are selected. A year of meetings then never truncates silently.
