-- Final fix wave A1 (Ruling 39): an ElevenLabs session closed early may keep streaming (and
-- billing) at ElevenLabs up to its granted max_session_duration_seconds, because we cannot end
-- it server-side (Verify on 11-28). So:
--
-- * Sessions are granted at most 3600 s (least(time left, 1 h)); the browser rolls over to a
--   new session at the limit (new speaker labels, "Vem är detta?").
-- * close_el_session books the session's FULL granted length (max_seconds) for a live session,
--   whenever it is closed (reconnect, end, sweep) — booked ≥ what ElevenLabs can bill. Test
--   sessions still book 0.
-- * An open live session reserves exactly max_seconds (what its close will book) in
--   claim_el_session; the +900 s token window stays only in the "busy" check.
-- * release_unminted_el_session: the token route's mint failed, so no ElevenLabs session exists;
--   the claimed row is closed as kind 'unminted', books nothing and does not count toward the
--   per-meeting mint cap (it still counts for the 5 s spacing).
-- * The meeting's 4 h cap (meeting_seconds) stays on elapsed time: the money caps (org month,
--   global day, global dollars) are the ones booked in full.
--
-- Backward compatible: same function signatures (create or replace), a wider check constraint,
-- one new function. Code deployed before this migration keeps working (it books the full hour
-- for a failed mint until the new route is live).

alter table public.el_sessions drop constraint if exists el_sessions_kind_check;
alter table public.el_sessions add constraint el_sessions_kind_check
  check (kind in ('live', 'test', 'unminted'));

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
    s.max_seconds
  into v_kind, v_org, v_seconds;

  if not found or v_kind <> 'live' then
    return 0;
  end if;

  insert into public.usage_daily as u (org_id, day, seconds, usd)
  values (v_org, (now() at time zone 'utc')::date, v_seconds, v_seconds / 3600.0 * p_usd_per_hour)
  on conflict (org_id, day) do update
    set seconds = u.seconds + excluded.seconds, usd = u.usd + excluded.usd;

  return v_seconds;
end;
$$;

-- The mint for a claimed session failed: no ElevenLabs session exists. Closes it without booking.
create or replace function public.release_unminted_el_session(p_session_id text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  update public.el_sessions s
  set closed_at = now(), kind = 'unminted'
  where s.id = p_session_id and s.closed_at is null and s.kind = 'live';
  return found;
end;
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
  if v_mints >= p_max_mints
     or v_last_start > now() - make_interval(secs => p_min_mint_interval_secs) then
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

revoke all on function public.close_el_session(text, numeric) from public, anon, authenticated;
revoke all on function public.release_unminted_el_session(text) from public, anon, authenticated;
revoke all on function public.claim_el_session(uuid, text, text, int, int, bigint, numeric, numeric, int, int)
  from public, anon, authenticated;
grant execute on function public.close_el_session(text, numeric) to service_role;
grant execute on function public.release_unminted_el_session(text) to service_role;
grant execute on function public.claim_el_session(uuid, text, text, int, int, bigint, numeric, numeric, int, int)
  to service_role;
