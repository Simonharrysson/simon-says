-- Goals keep their identity across edits (todo #12, "Mål att ta upp"). set_org_goals (0028)
-- replaced the whole set with new rows, so every save gave each goal a new id and approved_at =
-- now(): a goal untouched for months looked freshly set, and an id the start screen offered could
-- vanish under it. Now a goal saved again with the same title (trimmed, spaces collapsed, case
-- ignored) keeps its row id, its first approval time and who approved it first; only new or
-- renamed goals get new rows.
--
-- Backward compatible: same signature, arguments, checks, return value and grants (create or
-- replace keeps them); no table changes. Code that ignores ids and approved_at sees no difference.

create or replace function public.set_org_goals(p_org_id uuid, p_goals jsonb)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_goal jsonb;
  v_title text;
  v_why text;
  v_pos smallint := 0;
  v_prev jsonb;
  v_id uuid;
  v_at timestamptz;
  v_by uuid;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can set goals' using errcode = '42501';
  end if;
  if p_goals is null or jsonb_typeof(p_goals) <> 'array' or jsonb_array_length(p_goals) > 5 then
    raise exception 'goals must be an array of at most 5' using errcode = '22023';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  -- The current set, to keep each goal that is saved again under the same title.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id,
           'key', lower(regexp_replace(btrim(g.title), '\s+', ' ', 'g')),
           'at', g.approved_at,
           'by', g.approved_by) order by g.position), '[]'::jsonb)
    into v_prev
    from public.org_goals g where g.org_id = p_org_id;
  delete from public.org_goals where org_id = p_org_id;
  for v_goal in select value from jsonb_array_elements(p_goals) loop
    if jsonb_typeof(v_goal) <> 'object' or jsonb_typeof(v_goal -> 'title') is distinct from 'string' then
      raise exception 'each goal needs a title' using errcode = '22023';
    end if;
    v_title := btrim(v_goal ->> 'title');
    v_why := nullif(btrim(coalesce(v_goal ->> 'why', '')), '');
    v_id := null;
    v_at := null;
    v_by := null;
    select (e ->> 'id')::uuid, (e ->> 'at')::timestamptz, (e ->> 'by')::uuid
      into v_id, v_at, v_by
      from jsonb_array_elements(v_prev) e
      where e ->> 'key' = lower(regexp_replace(v_title, '\s+', ' ', 'g'))
      limit 1;
    if v_id is not null then
      -- Each old row is reused once (two goals with the same title: the second is new).
      select coalesce(jsonb_agg(e), '[]'::jsonb) into v_prev
        from jsonb_array_elements(v_prev) e where e ->> 'id' <> v_id::text;
    end if;
    insert into public.org_goals (id, org_id, position, title, why, approved_by, approved_at)
    values (coalesce(v_id, gen_random_uuid()), p_org_id, v_pos, v_title, v_why, coalesce(v_by, auth.uid()), coalesce(v_at, now()));
    v_pos := v_pos + 1;
  end loop;
  return v_pos;
end;
$$;
