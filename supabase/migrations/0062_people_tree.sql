-- 0062: the tree, people first (Simon 2026-11-27, binding): the editor shows PEOPLE and who reports
-- to whom, never group names. The data model and the visibility rule (0050, 0054) are unchanged:
--
-- * Every person who has reports leads a team: an internal group whose head_person_id is them,
--   named internally ("team <id>"), never shown (the app says "Simons team"). Their reports sit in
--   it (people.group_id). The leader sits in their own manager's team, so the team's group hangs
--   under the group the leader is in: a head sits at the parent node's level (0050), exactly.
-- * A person without a manager sits in the top group (no head, no parent): the top of the tree.
-- * A person with no place (group_id null) is outside the tree, as before: sees only what they
--   started or attended.
-- * "Rapporterar till" is set_manager(): one manager per person (one group_id), never a cycle
--   (checked under a per-org lock, and the groups_tree trigger refuses one anyway), admins only, any
--   org with the tree. Only someone already in the tree can be a manager (never auto-placed). Every
--   tree write of this migration takes the same per-org transaction lock, so concurrent admin edits
--   run one after the other and each sees the other's result.
-- * One team per head (the backfill picks one; the functions keep it so). A head's team always
--   moves with them, so a head always sits one level above their team and sees its meetings.
--
-- Also: where each person's card sits on the canvas (people.canvas_x / canvas_y; null = laid out by
-- the app). Visual only. Written only through set_people_canvas (admins), like every tree write.

alter table public.groups add column head_person_id uuid references public.people (id) on delete set null;
create index groups_head_idx on public.groups (head_person_id) where head_person_id is not null;

alter table public.people
  add column canvas_x double precision,
  add column canvas_y double precision;
-- No client grant on the new columns (0025: clients update only name and member_user_id).

-- Existing trees (0050/0054 were built group-first): a group that isn't the top gets a head, the
-- first person (by name) in the group above it, which is where 0050 put heads. One team per head:
-- when that person would head several sibling groups, only the oldest gets them (deterministic);
-- the others stay headless (their people show at the top of the editor until an admin draws their
-- manager, and see exactly what they saw before).
with candidate as (
  select g.id as group_id, g.created_at,
    (select p.id from public.people p where p.group_id = g.parent_group_id order by lower(p.name), p.id limit 1) as person_id
  from public.groups g
  where g.parent_group_id is not null and g.archived_at is null and g.head_person_id is null
), pick as (
  select distinct on (c.person_id) c.group_id, c.person_id
  from candidate c
  where c.person_id is not null
  order by c.person_id, c.created_at, c.group_id
)
update public.groups g set head_person_id = pick.person_id from pick where g.id = pick.group_id;

-- One active team per head, from here on.
create unique index groups_one_team_per_head on public.groups (head_person_id) where head_person_id is not null and archived_at is null;

-- Every people-tree write takes this lock first (per org, until the transaction ends).
create function public.lock_people_tree(p_org_id uuid)
returns void
language sql volatile security definer set search_path = ''
as $$ select pg_advisory_xact_lock(hashtextextended('people_tree:' || p_org_id::text, 0)) $$;
revoke all on function public.lock_people_tree(uuid) from public, anon, authenticated;

