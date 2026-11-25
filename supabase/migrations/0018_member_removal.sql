-- Final fix wave A2: an admin can remove a member, and a member can leave an org.
--
-- * remove_member(org, user): admins only. leave_org(org): any member, for themselves.
-- * The org always keeps an admin: removing or leaving as the last admin is refused
--   ('last_admin'); the org row is locked so two admins can't both leave at once.
-- * The removed user's link from the org's people list (people.member_user_id) is cleared;
--   the person (a name) stays.
-- * Existing Google Docs stay shared with them (the Docs are in the starters' Drives; v1 call,
--   said in the confirm copy). They lose the org, its meetings and new Docs.
-- * org_member_list(org): user id, email, role for the members panel (service role only, like
--   member_emails: auth.users isn't exposed over the API).
-- Backward compatible: new functions only.

create function public.remove_org_member_locked(p_org_id uuid, p_user_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_role text;
begin
  perform 1 from public.orgs o where o.id = p_org_id for update;
  if not found then
    return 'not_found';
  end if;
  select m.role into v_role from public.org_members m where m.org_id = p_org_id and m.user_id = p_user_id;
  if v_role is null then
    return 'not_member';
  end if;
  if v_role = 'admin' and (
    select count(*) from public.org_members m where m.org_id = p_org_id and m.role = 'admin'
  ) <= 1 then
    return 'last_admin';
  end if;
  delete from public.org_members m where m.org_id = p_org_id and m.user_id = p_user_id;
  update public.people p set member_user_id = null where p.org_id = p_org_id and p.member_user_id = p_user_id;
  return 'removed';
end;
$$;

-- Admins remove a member (or another admin, never the last one). Returns removed | not_member |
-- last_admin | not_found; raises 42501 for non-admins.
create function public.remove_member(p_org_id uuid, p_user_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can remove members' using errcode = '42501';
  end if;
  return public.remove_org_member_locked(p_org_id, p_user_id);
end;
$$;

-- A member leaves. Returns removed | not_member | last_admin | not_found.
create function public.leave_org(p_org_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return public.remove_org_member_locked(p_org_id, auth.uid());
end;
$$;

create function public.org_member_list(p_org_id uuid)
returns table (user_id uuid, email text, role text)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, u.email::text, m.role from public.org_members m
  join auth.users u on u.id = m.user_id
  where m.org_id = p_org_id
  order by m.joined_at;
$$;

revoke all on function public.remove_org_member_locked(uuid, uuid) from public, anon, authenticated;
revoke all on function public.remove_member(uuid, uuid) from public, anon;
revoke all on function public.leave_org(uuid) from public, anon;
revoke all on function public.org_member_list(uuid) from public, anon, authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.leave_org(uuid) to authenticated;
grant execute on function public.org_member_list(uuid) to service_role;
