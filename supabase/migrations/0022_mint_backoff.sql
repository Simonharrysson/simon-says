-- Final-wave residual R2 (controller Ruling 42): mint spacing grows with the meeting's live mint
-- count. Each reconnect closes the previous session, which is booked at its full granted hour
-- (Ruling 39), so a fixed 5 s spacing let a reconnect storm book ~14 h of the org's 20 h/month in
-- about two minutes. Spacing = base × 2^max(0, mints − 4) seconds, capped at 600 s.
-- claim_el_session keeps its signature and otherwise the behaviour of 0017.
-- Backward compatible: create or replace with the same signature, one new helper.

create function public.mint_spacing_secs(p_base_secs int, p_live_mints int)
returns int
language sql immutable security definer set search_path = ''
as $$
  select least(600, (p_base_secs * power(2, greatest(0, least(p_live_mints, 30) - 4)))::bigint)::int;
$$;

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
  v_open_reserved bigint;
begin
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

  -- Mint cap: live sessions only (a failed mint is 'unminted'). Spacing: every attempt.
  select count(*) filter (where s.kind = 'live'), max(s.started_at) into v_mints, v_last_start
  from public.el_sessions s where s.meeting_id = p_meeting_id and s.kind in ('live', 'unminted');
  -- R2: the spacing doubles with every mint past the 4th (5, 10, 20 … s), capped at 10 min, so a
  -- reconnect storm (each reconnect books a full session hour) can't burn the month in minutes.
  if v_mints >= p_max_mints
     or v_last_start > now() - make_interval(secs => public.mint_spacing_secs(p_min_mint_interval_secs, v_mints)) then
    return query select 'reconnect_limit'::text, null::int;
    return;
  end if;

  if v_meeting.current_el_session_id is not null then
    perform public.close_el_session(v_meeting.current_el_session_id, p_usd_per_hour);
  end if;

  v_meeting_left := p_meeting_cap_secs - public.meeting_seconds(p_meeting_id);

  v_org_left := p_org_month_cap_secs
    - coalesce((
        select sum(u.seconds) from public.usage_daily u
        where u.org_id = v_org and u.day >= date_trunc('month', now() at time zone 'utc')::date
      ), 0)
    - coalesce((
        select sum(s.max_seconds) from public.el_sessions s
        join public.meetings mt on mt.id = s.meeting_id
        where mt.org_id = v_org and s.closed_at is null and s.kind = 'live'
      ), 0);

  v_open_reserved := coalesce((
    select sum(s.max_seconds) from public.el_sessions s where s.closed_at is null and s.kind = 'live'
  ), 0);

  v_global_left := p_global_day_cap_secs
    - coalesce((
        select sum(u.seconds) from public.usage_daily u
        where u.day = (now() at time zone 'utc')::date
      ), 0)
    - v_open_reserved;

  v_usd_spent :=
    coalesce((select sum(u.usd) from public.usage_daily u where u.day = (now() at time zone 'utc')::date), 0)
    + v_open_reserved / 3600.0 * p_usd_per_hour;
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
    -- At most one hour per session (Ruling 39): an orphaned socket can bill at most 1 h.
    v_max := least(v_meeting_left, v_org_left, v_global_left, v_usd_left_secs, 3600);
    insert into public.el_sessions (id, meeting_id, max_seconds)
    values (p_new_session_id, p_meeting_id, v_max::int);
    update public.meetings
    set current_el_session_id = p_new_session_id, last_heartbeat_at = now()
    where id = p_meeting_id;
    return query select 'ok'::text, v_max::int;
  end if;
end;
$$;

revoke all on function public.mint_spacing_secs(int, int) from public, anon, authenticated;
revoke all on function public.claim_el_session(uuid, text, text, int, int, bigint, numeric, numeric, int, int)
  from public, anon, authenticated;
grant execute on function public.mint_spacing_secs(int, int) to service_role;
grant execute on function public.claim_el_session(uuid, text, text, int, int, bigint, numeric, numeric, int, int)
  to service_role;