-- The top group of an org with the tree: the oldest active group with no parent and no head;
-- created when missing. Internal (security definer callers only, under the lock).
create function public.org_top_group(p_org_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  select g.id into v_id from public.groups g
  where g.org_id = p_org_id and g.archived_at is null and g.parent_group_id is null and g.head_person_id is null
  order by g.created_at, g.id limit 1;
  if v_id is null then
    insert into public.groups (org_id, name) values (p_org_id, 'top ' || left(replace(gen_random_uuid()::text, '-', ''), 8))
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.org_top_group(uuid) from public, anon, authenticated;

-- A person's team (their reports' group), made under the group they sit in when missing. Null when
-- the person is not in the tree: someone outside it is never made a manager (nor placed by this).
-- Internal (under the lock).
create function public.person_team(p_person_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_person public.people;
  v_id uuid;
begin
  select * into v_person from public.people p where p.id = p_person_id;
  if v_person.group_id is null or not exists (
    select 1 from public.groups g where g.id = v_person.group_id and g.archived_at is null
  ) then
    return null;
  end if;
  select g.id into v_id from public.groups g where g.head_person_id = p_person_id and g.archived_at is null;
  if v_id is null then
    insert into public.groups (org_id, name, parent_group_id, head_person_id)
    values (v_person.org_id, 'team ' || left(replace(p_person_id::text, '-', ''), 12), v_person.group_id, p_person_id)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.person_team(uuid) from public, anon, authenticated;

-- A team nobody is in any more (and with no team under it, no live meeting) is archived: never
-- deleted, its meetings keep pointing at it.
create function public.tidy_team(p_group_id uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_group_id is null then
    return;
  end if;
  update public.groups g set archived_at = now()
  where g.id = p_group_id and g.archived_at is null and g.head_person_id is not null
    and not exists (select 1 from public.people p where p.group_id = g.id)
    and not exists (select 1 from public.groups c where c.parent_group_id = g.id and c.archived_at is null)
    and not exists (select 1 from public.meetings mt where mt.group_id = g.id and mt.status in ('live', 'ending'));
end;
$$;
revoke all on function public.tidy_team(uuid) from public, anon, authenticated;

-- "Rapporterar till". p_mode: 'manager' (p_manager_id required), 'top' (no manager: the top of the
-- tree) or 'none' (out of the tree). Admins only. Returns 'ok', or why not: 'forbidden', 'invalid',
-- 'not_placed' (the manager isn't in the tree), 'cycle' (the manager is below the person),
-- 'has_reports' (out of the tree while someone reports to you).
create function public.set_manager(p_person_id uuid, p_mode text, p_manager_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_person public.people;
  v_manager public.people;
  v_target uuid;
  v_old uuid;
  v_team uuid;
  v_walk uuid;
  v_steps integer := 0;
begin
  select p.org_id into v_org from public.people p where p.id = p_person_id;
  if v_org is null or not public.org_has_tree(v_org) or not public.is_org_admin(v_org) then
    return 'forbidden';
  end if;
  perform public.lock_people_tree(v_org);
  -- Read everything again under the lock: a concurrent edit has committed by now.
  select * into v_person from public.people p where p.id = p_person_id;
  v_old := v_person.group_id;
  select g.id into v_team from public.groups g where g.head_person_id = p_person_id and g.archived_at is null;

  if p_mode = 'manager' then
    select * into v_manager from public.people p where p.id = p_manager_id;
    if v_manager.id is null or v_manager.org_id <> v_org or v_manager.id = v_person.id then
      return 'invalid';
    end if;
    if v_manager.group_id is null or not exists (
      select 1 from public.groups g where g.id = v_manager.group_id and g.archived_at is null
    ) then
      return 'not_placed';
    end if;
    -- Never a cycle: the manager must not sit in the person's team or anywhere below it.
    if v_team is not null then
      v_walk := v_manager.group_id;
      while v_walk is not null and v_steps < 100 loop
        if v_walk = v_team then
          return 'cycle';
        end if;
        v_steps := v_steps + 1;
        select g.parent_group_id into v_walk from public.groups g where g.id = v_walk;
      end loop;
    end if;
    v_target := public.person_team(v_manager.id);
  elsif p_mode = 'top' then
    v_target := public.org_top_group(v_org);
  elsif p_mode = 'none' then
    if v_team is not null and exists (select 1 from public.people p where p.group_id = v_team) then
      return 'has_reports';
    end if;
    v_target := null;
  else
    return 'invalid';
  end if;

  if v_target is not distinct from v_old then
    return 'ok';
  end if;
  update public.people set group_id = v_target where id = p_person_id;
  -- Their team moves with them (it hangs under the group they sit in); out of the tree, their
  -- (empty) team is archived instead.
  if v_team is not null then
    if v_target is null then
      perform public.tidy_team(v_team);
    else
      update public.groups set parent_group_id = v_target where id = v_team;
    end if;
  end if;
  perform public.tidy_team(v_old);
  return 'ok';
end;
$$;
revoke all on function public.set_manager(uuid, text, uuid) from public, anon;
grant execute on function public.set_manager(uuid, text, uuid) to authenticated;

-- "Rapporterar till" for a member account without a person row (the "Utan plats" list): its row
-- (made unplaced, named p_name, through place_member) and the line, in one transaction. Nothing is
-- left behind when the line is refused. Same answers as set_manager.
create function public.set_account_manager(p_org_id uuid, p_user_id uuid, p_name text, p_mode text, p_manager_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_person uuid;
  v_existed boolean;
  v_result text;
begin
  if not public.org_has_tree(p_org_id) or not public.is_org_admin(p_org_id) then
    return 'forbidden';
  end if;
  perform public.lock_people_tree(p_org_id);
  select p.id into v_person from public.people p where p.org_id = p_org_id and p.member_user_id = p_user_id limit 1;
  v_existed := v_person is not null;
  if not v_existed then
    v_person := public.place_member(p_org_id, p_user_id, null, p_name);
    if v_person is null then
      return 'invalid';
    end if;
  end if;
  v_result := public.set_manager(v_person, p_mode, p_manager_id);
  if v_result <> 'ok' and not v_existed then
    delete from public.people where id = v_person;
  end if;
  return v_result;
end;
$$;
revoke all on function public.set_account_manager(uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.set_account_manager(uuid, uuid, text, text, uuid) to authenticated;

-- Save card positions for any number of people in one call. p_positions: [{"id": uuid, "x": n, "y": n}].
-- Admins of an org with the tree only. Returns how many rows changed, or null when refused.
-- Positions outside ±1e6 or not numbers are refused whole (never a half-saved layout).
create function public.set_people_canvas(p_org_id uuid, p_positions jsonb)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_item jsonb;
  v_count integer := 0;
  v_rows integer;
begin
  if not public.org_has_tree(p_org_id) or not public.is_org_admin(p_org_id) then
    return null;
  end if;
  perform public.lock_people_tree(p_org_id);
  if jsonb_typeof(p_positions) <> 'array' or jsonb_array_length(p_positions) > 1000 then
    return null;
  end if;
  for v_item in select * from jsonb_array_elements(p_positions) loop
    if jsonb_typeof(v_item -> 'x') is distinct from 'number' or jsonb_typeof(v_item -> 'y') is distinct from 'number'
      or coalesce(v_item ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'people: bad canvas position' using errcode = '22023';
    end if;
    if abs((v_item ->> 'x')::double precision) > 1e6 or abs((v_item ->> 'y')::double precision) > 1e6 then
      raise exception 'people: bad canvas position' using errcode = '22023';
    end if;
  end loop;
  for v_item in select * from jsonb_array_elements(p_positions) loop
    update public.people p
    set canvas_x = round((v_item ->> 'x')::numeric, 1), canvas_y = round((v_item ->> 'y')::numeric, 1)
    where p.id = (v_item ->> 'id')::uuid and p.org_id = p_org_id;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.set_people_canvas(uuid, jsonb) from public, anon;
grant execute on function public.set_people_canvas(uuid, jsonb) to authenticated;
