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
-- * "Rapporterar till" is set_manager(): one manager per person (one group_id), never a cycle (the
--   groups_tree trigger refuses it and the whole call rolls back), admins only, any org with the tree.
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
-- first person (by name) in the group above it, which is where 0050 put heads. A group whose parent
-- has nobody in it keeps no head (its people show at the top of the editor until an admin draws
-- their manager).
update public.groups g
set head_person_id = (
  select p.id from public.people p where p.group_id = g.parent_group_id order by lower(p.name), p.id limit 1
)
where g.parent_group_id is not null and g.archived_at is null and g.head_person_id is null;

-- The top group of an org with the tree: the oldest active group with no parent and no head;
-- created when missing. Internal (security definer callers only).
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

-- A person's team (their reports' group), created under the group they sit in when missing.
create function public.person_team(p_person_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_person public.people;
  v_id uuid;
begin
  select * into v_person from public.people p where p.id = p_person_id;
  select g.id into v_id from public.groups g
  where g.head_person_id = p_person_id and g.archived_at is null
  order by g.created_at, g.id limit 1;
  if v_id is null then
    -- A manager outside the tree goes to the top first (they lead a team: they are in the tree).
    if v_person.group_id is null or not exists (
      select 1 from public.groups g where g.id = v_person.group_id and g.archived_at is null
    ) then
      v_person.group_id := public.org_top_group(v_person.org_id);
      update public.people set group_id = v_person.group_id where id = p_person_id;
    end if;
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
-- tree) or 'none' (out of the tree; refused while the person has reports). Admins only. True when
-- done, false when refused; a cycle or a too-deep tree raises 22023 from the trigger (nothing changes).
create function public.set_manager(p_person_id uuid, p_mode text, p_manager_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_person public.people;
  v_manager public.people;
  v_target uuid;
  v_old uuid;
  v_team uuid;
begin
  select * into v_person from public.people p where p.id = p_person_id;
  if v_person.id is null or not public.org_has_tree(v_person.org_id) or not public.is_org_admin(v_person.org_id) then
    return false;
  end if;
  v_old := v_person.group_id;
  select g.id into v_team from public.groups g where g.head_person_id = p_person_id and g.archived_at is null order by g.created_at, g.id limit 1;

  if p_mode = 'manager' then
    select * into v_manager from public.people p where p.id = p_manager_id;
    if v_manager.id is null or v_manager.org_id <> v_person.org_id or v_manager.id = v_person.id then
      return false;
    end if;
    v_target := public.person_team(v_manager.id);
  elsif p_mode = 'top' then
    v_target := public.org_top_group(v_person.org_id);
  elsif p_mode = 'none' then
    if v_team is not null and exists (select 1 from public.people p where p.group_id = v_team) then
      return false;
    end if;
    v_target := null;
  else
    return false;
  end if;

  if v_target is not distinct from v_old then
    return true;
  end if;
  update public.people set group_id = v_target where id = p_person_id;
  -- Their own team moves with them (it hangs under the group they sit in). Out of the tree: their
  -- (empty) team is archived instead.
  if v_team is not null then
    if v_target is null then
      perform public.tidy_team(v_team);
    else
      update public.groups set parent_group_id = v_target where id = v_team;
    end if;
  end if;
  perform public.tidy_team(v_old);
  return true;
end;
$$;
revoke all on function public.set_manager(uuid, text, uuid) from public, anon;
grant execute on function public.set_manager(uuid, text, uuid) to authenticated;

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
