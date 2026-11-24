-- ElevenLabs session lifecycle and usage helpers for the token endpoint (Task 4).
--
-- * close_el_session: close one session and add its seconds to usage_daily, atomically and
--   idempotently. Seconds come from server times only:
--     ceil(least(now(), started_at + max_seconds) - started_at)
--   booked on the closing day (UTC).
-- * begin_el_session: the token lock. Locks the meeting row, re-checks that a new session may
--   start, closes the previous one and makes the new one current, in one transaction.
-- * meeting_seconds / global_day_seconds: usage for the 4 h meeting cap and the global daily
--   hours cap (closed + elapsed time of open sessions).
-- All service_role only. Backward compatible: adds functions, changes no table.

-- ---------------------------------------------------------------------------------------------

-- Returns the seconds added (0 when the session is unknown or already closed).
create function public.close_el_session(p_session_id text)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_seconds int;
begin
  update public.el_sessions s
  set closed_at = now()
  where s.id = p_session_id and s.closed_at is null
  returning
    (select mt.org_id from public.meetings mt where mt.id = s.meeting_id),
    greatest(0, ceil(extract(epoch from
      least(now(), s.started_at + make_interval(secs => s.max_seconds)) - s.started_at
    )))::int
  into v_org, v_seconds;

  if not found then
    return 0;
  end if;

  insert into public.usage_daily as u (org_id, day, seconds)
  values (v_org, (now() at time zone 'utc')::date, v_seconds)
  on conflict (org_id, day) do update set seconds = u.seconds + excluded.seconds;

  return v_seconds;
end;
$$;

-- Start a new session for a live meeting. A new session may start when the meeting has no
-- current session, or the caller is closing the current one (reconnect), or the current one
-- is closed or past started_at + max_seconds, or the page has been silent for > 60 s
-- (heartbeat, or the session start if no heartbeat came yet). Whatever current session there
-- was is closed (its seconds booked) before the new one becomes current. A mint counts as a
-- heartbeat.
-- Returns 'ok' | 'busy' | 'not_live' | 'not_found'.
create function public.begin_el_session(
  p_meeting_id uuid,
  p_new_session_id text,
  p_max_seconds int,
  p_closing_session_id text
)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_meeting public.meetings%rowtype;
  v_current public.el_sessions%rowtype;
begin
  select * into v_meeting from public.meetings where id = p_meeting_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_meeting.status <> 'live' then
    return 'not_live';
  end if;

  if v_meeting.current_el_session_id is not null then
    select * into v_current from public.el_sessions where id = v_meeting.current_el_session_id;
    if found and not (
      p_closing_session_id is not distinct from v_current.id
      or v_current.closed_at is not null
      or v_current.started_at + make_interval(secs => v_current.max_seconds) < now()
      or greatest(v_meeting.last_heartbeat_at, v_current.started_at) < now() - interval '60 seconds'
    ) then
      return 'busy';
    end if;
    perform public.close_el_session(v_meeting.current_el_session_id);
  end if;

  insert into public.el_sessions (id, meeting_id, max_seconds)
  values (p_new_session_id, p_meeting_id, p_max_seconds);
  update public.meetings
  set current_el_session_id = p_new_session_id, last_heartbeat_at = now()
  where id = p_meeting_id;
  return 'ok';
end;
$$;

-- Seconds used by one meeting: every session, closed or open, from server times.
create function public.meeting_seconds(p_meeting_id uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(greatest(0, ceil(extract(epoch from
      least(coalesce(s.closed_at, now()), s.started_at + make_interval(secs => s.max_seconds))
      - s.started_at
    ))))::bigint, 0)
  from public.el_sessions s
  where s.meeting_id = p_meeting_id;
$$;

-- Seconds used today (UTC) across all orgs, including orgs deleted since: closed sessions'
-- seconds from usage_daily plus the elapsed time of every open session.
create function public.global_day_seconds()
returns bigint
language sql stable security definer set search_path = ''
as $$
  select
    coalesce((
      select sum(u.seconds)::bigint from public.usage_daily u
      where u.day = (now() at time zone 'utc')::date
    ), 0)
    + coalesce((
      select sum(greatest(0, ceil(extract(epoch from
          least(now(), s.started_at + make_interval(secs => s.max_seconds)) - s.started_at
        ))))::bigint
      from public.el_sessions s
      where s.closed_at is null
    ), 0);
$$;

-- ---------------------------------------------------------------------------------------------

revoke all on function public.close_el_session(text) from public, anon, authenticated;
revoke all on function public.begin_el_session(uuid, text, int, text) from public, anon, authenticated;
revoke all on function public.meeting_seconds(uuid) from public, anon, authenticated;
revoke all on function public.global_day_seconds() from public, anon, authenticated;

grant execute on function public.close_el_session(text) to service_role;
grant execute on function public.begin_el_session(uuid, text, int, text) to service_role;
grant execute on function public.meeting_seconds(uuid) to service_role;
grant execute on function public.global_day_seconds() to service_role;
