-- "Vem av dessa är du?" (UX walkthrough 2026-11-27, 3): right after joining a förening, a member
-- links their own account to their name in the people list, or adds themselves. Tasks, speaker
-- names and summary mails follow people.member_user_id, which until now only an admin could set
-- (through the e-mail on a person).
--
-- * claim_person(): a member links THEMSELVES to a person nobody is linked to, in a förening they
--   are a member of, when no other person there is linked to them yet;
-- * add_self_person(): the same, for "Jag finns inte med": adds the person (name + optional role)
--   already linked to the caller. A name already on the list is claimed if free, else 'taken';
-- * people_guard_link: through the table, only an admin of the förening may set or change
--   people.member_user_id. Until now any member could (0002 policy + 0025 column grant), also on
--   a person linked to someone else. The definer functions (above, set_person_email,
--   add_board_person, the join trigger, leave/remove) run as their owner and are not affected.
--
-- Backward compatible: the deployed code never writes member_user_id through the table as a
-- member (only the admin-side functions and the service role do). No unique index on
-- (org_id, member_user_id): the functions check it instead, so the migration can't fail on data.

create function public.people_guard_link()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.member_user_id is not null and not public.is_org_admin(new.org_id) then
        raise exception 'only an admin links a person to an account' using errcode = '42501';
      end if;
    elsif new.member_user_id is distinct from old.member_user_id and not public.is_org_admin(old.org_id) then
      raise exception 'only an admin links a person to an account' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.people_guard_link() from public, anon, authenticated;

create trigger people_guard_link
  before insert or update on public.people
  for each row execute function public.people_guard_link();

-- Links the caller to an unlinked person of a förening they belong to.
-- Returns ok | taken (someone else has that person) | already (you are linked to another person
-- there) | forbidden (not signed in, not a member, no such person, or not a förening).
create function public.claim_person(p_person_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_org uuid;
  v_member uuid;
begin
  if v_user is null then
    return 'forbidden';
  end if;
  select p.org_id into v_org from public.people p
  join public.orgs o on o.id = p.org_id and o.kind <> 'privat'
  where p.id = p_person_id;
  if v_org is null or not public.is_org_member(v_org) then
    return 'forbidden';
  end if;
  -- One link per member per förening, also when two claims race.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || v_user::text, 0));
  select p.member_user_id into v_member from public.people p where p.id = p_person_id for update;
  if v_member = v_user then
    return 'ok';
  end if;
  if v_member is not null then
    return 'taken';
  end if;
  if exists (select 1 from public.people q where q.org_id = v_org and q.member_user_id = v_user) then
    return 'already';
  end if;
  update public.people set member_user_id = v_user where id = p_person_id and member_user_id is null;
  return 'ok';
end;
$$;
revoke all on function public.claim_person(uuid) from public, anon, authenticated;
grant execute on function public.claim_person(uuid) to authenticated;

-- "Jag finns inte med": adds the caller to the förening's people list, linked to them.
-- Returns jsonb {"result": "ok", "id"} | {"result": "taken" | "already" | "invalid" | "forbidden"}.
-- Name and role are validated by the caller too (lib/names/validate.ts, lib/people/roles.ts).
create function public.add_self_person(p_org_id uuid, p_name text, p_role text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_role text := nullif(btrim(coalesce(p_role, '')), '');
  v_id uuid;
  v_member uuid;
  v_claim text;
begin
  if v_user is null or not public.is_org_member(p_org_id)
    or not exists (select 1 from public.orgs o where o.id = p_org_id and o.kind <> 'privat') then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if length(v_name) not between 1 and 100 or (v_role is not null and length(v_role) not between 1 and 40) then
    return jsonb_build_object('result', 'invalid');
  end if;
  -- The name is already on the list: claim it when free (it is them), else someone has it.
  select p.id, p.member_user_id into v_id, v_member from public.people p
  where p.org_id = p_org_id and lower(btrim(p.name)) = lower(v_name);
  if v_id is not null then
    v_claim := public.claim_person(v_id);
    if v_claim = 'ok' and v_role is not null then
      update public.people set role = v_role where id = v_id and role is null;
    end if;
    return jsonb_build_object('result', v_claim, 'id', v_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || v_user::text, 0));
  if exists (select 1 from public.people q where q.org_id = p_org_id and q.member_user_id = v_user) then
    return jsonb_build_object('result', 'already');
  end if;
  insert into public.people (org_id, name, role, member_user_id)
  values (p_org_id, v_name, v_role, v_user)
  returning id into v_id;
  return jsonb_build_object('result', 'ok', 'id', v_id);
exception when unique_violation then
  -- The same name was added a moment ago.
  return jsonb_build_object('result', 'taken');
end;
$$;
revoke all on function public.add_self_person(uuid, text, text) from public, anon, authenticated;
grant execute on function public.add_self_person(uuid, text, text) to authenticated;
