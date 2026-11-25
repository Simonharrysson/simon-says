-- Final fix wave B1/B2: tick health and the tick lease.
--
-- * claim_tick_lease: the lease is 6 minutes (was 4), longer than any route's maxDuration
--   (300 s), and ticks now get a deadline (segments route: request start + 270 s), so a tick can
--   no longer outlive its lease.
-- * save_note_rows: write a tick's note_items (upsert + drop the rest) only while the tick still
--   holds the lease (atomic, under the meeting row lock). A stale tick whose lease moved on is a
--   no-op instead of deleting the newer tick's rows.
-- * meeting_events kind 'final_without_claude': the final pass wrote the Doc without asking
--   Claude (too little time left, or the spend caps) although transcript was unsent.
-- Backward compatible: same signature for claim_tick_lease, a new function, a wider check.

create or replace function public.claim_tick_lease(p_meeting_id uuid, p_min_interval_secs int)
returns table (result text, lease_id uuid)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row public.meetings%rowtype;
  v_lease uuid := gen_random_uuid();
begin
  select * into v_row from public.meetings where id = p_meeting_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if v_row.tick_lease_until is not null and v_row.tick_lease_until >= now() then
    return query select 'busy'::text, null::uuid;
    return;
  end if;
  if p_min_interval_secs > 0 and v_row.last_tick_at is not null
     and v_row.last_tick_at > now() - make_interval(secs => p_min_interval_secs) then
    return query select 'too_soon'::text, null::uuid;
    return;
  end if;
  update public.meetings
  set tick_lease_until = now() + interval '6 minutes', tick_lease_id = v_lease, last_tick_at = now()
  where id = p_meeting_id;
  return query select 'ok'::text, v_lease;
end;
$$;

-- Returns false (and writes nothing) when p_lease_id is no longer the meeting's tick lease.
create function public.save_note_rows(p_meeting_id uuid, p_lease_id uuid, p_rows jsonb)
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
    meeting_id, id, section, text, owner, due, locked, deleted_by_human, last_rendered_text, range_name, position
  )
  select
    p_meeting_id, r.id, r.section, r.text, r.owner, r.due,
    coalesce(r.locked, false), coalesce(r.deleted_by_human, false), r.last_rendered_text, r.range_name,
    coalesce(r.position, 0)
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
    id text, section text, text text, owner text, due text, locked boolean, deleted_by_human boolean,
    last_rendered_text text, range_name text, position int
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
    position = excluded.position;

  delete from public.note_items n
  where n.meeting_id = p_meeting_id
    and n.id not in (select e->>'id' from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e);
  return true;
end;
$$;

alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed', 'test_started', 'paused', 'unpaused', 'name_round', 'final_without_claude'
  )
);

revoke all on function public.claim_tick_lease(uuid, int) from public, anon, authenticated;
revoke all on function public.save_note_rows(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_tick_lease(uuid, int) to service_role;
grant execute on function public.save_note_rows(uuid, uuid, jsonb) to service_role;
