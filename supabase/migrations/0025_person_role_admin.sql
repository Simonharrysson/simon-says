-- Roles are set by an org admin only (spec G5). Members may still add and rename people, but
-- people.role is no longer writable through the table: it goes through set_person_role().
-- Backward compatible: the deployed code only inserts (org_id, name) and updates name.

revoke update, insert on public.people from authenticated;
grant insert (org_id, name, member_user_id) on public.people to authenticated;
grant update (name, member_user_id) on public.people to authenticated;

create function public.set_person_role(p_person_id uuid, p_role text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_role text := nullif(btrim(p_role), '');
begin
  if auth.uid() is null then
    return false;
  end if;
  select p.org_id into v_org from public.people p where p.id = p_person_id;
  if v_org is null or not public.is_org_admin(v_org) then
    return false;
  end if;
  if v_role is not null and length(v_role) not between 1 and 40 then
    return false;
  end if;
  update public.people set role = v_role where id = p_person_id;
  return true;
end;
$$;

revoke all on function public.set_person_role(uuid, text) from public, anon;
grant execute on function public.set_person_role(uuid, text) to authenticated;
