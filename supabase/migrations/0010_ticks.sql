-- Task 10: server-driven notes ticks, ending a meeting, cron finalize. Additive and backward
-- compatible: two nullable/defaulted columns, a wider event-kind check, new functions.
--
-- * meetings.notes_next_id: the meeting's notes id counter (`n<k>`, Ruling 19), so an id is
--   never reissued, even after the service removed its own item.
-- * meetings.notes_sent_tick: the highest transcript tick_no included in a Claude call; at most
--   20 new transcript blocks go into one call (cache lookback window).
-- * claim_tick_lease: the per-meeting tick lease (4 min), taken with the database clock. Also
--   stamps last_tick_at on every attempt, so a failing tick cannot re-fire on every segments
--   POST; p_min_interval_secs is the hard floor between ticks (0 for the final tick).
-- * record_claude_usage: add one Claude call's tokens and dollars to usage_daily atomically.
-- * close_expired_el_sessions: close every open session past its window end
--   (started_at + max_seconds + 900 s, see 0005) and book it.
-- Lock order (0005): claim_tick_lease takes only the meetings row; close_expired_el_sessions
-- locks every expired el_sessions row first, then books each (usage_daily), so 4 → 5 holds.

alter table public.meetings add column if not exists notes_next_id text;
alter table public.meetings add column if not exists notes_sent_tick int not null default 0;

alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed'
  )
);

-- Returns 'ok' | 'busy' (lease held) | 'too_soon' (last tick < p_min_interval_secs ago) | 'not_found'.
create function public.claim_tick_lease(p_meeting_id uuid, p_min_interval_secs int)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row public.meetings%rowtype;
begin
  select * into v_row from public.meetings where id = p_meeting_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_row.tick_lease_until is not null and v_row.tick_lease_until >= now() then
    return 'busy';
  end if;
  if p_min_interval_secs > 0 and v_row.last_tick_at is not null
     and v_row.last_tick_at > now() - make_interval(secs => p_min_interval_secs) then
    return 'too_soon';
  end if;
  update public.meetings
  set tick_lease_until = now() + interval '4 minutes', last_tick_at = now()
  where id = p_meeting_id;
  return 'ok';
end;
$$;

create function public.record_claude_usage(
  p_org_id uuid,
  p_input bigint,
  p_output bigint,
  p_cache_read bigint,
  p_cache_write bigint,
  p_usd numeric
)
returns void
language sql volatile security definer set search_path = ''
as $$
  insert into public.usage_daily as u (
    org_id, day, claude_input_tokens, claude_output_tokens, cache_read_tokens, cache_write_tokens, usd
  )
  values (
    p_org_id, (now() at time zone 'utc')::date,
    greatest(p_input, 0), greatest(p_output, 0), greatest(p_cache_read, 0), greatest(p_cache_write, 0),
    greatest(p_usd, 0)
  )
  on conflict (org_id, day) do update set
    claude_input_tokens = u.claude_input_tokens + excluded.claude_input_tokens,
    claude_output_tokens = u.claude_output_tokens + excluded.claude_output_tokens,
    cache_read_tokens = u.cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = u.cache_write_tokens + excluded.cache_write_tokens,
    usd = u.usd + excluded.usd;
$$;

-- Returns the number of sessions closed.
create function public.close_expired_el_sessions(p_usd_per_hour numeric)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id text;
  v_count int := 0;
begin
  -- Lock all expired rows before touching usage_daily (lock order 4 → 5).
  perform 1 from public.el_sessions s
  where s.closed_at is null
    and s.started_at + make_interval(secs => s.max_seconds + 900) < now()
  order by s.id
  for update;
  for v_id in
    select s.id from public.el_sessions s
    where s.closed_at is null
      and s.started_at + make_interval(secs => s.max_seconds + 900) < now()
    order by s.id
  loop
    perform public.close_el_session(v_id, p_usd_per_hour);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.claim_tick_lease(uuid, int) from public, anon, authenticated;
revoke all on function public.record_claude_usage(uuid, bigint, bigint, bigint, bigint, numeric) from public, anon, authenticated;
revoke all on function public.close_expired_el_sessions(numeric) from public, anon, authenticated;

grant execute on function public.claim_tick_lease(uuid, int) to service_role;
grant execute on function public.record_claude_usage(uuid, bigint, bigint, bigint, bigint, numeric) to service_role;
grant execute on function public.close_expired_el_sessions(numeric) to service_role;
