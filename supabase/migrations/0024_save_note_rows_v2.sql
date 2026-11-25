-- save_note_rows v2: also writes the format fields of a note item. Same name and parameters; rows in
-- the old shape (no new keys) keep working: done defaults to false, the rest to null.

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
    kind, anchor, done, owner_person_id, carried_from_meeting, carried_from_id, copy_of
  )
  select
    p_meeting_id, r.id, r.section, r.text, r.owner, r.due,
    coalesce(r.locked, false), coalesce(r.deleted_by_human, false), r.last_rendered_text, r.range_name,
    coalesce(r.position, 0),
    r.kind, r.anchor, coalesce(r.done, false), r.owner_person_id, r.carried_from_meeting, r.carried_from_id, r.copy_of
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
    id text, section text, text text, owner text, due text, locked boolean, deleted_by_human boolean,
    last_rendered_text text, range_name text, position int,
    kind text, anchor text, done boolean, owner_person_id uuid, carried_from_meeting uuid, carried_from_id text,
    copy_of text
  )
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
    copy_of = excluded.copy_of;

  delete from public.note_items n
  where n.meeting_id = p_meeting_id
    and n.id not in (select e->>'id' from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e);
  return true;
end;
$$;

revoke all on function public.save_note_rows(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_note_rows(uuid, uuid, jsonb) to service_role;
