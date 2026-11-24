-- Task T: "Testmöte", a server-side test meeting through the real pipeline.
--
-- * el_sessions.kind: 'live' (ElevenLabs, the default, so every existing row and caller is
--   unchanged) or 'test' (the server-side feeder's stand-in session).
-- * A test session never counts: not toward the meeting, org-month or global-day hours, not as
--   a reservation in claim_el_session, and closing it books nothing (0 seconds, $0 ElevenLabs).
--   Claude usage is recorded as usual (it is a separate ledger).
-- * meeting_events gets 'test_started' (the constraint only ever widens).
-- Backward compatible: one additive column, same function signatures (create or replace).

alter table public.el_sessions
  add column kind text not null default 'live' check (kind in ('live', 'test'));

alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed', 'test_started'
  )
);

-- Close a session. Live: books seconds and dollars as in 0005. Test: just closes it.
create or replace function public.close_el_session(p_session_id text, p_usd_per_hour numeric)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_seconds int;
  v_kind text;
begin
  if p_usd_per_hour is null or p_usd_per_hour < 0 then
    raise exception 'close_el_session: p_usd_per_hour must be >= 0' using errcode = '22023';
  end if;

  update public.el_sessions s
  set closed_at = now()
  where s.id = p_session_id and s.closed_at is null
  returning
    s.kind,
    (select mt.org_id from public.meetings mt where mt.id = s.meeting_id),
    greatest(0, ceil(extract(epoch from
      least(now(), s.started_at + make_interval(secs => s.max_seconds + 900)) - s.started_at
    )))::int
  into v_kind, v_org, v_seconds;

  if not found or v_kind = 'test' then
    return 0;
  end if;

  insert into public.usage_daily as u (org_id, day, seconds, usd)
  values (v_org, (now() at time zone 'utc')::date, v_seconds, v_seconds / 3600.0 * p_usd_per_hour)
  on conflict (org_id, day) do update
    set seconds = u.seconds + excluded.seconds, usd = u.usd + excluded.usd;

  return v_seconds;
end;
$$;

create or replace function public.org_month_seconds(p_org_id uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select
    coalesce((
      select sum(u.seconds)::bigint from public.usage_daily u
      where u.org_id = p_org_id
        and u.day >= date_trunc('month', now() at time zone 'utc')::date
    ), 0)
    + coalesce((
      select sum(greatest(0, extract(epoch from
          least(now(), s.started_at + make_interval(secs => s.max_seconds + 900)) - s.started_at
        )))::bigint
      from public.el_sessions s
      join public.meetings mt on mt.id = s.meeting_id
      where mt.org_id = p_org_id and s.closed_at is null and s.kind = 'live'
    ), 0);
$$;

create or replace function public.meeting_seconds(p_meeting_id uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(greatest(0, ceil(extract(epoch from
      least(coalesce(s.closed_at, now()), s.started_at + make_interval(secs => s.max_seconds + 900))
      - s.started_at
    ))))::bigint, 0)
  from public.el_sessions s
  where s.meeting_id = p_meeting_id and s.kind = 'live';
$$;

create or replace function public.global_day_seconds()
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
          least(now(), s.started_at + make_interval(secs => s.max_seconds + 900)) - s.started_at
        ))))::bigint
      from public.el_sessions s
      where s.closed_at is null and s.kind = 'live'
    ), 0);
$$;

-- Same body as 0005 except that only live sessions are counted (mints, reservations).
create or replace function public.claim_el_session(
  p_meeting_id uuid,
  p_new_session_id text,
  p_closing_session_id text,
  p_meeting_cap_secs int,
  p_org_month_cap_secs int,
  p_global_day_cap_secs bigint,
  p_global_usd_cap numeric,
  p_usd_per_hour numeric,
  p_max_mints int,
  p_min_mint_interval_secs int
)
returns table (status text, max_seconds int)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_meeting public.meetings%rowtype;
  v_current public.el_sessions%rowtype;
  v_mints int;
  v_last_start timestamptz;
  v_meeting_left bigint;
  v_org_left bigint;
  v_global_left bigint;
  v_usd_spent numeric;
  v_usd_left_secs bigint;
  v_max bigint;
