# Concrete tasks — design (Simon 2026-11-26, approved in conversation)

Simon: "each bullet got a who when done or whatever you decide on … if the meeting tries to stop, you have to like dismiss those" (meeting tool = föreningar); for companies "suggesting those when, who, what … but not forcing"; Privat = personal recorder (no forcing).

## Fields per task
- **Vem** (person or role; existing owner), **När** (deadline: date or "till nästa möte"; existing due), **Klart när** (measurable result, new field `done_when`).

## Föreningar (forcing, mode "kräv")
1. Notes engine asks Claude to fill all three when said; never invents — missing stays null.
2. Doc: missing fields written visibly: `Boka lokal – Kassör – (deadline?) – (klart när?)`; replaced in place when later said (human edits win as always).
3. Live page: "Uppgifter" panel lists tasks; incomplete ones show a calm prompt "Vem ansvarar och när ska det vara klart?" with "Fråga nu" (highlights) — no status dots, text/icons.
4. Avsluta: if incomplete tasks exist, a dialog offers them, gently (2026-11-27, 0052): each can be completed inline (type Vem/När/Klart när → written to the Doc; Enter saves; Vem suggests the förening's people, När common deadlines) or left as it is ("Lämna som det är"), and "Avsluta ändå" ends at once whatever is handled (typed but unsaved fields are sent too). Admins see "Fråga inte igen i den här föreningen" in the dialog (turns the setting off, with Ångra). Meet-like auto-end (no tab) never blocks — it ends and the summary lists incomplete tasks.
5. Summary e-mails / Från förra veckan / Översikt show deadline + klart när; overdue marked.

## Företag (suggest, later with the space kind): same fields, prompts are suggestions only, Avsluta never asks.
## Privat: no prompts; the e-mail lists tasks with whatever fields are known.

## Setting
Per förening, Inställningar → Allmänt: "Fråga efter Vem, När och Klart när när mötet avslutas" (default on for föreningar); off = suggest-only behaviour. Admins can also turn it off from the Avsluta dialog.

## Measuring (0052)
How people meet the question, counts only (never task text), in `meeting_events`:
- `end_tasks`, one per meeting the dialog ended: `{ incomplete, filled, dismissed, untouched, skipped }` (`skipped`: "Avsluta ändå" before every task was handled; `filled` is what the server parsed).
- `task_setting`, an admin's "Fråga inte igen" (`on: false`) or Ångra (`on: true`) from the dialog: `{ on, from: "end_dialog" }`.

Service admin only (Supabase SQL editor on the prod project, read-only; no UI). Test meetings excluded:

```sql
-- Per week: meetings ended, how many the dialog ended, and what people did there.
-- One row per meeting (a resumed meeting can end twice: the latest counts).
with ended as (
  select distinct on (e.meeting_id) e.meeting_id, date_trunc('week', e.at) as week
  from meeting_events e join meetings m on m.id = e.meeting_id
  where e.kind = 'ended' and not m.is_test
  order by e.meeting_id, e.at desc
),
dialog as (
  select distinct on (e.meeting_id) e.meeting_id, (e.detail->>'incomplete')::int as incomplete, (e.detail->>'filled')::int as filled,
         (e.detail->>'dismissed')::int as dismissed, (e.detail->>'untouched')::int as untouched,
         (e.detail->>'skipped')::boolean as skipped
  from meeting_events e join meetings m on m.id = e.meeting_id
  where e.kind = 'end_tasks' and not m.is_test
  order by e.meeting_id, e.at desc
)
select ended.week,
       count(*) as meetings_ended,
       count(dialog.meeting_id) as ended_via_dialog, -- "Fortsätt mötet" logs nothing
       count(*) filter (where dialog.skipped) as ended_anyway,
       count(*) filter (where dialog.filled = 0 and dialog.dismissed = 0) as one_tap_skip,
       sum(dialog.incomplete) as tasks_incomplete,
       sum(dialog.filled) as tasks_filled,
       sum(dialog.dismissed) as tasks_left,
       sum(dialog.untouched) as tasks_untouched
from ended left join dialog using (meeting_id)
group by ended.week order by ended.week desc;

-- Turned off / back on from the dialog, per förening (the latest change last).
select o.name, e.at, (e.detail->>'on')::boolean as on
from meeting_events e join meetings m on m.id = e.meeting_id join orgs o on o.id = m.org_id
where e.kind = 'task_setting' and not m.is_test
order by o.name, e.at;

-- Föreningar that ask today vs not (all changes, also from Inställningar).
select require_task_fields, count(*) from orgs where kind is distinct from 'privat' group by 1;
```
