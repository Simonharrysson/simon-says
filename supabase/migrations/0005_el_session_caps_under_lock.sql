-- Task 4 fix round 1: caps decided under a lock, counting what open sessions may still use;
-- ElevenLabs dollars booked; a mint rate limit per meeting.
--
-- Reservations. ElevenLabs enforces only each token's own max_session_duration_seconds, and it
-- starts that clock when the socket connects, which may be up to 15 min (the token's use
-- window) after the mint. So an open session may run until
--     started_at + max_seconds + 900 s          ("its window end")
-- and that is the cap for booking it, for counting its elapsed time, and for treating it as
-- expired. While open, it "commits" max_seconds + 900 s: elapsed so far plus what it may still
-- use. A new session's max is what's left after everything committed, org-wide and globally.
--
-- LOCK ORDER (every function that takes more than one of these must follow it, incl. Task 10's
-- end/cleanup jobs):
--   1. pg_advisory_xact_lock(hashtext('el_global'))
--   2. pg_advisory_xact_lock(hashtext('el_org:' || org_id))
--   3. meetings row (select … for update)
--   4. el_sessions rows
--   5. usage_daily rows
-- close_el_session alone takes only 4 → 5, so it may be called with or without 1–3 held.
--
-- Backward compatible: replaces function bodies with the same signatures, adds functions, and
-- drops begin_el_session (0004), which no deployed code calls (0004 has not reached prod and
-- the only caller is replaced in the same commit).

-- ---------------------------------------------------------------------------------------------
-- Booking (now also dollars)

-- Close a session, booking its seconds (capped at its window end) and their ElevenLabs cost.
-- Idempotent: returns 0 when the session is unknown or already closed.
create function public.close_el_session(p_session_id text, p_usd_per_hour numeric)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_seconds int;
begin
  if p_usd_per_hour is null or p_usd_per_hour < 0 then
    raise exception 'close_el_session: p_usd_per_hour must be >= 0' using errcode = '22023';
  end if;

  update public.el_sessions s
  set closed_at = now()
  where s.id = p_session_id and s.closed_at is null
  returning
    (select mt.org_id from public.meetings mt where mt.id = s.meeting_id),
    greatest(0, ceil(extract(epoch from
      least(now(), s.started_at + make_interval(secs => s.max_seconds + 900)) - s.started_at
    )))::int
  into v_org, v_seconds;

  if not found then
    return 0;
  end if;

  insert into public.usage_daily as u (org_id, day, seconds, usd)
  values (v_org, (now() at time zone 'utc')::date, v_seconds, v_seconds / 3600.0 * p_usd_per_hour)
  on conflict (org_id, day) do update
    set seconds = u.seconds + excluded.seconds, usd = u.usd + excluded.usd;

  return v_seconds;
end;
$$;

-- 0004's one-argument form, kept for compatibility: books at the default rate, $0.22/h
-- (ElevenLabs Creator overage). Server code passes ELEVENLABS_USD_PER_HOUR instead.
create or replace function public.close_el_session(p_session_id text)
returns int
language sql volatile security definer set search_path = ''
as $$
  select public.close_el_session(p_session_id, 0.22);
$$;

-- ---------------------------------------------------------------------------------------------
-- Usage counts: elapsed time of open sessions is capped at their window end.

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
      where mt.org_id = p_org_id and s.closed_at is null
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
  where s.meeting_id = p_meeting_id;
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
      where s.closed_at is null
    ), 0);
$$;

-- ---------------------------------------------------------------------------------------------
-- The token lock, with the caps decided inside it.

drop function if exists public.begin_el_session(uuid, text, int, text);

-- Claim a new ElevenLabs session for a live meeting and decide its max_seconds.
-- Under the locks above, in this order:
--   not_found / not_live / no_consent
--   busy             a current session may still be running: allowed only if the caller closes
--                    it (p_closing_session_id), it is closed, it is past its window end, or the
--                    page has been silent > 60 s (heartbeat, or its start if none came yet)
--   reconnect_limit  >= p_max_mints sessions for this meeting, or the last one started less
--                    than p_min_mint_interval_secs ago
--   (the previous current session is closed and booked here)
--   global_usd / meeting_length / org_month / global_day
--                    nothing left after what's used and what open sessions have committed
--   ok               new session inserted and made current; max_seconds = the time left
-- A claim counts as a heartbeat. max_seconds is null unless status = 'ok'.
create function public.claim_el_session(
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
  from public.el_sessions s where s.meeting_id = p_meeting_id;
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
        where mt.org_id = v_org and s.closed_at is null
      ), 0);

  v_global_left := p_global_day_cap_secs
    - coalesce((
        select sum(u.seconds) from public.usage_daily u
        where u.day = (now() at time zone 'utc')::date
      ), 0)
    - coalesce((select sum(s.max_seconds + 900) from public.el_sessions s where s.closed_at is null), 0);

  v_usd_spent :=
    coalesce((select sum(u.usd) from public.usage_daily u where u.day = (now() at time zone 'utc')::date), 0)
    + coalesce((select sum(s.max_seconds + 900) from public.el_sessions s where s.closed_at is null), 0)
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

-- ---------------------------------------------------------------------------------------------

revoke all on function public.close_el_session(text, numeric) from public, anon, authenticated;
revoke all on function public.claim_el_session(uuid, text, text, int, int, bigint, numeric, numeric, int, int)
  from public, anon, authenticated;
grant execute on function public.close_el_session(text, numeric) to service_role;
grant execute on function public.claim_el_session(uuid, text, text, int, int, bigint, numeric, numeric, int, int)
  to service_role;
