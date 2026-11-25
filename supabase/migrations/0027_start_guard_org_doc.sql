-- Final review R2-I1: the start guard also serialises starts per org and per Doc. Two members
-- starting on the same suggested Doc at once both passed the route's checks and both went live in
-- one Doc (0021 only locks per starter). guard_meeting_start_v2 does 0021's checks under the same
-- per-user lock, then takes an org lock and a Doc lock (always in the order user → org → Doc, so
-- two guards never wait on each other) and refuses when another live or ending meeting exists in
-- the org ('org_busy') or on the same doc_id in any org ('doc_busy'). A refused guard deletes its
-- own row, as 0021 does.
-- Backward compatible: a new function; guard_meeting_start (0021) is unchanged for code that still
-- calls it (it never returns the new values, which that code would read as success).

create function public.guard_meeting_start_v2(p_meeting_id uuid, p_max_per_hour int)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_org uuid;
  v_doc text;
begin
  select mt.started_by, mt.org_id, mt.doc_id into v_user, v_org, v_doc from public.meetings mt where mt.id = p_meeting_id;
  if v_user is null then
    return 'not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('meeting_start:' || v_user::text));
  perform pg_advisory_xact_lock(hashtext('meeting_start_org:' || v_org::text));
  if v_doc is not null then
    perform pg_advisory_xact_lock(hashtext('meeting_start_doc:' || v_doc));
  end if;

  if exists (
    select 1 from public.meetings mt
    where mt.started_by = v_user and mt.status = 'live' and mt.id <> p_meeting_id
  ) then
    delete from public.meetings where id = p_meeting_id;
    return 'starter_busy';
  end if;

  if exists (
    select 1 from public.meetings mt
    where mt.org_id = v_org and mt.status in ('live', 'ending') and mt.id <> p_meeting_id
  ) then
    delete from public.meetings where id = p_meeting_id;
    return 'org_busy';
  end if;

  if v_doc is not null and exists (
    select 1 from public.meetings mt
    where mt.doc_id = v_doc and mt.status in ('live', 'ending') and mt.id <> p_meeting_id
  ) then
    delete from public.meetings where id = p_meeting_id;
    return 'doc_busy';
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

revoke all on function public.guard_meeting_start_v2(uuid, int) from public, anon, authenticated;
grant execute on function public.guard_meeting_start_v2(uuid, int) to service_role;
