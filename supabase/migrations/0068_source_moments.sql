-- Source moments ("link decision and task to recording"): every decision and task remembers where
-- in the meeting it was said, shown as "▶ 41:52" with that part of the transcript (text only: no
-- audio is stored).
--
-- Strictly additive and backward compatible with the deployed code:
-- * note_items.source_segment_ids: the segments it came from (`<el_session_id>:<segment_index>:
--   <run_index>`, the segments primary key), resolved by the server from the transcript lines the
--   notes engine was sent (lib/notes/sources.ts); null = unknown (every older row);
-- * note_items.said_at_ms: the first source's meeting-relative start, so the Doc, the brief mail
--   and MCP never read segments for the time alone;
-- * save_note_rows v4 writes both, keeping the stored values when a row lacks the key (old code
--   during a deploy rollover);
-- * transcript_visible(): the one rule for who sees the transcript behind a moment: someone who
--   can see the meeting as a member (foretag_can_see: never a guest of 0067) of an org that shares
--   its transcript (orgs.share_transcript, read at every check), never a Privat space;
-- * transcript_moment_lines(): the source lines of some items with a few lines of context, only
--   under that rule, only segments of that same meeting, never the Må-runda window. Service role
--   only (the app's server action and MCP call it with the signed-in user's id).

alter table public.note_items add column source_segment_ids text[], add column said_at_ms bigint;

-- save_note_rows v4: also writes source_segment_ids and said_at_ms. Same name and parameters as v3 (0049).
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
    kind, anchor, done, owner_person_id, carried_from_meeting, carried_from_id, copy_of, done_when, due_date,
    source_segment_ids, said_at_ms
  )
  select
    p_meeting_id, r.id, r.section, r.text, r.owner, r.due,
    coalesce(r.locked, false), coalesce(r.deleted_by_human, false), r.last_rendered_text, r.range_name,
    coalesce(r.position, 0),
    r.kind, r.anchor, coalesce(r.done, false), r.owner_person_id, r.carried_from_meeting, r.carried_from_id, r.copy_of,
    -- A row without the key (code from before the migration, during a deploy rollover) keeps the
    -- stored value; a row with the key (null included) sets it, so new code can still clear it.
    case when e ? 'done_when' then r.done_when else cur.done_when end,
    case when e ? 'due_date' then r.due_date else cur.due_date end,
    case when e ? 'source_segment_ids' then r.source_segment_ids else cur.source_segment_ids end,
    case when e ? 'said_at_ms' then r.said_at_ms else cur.said_at_ms end
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
  cross join lateral jsonb_to_record(e) as r(
    id text, section text, text text, owner text, due text, locked boolean, deleted_by_human boolean,
    last_rendered_text text, range_name text, position int,
    kind text, anchor text, done boolean, owner_person_id uuid, carried_from_meeting uuid, carried_from_id text,
    copy_of text, done_when text, due_date date, source_segment_ids text[], said_at_ms bigint
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
    due_date = excluded.due_date,
    source_segment_ids = excluded.source_segment_ids,
    said_at_ms = excluded.said_at_ms;

  delete from public.note_items n
  where n.meeting_id = p_meeting_id
    and n.id not in (select e->>'id' from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e);
  return true;
end;
$$;

revoke all on function public.save_note_rows(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_note_rows(uuid, uuid, jsonb) to service_role;

-- May p_user read the transcript of p_meeting_id? Seen as a member (the meetings_select rule) AND
-- the org shares its transcript, never a Privat space. Service role only: p_user is explicit.
create function public.transcript_visible(p_user uuid, p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_user is not null
    and public.foretag_can_see(p_user, p_meeting_id)
    and exists (
      select 1 from public.meetings mt join public.orgs o on o.id = mt.org_id
      where mt.id = p_meeting_id and o.share_transcript and o.kind <> 'privat'
    );
$$;
revoke all on function public.transcript_visible(uuid, uuid) from public, anon, authenticated;
grant execute on function public.transcript_visible(uuid, uuid) to service_role;

-- The meetings among p_ids whose transcript p_user may read (the brief mail, MCP).
create function public.transcript_visible_ids(p_user uuid, p_ids uuid[])
returns setof uuid
language sql stable security definer set search_path = ''
as $$ select i from unnest(coalesce(p_ids, '{}')) as i where public.transcript_visible(p_user, i) $$;
revoke all on function public.transcript_visible_ids(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.transcript_visible_ids(uuid, uuid[]) to service_role;

-- The source lines of p_item_ids (rows of p_meeting_id, not deleted by a human) plus p_context
-- lines (0–10) before and after the first one, in transcript order. Nothing when p_user may not
-- read the transcript; a source that is not a segment of this meeting (or lies in the Må-runda
-- window, or was never sent: no tick_no) is not returned, so it never shows a wrong line.
create function public.transcript_moment_lines(p_user uuid, p_meeting_id uuid, p_item_ids text[], p_context int)
returns table (
  item_id text, el_session_id text, segment_index int, run_index int,
  speaker text, text text, start_ms bigint, is_source boolean
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ctx int := least(greatest(coalesce(p_context, 0), 0), 10);
  v_window jsonb;
  v_from bigint;
  v_to bigint;
begin
  if not public.transcript_visible(p_user, p_meeting_id) then
    return;
  end if;
  select mt.checkin_window into v_window from public.meetings mt where mt.id = p_meeting_id;
  v_from := nullif(v_window->>'startMs', '')::bigint;
  v_to := nullif(v_window->>'endMs', '')::bigint;
  return query
  with segs as (
    select s.el_session_id, s.segment_index, s.run_index, s.speaker, s.text, s.start_ms,
      s.el_session_id || ':' || s.segment_index || ':' || s.run_index as key,
      row_number() over (order by s.start_ms, es.started_at, s.el_session_id, s.segment_index, s.run_index) as rn
    from public.segments s
    join public.el_sessions es on es.id = s.el_session_id
    where s.meeting_id = p_meeting_id
      and s.tick_no is not null
      and not (v_from is not null and s.start_ms >= v_from and (v_to is null or s.start_ms < v_to))
  ),
  items as (
    select n.id, n.source_segment_ids as src
    from public.note_items n
    where n.meeting_id = p_meeting_id
      and n.id = any(coalesce(p_item_ids, '{}'))
      and not n.deleted_by_human
      and n.source_segment_ids is not null
  ),
  targets as (
    -- From the first source to the last, at most 6 lines apart (a far-off citation adds no wall of text).
    select i.id, i.src, min(sg.rn) as rn, least(max(sg.rn), min(sg.rn) + 6) as last_rn
    from items i join segs sg on sg.key = any(i.src)
    group by i.id, i.src
  )
  select t.id, sg.el_session_id, sg.segment_index, sg.run_index, sg.speaker, sg.text, sg.start_ms, sg.key = any(t.src)
  from targets t
  join segs sg on sg.rn between t.rn - v_ctx and t.last_rn + v_ctx
  where v_ctx > 0 or sg.key = any(t.src)
  order by t.id, sg.rn;
end;
$$;
revoke all on function public.transcript_moment_lines(uuid, uuid, text[], int) from public, anon, authenticated;
grant execute on function public.transcript_moment_lines(uuid, uuid, text[], int) to service_role;
