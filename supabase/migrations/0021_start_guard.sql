-- Final fix wave A1 (Ruling 39): per-starter start limits, enforced atomically after the insert.
-- The route checks before creating the Doc (normal case); this guard runs after the meetings row is
-- inserted, under a per-user advisory lock, so of concurrent starts exactly one survives: a guard
-- that sees another live meeting by the same starter (or the hourly start limit reached by
-- others) deletes its own row and says why. Guards run one at a time, so two rows can't both
-- delete each other: the second guard no longer sees the first's deleted row.
-- Backward compatible: a new function only.

create function public.guard_meeting_start(p_meeting_id uuid, p_max_per_hour int)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid;
begin
  select mt.started_by into v_user from public.meetings mt where mt.id = p_meeting_id;
  if v_user is null then
    return 'not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('meeting_start:' || v_user::text));

  if exists (
    select 1 from public.meetings mt
    where mt.started_by = v_user and mt.status = 'live' and mt.id <> p_meeting_id
  ) then
    delete from public.meetings where id = p_meeting_id;
    return 'starter_busy';
  end if;

  if (
    select count(*) from public.meetings mt
    where mt.started_by = v_user and mt.id <> p_meeting_id and mt.started_at > now() - interval '1 hour'
  ) >= p_max_per_hour then
    delete from public.meetings where id = p_meeting_id;
    return 'start_rate';
  end if;

  return 'ok';
end;
$$;

revoke all on function public.guard_meeting_start(uuid, int) from public, anon, authenticated;
grant execute on function public.guard_meeting_start(uuid, int) to service_role;
