-- 0055: the tree as a canvas (Personer & grupper on a desktop; a förening's Grupper, 0054).
--
-- Two things the canvas shows that the list did not:
-- * where each group's card sits (canvas_x, canvas_y; null = not placed by hand yet, the app lays
--   it out). Purely visual: it never changes who sees what.
-- * the group's head (chef), head_person_id: display only. Visibility still follows the tree alone
--   (0050: "a head sits at the parent node's level", so a head is placed in the parent group and
--   sees this group's meetings by the rule, not by this column).
--
-- groups keeps 0050's grants (clients select through groups_select, never write): both are written
-- only through admin functions here, like set_group / archive_group.

alter table public.groups
  add column canvas_x double precision,
  add column canvas_y double precision,
  add column head_person_id uuid references public.people (id) on delete set null;

-- Save card positions for any number of groups in one call. p_positions: [{"id": uuid, "x": n, "y": n}].
-- Admins of an org with the tree only. Returns how many rows changed, or null when refused.
-- Positions outside ±1e6 or not numbers are refused whole (never a half-saved layout).
create function public.set_group_canvas(p_org_id uuid, p_positions jsonb)
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
  if jsonb_typeof(p_positions) <> 'array' or jsonb_array_length(p_positions) > 500 then
    return null;
  end if;
  for v_item in select * from jsonb_array_elements(p_positions) loop
    if jsonb_typeof(v_item -> 'x') is distinct from 'number' or jsonb_typeof(v_item -> 'y') is distinct from 'number'
      or coalesce(v_item ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'groups: bad canvas position' using errcode = '22023';
    end if;
    if abs((v_item ->> 'x')::double precision) > 1e6 or abs((v_item ->> 'y')::double precision) > 1e6 then
      raise exception 'groups: bad canvas position' using errcode = '22023';
    end if;
  end loop;
  for v_item in select * from jsonb_array_elements(p_positions) loop
    update public.groups g
    set canvas_x = round((v_item ->> 'x')::numeric, 1), canvas_y = round((v_item ->> 'y')::numeric, 1)
    where g.id = (v_item ->> 'id')::uuid and g.org_id = p_org_id and g.archived_at is null;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.set_group_canvas(uuid, jsonb) from public, anon;
grant execute on function public.set_group_canvas(uuid, jsonb) to authenticated;

-- Set (or clear, p_person_id null) a group's head. Admins only; the person is in the same org.
create function public.set_group_head(p_group_id uuid, p_person_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
begin
  select g.org_id into v_org from public.groups g where g.id = p_group_id and g.archived_at is null;
  if v_org is null or not public.org_has_tree(v_org) or not public.is_org_admin(v_org) then
    return false;
  end if;
  if p_person_id is not null and not exists (
    select 1 from public.people p where p.id = p_person_id and p.org_id = v_org
  ) then
    return false;
  end if;
  update public.groups set head_person_id = p_person_id where id = p_group_id;
  return true;
end;
$$;
revoke all on function public.set_group_head(uuid, uuid) from public, anon;
grant execute on function public.set_group_head(uuid, uuid) to authenticated;
