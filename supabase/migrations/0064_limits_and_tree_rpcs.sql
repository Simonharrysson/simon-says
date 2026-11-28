-- 0064: two small fixes. Additive and backward compatible with deployed v1: one new column with a
-- default, one new internal function, and function bodies replaced with the same signatures,
-- return types and grants. Refusals stay what v1 already handles (false / null, the same error
-- texts), never a new exception.
--
-- 1. The create limits (0041, 0045) are about föreningar. A company (kind 'foretag', 0050) counted
--    towards "max 10 orgs" and the lifetime cap of 30 too. Now each kind is counted on its own:
--    * föreningar: max 10 existing, max 30 ever (org_creations, now with the kind of each row);
--    * companies: no limit in the database. Only create_foretag() makes one, with the service role,
--      after the app's allow-list (lib/foretag/gate.ts); clients can't write orgs.kind (0045).
--    * Privat: as 0045 (neither counts nor is counted, no ledger row).
--    Service-role inserts (ADMIN_EMAILS, create_foretag) still skip the limits and are still
--    recorded in the ledger.
--
-- 2. The tree RPCs of 0050/0054 (set_group, set_person_group, place_member, archive_group) wrote
--    the tree without 0062's rules. They now take the same per-org lock (lock_people_tree), read
--    again under it and keep the people tree's rules: one team per head, a head's team moves with
--    them, a head with reports is never unplaced, never a cycle, a team is only joined while its
--    head is in the tree. For groups without a head (0050/0054 trees) nothing changes.

-- ---------------------------------------------------------------------------------------------
-- 1. Limits per kind

alter table public.org_creations add column kind text not null default 'forening';
-- Rows of companies that still exist. A deleted company's row stays 'forening' (rare: companies
-- are allow-listed and new); it only ever counts against its creator's lifetime cap.
update public.org_creations c set kind = o.kind from public.orgs o where o.id = c.org_id and o.kind <> 'forening';
create index org_creations_user_kind_idx on public.org_creations (user_id, kind);

create or replace function public.orgs_limit_per_creator()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.created_by is null or new.kind = 'privat' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('orgs_limit:' || new.created_by::text));
  -- Föreningar only: companies are gated by the allow-list (service role), never counted here.
  if new.kind = 'forening' and coalesce(auth.role(), '') <> 'service_role' then
    if (select count(*) from public.orgs o where o.created_by = new.created_by and o.kind = 'forening') >= 10 then
      raise exception 'org limit reached: max 10 orgs per user' using errcode = 'P0001';
    end if;
    if (select count(*) from public.org_creations c where c.user_id = new.created_by and c.kind = 'forening') >= 30 then
      raise exception 'org creation cap reached: max 30 orgs ever per user' using errcode = 'P0001';
    end if;
  end if;
  insert into public.org_creations (org_id, user_id, kind) values (new.id, new.created_by, new.kind);
  return new;
end;
$$;
revoke all on function public.orgs_limit_per_creator() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. The old tree RPCs under the people tree's lock and rules