begin
  -- org_id never changes, so reading it before the locks is safe.
  select mt.org_id into v_org from public.meetings mt where mt.id = p_meeting_id;
  if v_org is null then
    return query select 'not_found'::text, null::int;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('el_global'));
  perform pg_advisory_xact_lock(hashtext('el_org:' || v_org::text));

  select * into v_meeting from public.meetings where id = p_meeting_id for update;
  if not found then
    return query select 'not_found'::text, null::int;
    return;
  end if;
  if v_meeting.status <> 'live' then
    return query select 'not_live'::text, null::int;
    return;
  end if;
  if v_meeting.consent_confirmed_at is null then
    return query select 'no_consent'::text, null::int;
    return;
  end if;

  if v_meeting.current_el_session_id is not null then
    select * into v_current from public.el_sessions where id = v_meeting.current_el_session_id;
    if found and not (
      p_closing_session_id is not distinct from v_current.id
      or v_current.closed_at is not null
      or v_current.started_at + make_interval(secs => v_current.max_seconds + 900) < now()
      or greatest(v_meeting.last_heartbeat_at, v_current.started_at) < now() - interval '60 seconds'
    ) then
      return query select 'busy'::text, null::int;
      return;
    end if;
  end if;

  select count(*), max(s.started_at) into v_mints, v_last_start
  from public.el_sessions s where s.meeting_id = p_meeting_id and s.kind = 'live';
  if v_mints >= p_max_mints
     or v_last_start > now() - make_interval(secs => p_min_mint_interval_secs) then
    return query select 'reconnect_limit'::text, null::int;
    return;
  end if;

  if v_meeting.current_el_session_id is not null then
    perform public.close_el_session(v_meeting.current_el_session_id, p_usd_per_hour);
  end if;

  -- Time left = cap − closed usage − (max_seconds + 900) of every open session.
  v_meeting_left := p_meeting_cap_secs - public.meeting_seconds(p_meeting_id);

  v_org_left := p_org_month_cap_secs
    - coalesce((
        select sum(u.seconds) from public.usage_daily u
        where u.org_id = v_org and u.day >= date_trunc('month', now() at time zone 'utc')::date
      ), 0)
    - coalesce((
        select sum(s.max_seconds + 900) from public.el_sessions s
        join public.meetings mt on mt.id = s.meeting_id
        where mt.org_id = v_org and s.closed_at is null and s.kind = 'live'
      ), 0);

  v_global_left := p_global_day_cap_secs
    - coalesce((
        select sum(u.seconds) from public.usage_daily u
        where u.day = (now() at time zone 'utc')::date
      ), 0)
    - coalesce((select sum(s.max_seconds + 900) from public.el_sessions s where s.closed_at is null and s.kind = 'live'), 0);

  v_usd_spent :=
    coalesce((select sum(u.usd) from public.usage_daily u where u.day = (now() at time zone 'utc')::date), 0)
    + coalesce((select sum(s.max_seconds + 900) from public.el_sessions s where s.closed_at is null and s.kind = 'live'), 0)
      / 3600.0 * p_usd_per_hour;
  v_usd_left_secs := case
    when p_usd_per_hour > 0 then floor((p_global_usd_cap - v_usd_spent) / p_usd_per_hour * 3600)
    else 9223372036854775807
  end;

  if v_usd_spent >= p_global_usd_cap or v_usd_left_secs < 1 then
    return query select 'global_usd'::text, null::int;
  elsif v_meeting_left < 1 then
    return query select 'meeting_length'::text, null::int;
  elsif v_org_left < 1 then
    return query select 'org_month'::text, null::int;
  elsif v_global_left < 1 then
    return query select 'global_day'::text, null::int;
  else
    v_max := least(v_meeting_left, v_org_left, v_global_left, v_usd_left_secs);
    insert into public.el_sessions (id, meeting_id, max_seconds)
    values (p_new_session_id, p_meeting_id, v_max::int);
    update public.meetings
    set current_el_session_id = p_new_session_id, last_heartbeat_at = now()
    where id = p_meeting_id;
    return query select 'ok'::text, v_max::int;
  end if;
end;
$$;

-- create or replace keeps the privileges set in 0002/0004/0005; stated again so they are explicit.
revoke all on function public.close_el_session(text, numeric) from public, anon, authenticated;
revoke all on function public.org_month_seconds(uuid) from public, anon, authenticated;
revoke all on function public.meeting_seconds(uuid) from public, anon, authenticated;
revoke all on function public.global_day_seconds() from public, anon, authenticated;
revoke all on function public.claim_el_session(uuid, text, text, int, int, bigint, numeric, numeric, int, int)
  from public, anon, authenticated;
grant execute on function public.close_el_session(text, numeric) to service_role;
grant execute on function public.org_month_seconds(uuid) to service_role;
grant execute on function public.meeting_seconds(uuid) to service_role;
grant execute on function public.global_day_seconds() to service_role;
grant execute on function public.claim_el_session(uuid, text, text, int, int, bigint, numeric, numeric, int, int)
  to service_role;
