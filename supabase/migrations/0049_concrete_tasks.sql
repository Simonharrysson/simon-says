-- Concrete tasks (docs/superpowers/specs/2026-11-26-concrete-tasks-design.md): every task gets
-- Vem (owner), När (due) and Klart när (done_when, new). A förening can require all three: the
-- Doc then shows "(vem?)", "(deadline?)", "(klart när?)" for what is missing, the live page asks,
-- and Avsluta asks to complete or dismiss each incomplete task.
--
-- Strictly additive and backward compatible with the deployed code:
-- * note_items.done_when: nullable text; old code never names it (save_note_rows below writes it
--   when the row carries it, and an old-shape row leaves it null);
-- * note_items.due_date: the deadline as a date when `due` names one ("fredag", "3 dec",
--   "2026-12-03"), resolved by the tick against the meeting's start (lib/notes/tasks.ts); null =
--   not a date. Carried tasks keep their source's. Used to mark overdue tasks, never shown as is;
-- * orgs.require_task_fields: default true ("Kräv vem, när och klart när"); admins change it
--   (column grant, like share_transcript; orgs_update lets admins only);
-- * meetings.task_answers: what the Avsluta dialog filled in, applied by the final pass after
--   Claude's tidy-up (so Claude can't undo it, and a cron retry still has it). Server-only writes.

alter table public.note_items add column done_when text, add column due_date date;

alter table public.orgs add column require_task_fields boolean not null default true;
grant update (require_task_fields) on table public.orgs to authenticated;

alter table public.meetings add column task_answers jsonb;

-- save_note_rows v3: also writes done_when and due_date (kept as stored when a row lacks the key). Same name and parameters as v2 (0024).
create or replace function public.save_note_rows(p_meeting_id uuid, p_lease_id uuid, p_rows jsonb)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform 1 from public.meetings mt
  where mt.id = p_meeting_id and mt.tick_lease_id = p_lease_id
  for update;
  if not found then
    return false;
  end if;

  insert into public.note_items as n (
    meeting_id, id, section, text, owner, due, locked, deleted_by_human, last_rendered_text, range_name, position,
    kind, anchor, done, owner_person_id, carried_from_meeting, carried_from_id, copy_of, done_when, due_date
  )
  select
    p_meeting_id, r.id, r.section, r.text, r.owner, r.due,
    coalesce(r.locked, false), coalesce(r.deleted_by_human, false), r.last_rendered_text, r.range_name,
    coalesce(r.position, 0),
    r.kind, r.anchor, coalesce(r.done, false), r.owner_person_id, r.carried_from_meeting, r.carried_from_id, r.copy_of,
    -- A row without the key (code from before this migration, during a deploy rollover) keeps the
    -- stored value; a row with the key (null included) sets it, so new code can still clear it.
    case when e ? 'done_when' then r.done_when else cur.done_when end,
    case when e ? 'due_date' then r.due_date else cur.due_date end
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
  cross join lateral jsonb_to_record(e) as r(
    id text, section text, text text, owner text, due text, locked boolean, deleted_by_human boolean,
    last_rendered_text text, range_name text, position int,
    kind text, anchor text, done boolean, owner_person_id uuid, carried_from_meeting uuid, carried_from_id text,
    copy_of text, done_when text, due_date date
  )
  left join public.note_items cur on cur.meeting_id = p_meeting_id and cur.id = r.id
  where true -- ends the join, so "on conflict" below is not read as a join condition
  on conflict (meeting_id, id) do update set
    section = excluded.section,
    text = excluded.text,
    owner = excluded.owner,
    due = excluded.due,
    locked = excluded.locked,
    deleted_by_human = excluded.deleted_by_human,
    last_rendered_text = excluded.last_rendered_text,
    range_name = excluded.range_name,
    position = excluded.position,
    kind = excluded.kind,
    anchor = excluded.anchor,
    done = excluded.done,
    owner_person_id = excluded.owner_person_id,
    carried_from_meeting = excluded.carried_from_meeting,
    carried_from_id = excluded.carried_from_id,
    copy_of = excluded.copy_of,
    done_when = excluded.done_when,
    due_date = excluded.due_date;

  delete from public.note_items n
  where n.meeting_id = p_meeting_id
    and n.id not in (select e->>'id' from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e);
  return true;
end;
$$;

revoke all on function public.save_note_rows(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_note_rows(uuid, uuid, jsonb) to service_role;