-- Put a person in a group (null = out of the tree), keeping the people tree's rules. Internal:
-- callers are admins of the person's org and hold lock_people_tree. Returns 'ok', or why not:
-- 'invalid' (no such person / group), 'cycle' (the group is the person's own team or below it),
-- 'has_reports' (out of the tree while someone reports to them), 'not_placed' (the group is a
-- team whose head isn't in the tree).
create function public.people_tree_place(p_person_id uuid, p_group_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_person public.people;
  v_target public.groups;
  v_team uuid;
  v_walk uuid;
  v_steps integer := 0;
begin
  select * into v_person from public.people p where p.id = p_person_id;
  if v_person.id is null then
    return 'invalid';
  end if;
  if p_group_id is not null then
    select * into v_target from public.groups g where g.id = p_group_id and g.org_id = v_person.org_id and g.archived_at is null;
    if v_target.id is null then
      return 'invalid';
    end if;
  end if;
  if v_person.group_id is not distinct from p_group_id then
    return 'ok';
  end if;
  select g.id into v_team from public.groups g where g.head_person_id = p_person_id and g.archived_at is null;

  if p_group_id is null then
    if v_team is not null and exists (select 1 from public.people p where p.group_id = v_team) then
      return 'has_reports';
    end if;
  else
    -- A team is joined only while its head is in the tree (where its team hangs).
    if v_target.head_person_id is not null and not exists (
      select 1 from public.people h join public.groups hg on hg.id = h.group_id and hg.archived_at is null
      where h.id = v_target.head_person_id
    ) then
      return 'not_placed';
    end if;
    -- Never a cycle: not into their own team or anywhere below it.
    if v_team is not null then
      v_walk := p_group_id;
      while v_walk is not null and v_steps < 100 loop
        if v_walk = v_team then
          return 'cycle';
        end if;
        v_steps := v_steps + 1;
        select g.parent_group_id into v_walk from public.groups g where g.id = v_walk;
      end loop;
    end if;
  end if;

  update public.people set group_id = p_group_id where id = p_person_id;
  -- Their team moves with them (0062); out of the tree, their (empty) team is archived.
  if v_team is not null then
    if p_group_id is null then
      perform public.tidy_team(v_team);
    else
      update public.groups set parent_group_id = p_group_id where id = v_team;
    end if;
  end if;
  perform public.tidy_team(v_person.group_id);
  return 'ok';
end;
$$;
revoke all on function public.people_tree_place(uuid, uuid) from public, anon, authenticated;

-- 0054's set_group, under the lock. A team (a group with a head, 0062) hangs under the group its
-- head sits in: it is never moved anywhere else (renaming it is harmless: its name is internal).
create or replace function public.set_group(p_org_id uuid, p_id uuid, p_name text, p_parent uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_group public.groups;
  v_head_group uuid;
  v_walk uuid;
  v_steps integer := 0;
begin
  if not public.org_has_tree(p_org_id) or not public.is_org_admin(p_org_id) then
    return null;
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 40 then
    return null;
  end if;
  perform public.lock_people_tree(p_org_id);
  if p_parent is not null and not exists (
    select 1 from public.groups g where g.id = p_parent and g.org_id = p_org_id and g.archived_at is null
  ) then
    return null;
  end if;
  if p_id is null then
    insert into public.groups (org_id, name, parent_group_id, position)
    values (p_org_id, btrim(p_name), p_parent,
      coalesce((select max(g.position) + 1 from public.groups g where g.org_id = p_org_id and g.parent_group_id is not distinct from p_parent), 0))
    returning id into v_id;
    return v_id;
  end if;
  select * into v_group from public.groups g where g.id = p_id and g.org_id = p_org_id and g.archived_at is null;
  if v_group.id is null then
    return null;
  end if;
  if v_group.parent_group_id is distinct from p_parent then
    if v_group.head_person_id is not null then
      select p.group_id into v_head_group from public.people p where p.id = v_group.head_person_id;
      if v_head_group is distinct from p_parent then
        return null;
      end if;
    end if;
    -- Never under itself (groups_tree raises; refuse instead, as v1 expects).
    v_walk := p_parent;
    while v_walk is not null and v_steps < 100 loop
      if v_walk = p_id then
        return null;
      end if;
      v_steps := v_steps + 1;
      select g.parent_group_id into v_walk from public.groups g where g.id = v_walk;
    end loop;
  end if;
  update public.groups g set name = btrim(p_name), parent_group_id = p_parent
  where g.id = p_id
  returning g.id into v_id;
  return v_id;
end;
$$;

create or replace function public.set_person_group(p_person_id uuid, p_group_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.org_id into v_org from public.people p where p.id = p_person_id;
  if v_org is null or not public.org_has_tree(v_org) or not public.is_org_admin(v_org) then
    return false;
  end if;
  perform public.lock_people_tree(v_org);
  return public.people_tree_place(p_person_id, p_group_id) = 'ok';
end;
$$;

create or replace function public.place_member(p_org_id uuid, p_user_id uuid, p_group_id uuid, p_name text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_person uuid;
  v_name text := left(btrim(coalesce(p_name, '')), 100);
  v_head uuid;
begin
  if not public.org_has_tree(p_org_id) or not public.is_org_admin(p_org_id) then
    return null;
  end if;
  -- Re-entrant: set_account_manager (0062) calls this already holding the lock.
  perform public.lock_people_tree(p_org_id);
  if not exists (select 1 from public.org_members m where m.org_id = p_org_id and m.user_id = p_user_id) then
    return null;
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.groups g where g.id = p_group_id and g.org_id = p_org_id and g.archived_at is null
  ) then
    return null;
  end if;
  select p.id into v_person from public.people p where p.org_id = p_org_id and p.member_user_id = p_user_id limit 1;
  if v_person is not null then
    if public.people_tree_place(v_person, p_group_id) <> 'ok' then
      return null;
    end if;
    return v_person;
  end if;
  if length(v_name) < 1 then
    return null;
  end if;
  -- A new row leads nobody, so only the target team's head must be in the tree.
  if p_group_id is not null then
    select g.head_person_id into v_head from public.groups g where g.id = p_group_id;
    if v_head is not null and not exists (
      select 1 from public.people h join public.groups hg on hg.id = h.group_id and hg.archived_at is null
      where h.id = v_head
    ) then
      return null;
    end if;
  end if;
  -- A name already in the list (0016: unique per org) gets a number.
  if exists (select 1 from public.people p where p.org_id = p_org_id and lower(btrim(p.name)) = lower(v_name)) then
    v_name := left(v_name, 90) || ' (' || (select count(*) + 1 from public.people p where p.org_id = p_org_id) || ')';
  end if;
  insert into public.people (org_id, name, member_user_id, group_id)
  values (p_org_id, v_name, p_user_id, p_group_id)
  returning id into v_person;
  return v_person;
end;
$$;

-- 0054's archive_group, under the lock, plus: never while someone in the group leads an active
-- team (they would be unplaced with reports). Their team is a child group, so 0054's "no child
-- groups" already says so; checked again explicitly under the lock.
create or replace function public.archive_group(p_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
begin
  select g.org_id into v_org from public.groups g where g.id = p_id and g.archived_at is null;
  if v_org is null or not public.is_org_admin(v_org) then
    return false;
  end if;
  perform public.lock_people_tree(v_org);
  -- Read again under the lock: a concurrent edit has committed by now.
  if not exists (select 1 from public.groups g where g.id = p_id and g.archived_at is null) then
    return false;
  end if;
  if exists (select 1 from public.groups c where c.parent_group_id = p_id and c.archived_at is null)
    or exists (select 1 from public.meetings mt where mt.group_id = p_id and mt.status in ('live', 'ending')) then
    return false;
  end if;
  if exists (
    select 1 from public.people p join public.groups t on t.head_person_id = p.id and t.archived_at is null
    where p.group_id = p_id
  ) then
    return false;
  end if;
  if exists (select 1 from public.orgs o where o.id = v_org and o.kind = 'forening' and o.groups_enabled)
    and not exists (select 1 from public.groups g where g.org_id = v_org and g.archived_at is null and g.id <> p_id) then
    return false;
  end if;
  update public.people p set group_id = null where p.group_id = p_id;
  update public.groups g set archived_at = now() where g.id = p_id;
  return true;
end;
$$;

-- Grants as before (create or replace keeps them; restated so this file reads on its own).
revoke all on function public.set_group(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.set_group(uuid, uuid, text, uuid) to authenticated;
revoke all on function public.set_person_group(uuid, uuid) from public, anon;
grant execute on function public.set_person_group(uuid, uuid) to authenticated;
revoke all on function public.place_member(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.place_member(uuid, uuid, uuid, text) to authenticated;
revoke all on function public.archive_group(uuid) from public, anon;
grant execute on function public.archive_group(uuid) to authenticated;
