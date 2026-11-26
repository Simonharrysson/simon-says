-- Admin handover (todo #8, audit B3): board turnover is yearly, so an admin can make another
-- member admin, or take admin away again. A förening always keeps at least one admin.
--
-- * set_member_role(org, user, role): admins only (42501 otherwise). Returns ok | unchanged |
--   not_member | last_admin | not_found | invalid. Takes the same org row lock as
--   remove_org_member_locked (0018), so two admins can't demote each other at once.
-- * keep_org_admin trigger on org_members: the backstop for every write path (service role,
--   future functions). After a row stops being admin (role update or delete) it locks the org
--   and, if no admin is left:
--     - org gone (org deleted, cascade)              -> allowed
--     - member row deleted because the account was   -> the oldest remaining member becomes
--       deleted (auth.users cascade)                     admin (or nobody is left: allowed)
--     - anything else (demote / remove / leave)      -> raises 'last_admin' (23514)
-- * Backfill: orgs that already lost their only admin (account deleted before this) get their
--   oldest member promoted.
-- No audit row: the only event log (meeting_events) is per meeting; there is no org-level log.
-- Backward compatible: a new function, a trigger that only refuses what the deployed code
-- already refuses ('last_admin' in 0018), and a data fix.

create function public.keep_org_admin()
returns trigger
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_next uuid;
begin
  if old.role <> 'admin' or (tg_op = 'UPDATE' and new.role = 'admin') then
    return null;
  end if;
  -- Same lock as remove_org_member_locked / set_member_role; the counts below then see every
  -- committed change (read committed, fresh snapshot per statement).
  perform 1 from public.orgs o where o.id = old.org_id for update;
  if not found then
    return null; -- the org itself is being deleted
  end if;
  if exists (select 1 from public.org_members m where m.org_id = old.org_id and m.role = 'admin') then
    return null;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from auth.users u where u.id = old.user_id) then
    -- The last admin's account was deleted: hand the förening to its oldest member.
    select m.user_id into v_next from public.org_members m
    where m.org_id = old.org_id order by m.joined_at, m.user_id limit 1;
    if v_next is not null then
      update public.org_members m set role = 'admin' where m.org_id = old.org_id and m.user_id = v_next;
    end if;
    return null;
  end if;
  raise exception 'last_admin: the org must keep an admin' using errcode = '23514';
end;
$$;

create trigger org_members_keep_admin
  after update of role or delete on public.org_members
  for each row execute function public.keep_org_admin();

-- Admins set a member's role. The last admin can't be demoted (not even by themselves).
create function public.set_member_role(p_org_id uuid, p_user_id uuid, p_role text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_old text;
begin
  if auth.uid() is null or not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can change member roles' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'member') then
    return 'invalid';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  if not found then
    return 'not_found';
  end if;
  select m.role into v_old from public.org_members m where m.org_id = p_org_id and m.user_id = p_user_id;
  if v_old is null then
    return 'not_member';
  end if;
  if v_old = p_role then
    return 'unchanged';
  end if;
  if v_old = 'admin' and (
    select count(*) from public.org_members m where m.org_id = p_org_id and m.role = 'admin'
  ) <= 1 then
    return 'last_admin';
  end if;
  update public.org_members m set role = p_role where m.org_id = p_org_id and m.user_id = p_user_id;
  return 'ok';
end;
$$;

revoke all on function public.keep_org_admin() from public, anon, authenticated;
revoke all on function public.set_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;

-- Orgs that lost their only admin before this migration: promote the oldest member.
update public.org_members m set role = 'admin'
from (
  select distinct on (x.org_id) x.org_id, x.user_id
  from public.org_members x
  where not exists (select 1 from public.org_members a where a.org_id = x.org_id and a.role = 'admin')
  order by x.org_id, x.joined_at, x.user_id
) first_member
where m.org_id = first_member.org_id and m.user_id = first_member.user_id;
