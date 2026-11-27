-- 0054: the Företag tree (0050, docs/superpowers/specs/2026-11-27-foretag-v1-design.md) for föreningar, opt-in.
--
-- A förening may organise its people in the same tree as a Företag (0050), with the SAME rule:
-- you see the meetings of your own group plus every meeting of any group deeper than your level;
-- admins see everything; no cousins; the starter and attendees always see it; a Privat möte is
-- attendees + admins; an unplaced account sees only what it started or attended. A task whose
-- owner can't see its meeting waits for approval (task_handoffs), exactly as in a Företag.
--
-- Opt-in, default off: orgs.groups_enabled (false for every existing row). A förening with it off
-- answers exactly as before on every table: the visibility check keeps 0050's one-join fast path
-- (meeting → membership → org), now "not a Företag and no tree" instead of "not a Företag".
-- Only an admin turns it on or off (set_org_groups). Turning it on never narrows what a linked
-- person sees: the first group is created and every person an admin linked (not one a member
-- claimed themself, 0051) and unplaced is placed in it (the top, which sees everything). Members without a person row are unplaced from then on (the editor
-- says so first). Turning it off is an explicit admin choice that opens every group's meetings to
-- every member again (the UI asks to confirm), never a Privat möte (still starter + attendees +
-- admins); groups and placements are kept for a later turn-on.
--
-- Depends on 0051 (self link) and 0053 (Företag follow-up): its functions are redefined here with "Företag" widened to
-- "has the tree" (org_has_tree), bodies otherwise unchanged.
--
-- Also: in a förening, any member may edit the person list (0002); a member relinking a PLACED
-- person row to their own account would inherit its place in the tree. Placed rows are now written
-- by admins only (a Företag's people were admin-only already, 0050); a placed name is never
-- self-claimed (0051's claim_person), and unlinking clears the place.

alter table public.orgs add column groups_enabled boolean not null default false;
-- No client grant: only set_org_groups() writes it. Clients read it (orgs_select) like any column.

-- Does this org follow the tree? A Företag always; a förening once an admin turned groups on.
create function public.org_has_tree(p_org_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.orgs o where o.id = p_org_id and (o.kind = 'foretag' or o.groups_enabled)) $$;
revoke all on function public.org_has_tree(uuid) from public, anon;
grant execute on function public.org_has_tree(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The visibility predicate (0050), widened. Names kept: deployed code and RLS call them.

create or replace function public.foretag_can_see_parts(
  p_user uuid,
  p_org uuid,
  p_group uuid,
  p_private boolean,
  p_started_by uuid,
  p_attended boolean
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select (o.kind <> 'foretag' and not o.groups_enabled and not coalesce(p_private, false))
      or public.foretag_rule(p_user, p_org, p_group, p_private, p_started_by, p_attended, m.role = 'admin')
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    where m.org_id = p_org and m.user_id = p_user
  ), false);
$$;

-- One join for a meeting of an org without the tree (every förening by default, Privat); only an
-- org with the tree, or a Privat möte, runs the rule. A Privat möte stays starter + attendees +
-- admins even after a förening turns its groups off (coordinator, PR #45).
create or replace function public.foretag_can_see(p_user uuid, p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.meetings mt
    join public.org_members m on m.org_id = mt.org_id and m.user_id = p_user
    join public.orgs o on o.id = mt.org_id
    where mt.id = p_meeting_id
      and (
        (o.kind <> 'foretag' and not o.groups_enabled and not mt.private)
        or public.foretag_rule(
          p_user, mt.org_id, mt.group_id, mt.private, mt.started_by,
          exists (select 1 from public.meeting_attendees a where a.meeting_id = mt.id and a.user_id = p_user),
          m.role = 'admin'
        )
      )
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Turning groups on or off (förening admins only).

-- On: the flag, the first group (named p_root_name) when there is none, and every linked person
-- without a place put in the top group, so nobody linked sees less than before. Off: the flag only
-- (every member sees every meeting again; groups and places are kept). False when refused.
create function public.set_org_groups(p_org_id uuid, p_on boolean, p_root_name text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_root uuid;
  v_name text := left(btrim(coalesce(p_root_name, '')), 40);
begin
  if p_on is null or not public.is_org_admin(p_org_id) then
    return false;
  end if;
  perform 1 from public.orgs o where o.id = p_org_id and o.kind = 'forening' for update;
  if not found then
    return false;
  end if;
  if not p_on then
    update public.orgs set groups_enabled = false where id = p_org_id;
    return true;
  end if;
  select g.id into v_root from public.groups g
  where g.org_id = p_org_id and g.archived_at is null and g.parent_group_id is null
  order by g.position, g.created_at
  limit 1;
  if v_root is null then
    if length(v_name) < 1 or position(chr(10) in v_name) > 0 then
      return false;
    end if;
    insert into public.groups (org_id, name) values (p_org_id, v_name) returning id into v_root;
  end if;
  -- Only links an admin made (or an invited e-mail's): a name a member claimed themself (0051,
  -- self_linked_at) waits unplaced for an admin to confirm it.
  update public.people p set group_id = v_root
  where p.org_id = p_org_id and p.member_user_id is not null and p.self_linked_at is null
    and (p.group_id is null or exists (select 1 from public.groups g where g.id = p.group_id and g.archived_at is not null));
  update public.orgs set groups_enabled = true where id = p_org_id;
  return true;
end;
$$;
revoke all on function public.set_org_groups(uuid, boolean, text) from public, anon;
grant execute on function public.set_org_groups(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The admin functions (0050) for any org with the tree.

create or replace function public.set_group(p_org_id uuid, p_id uuid, p_name text, p_parent uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.org_has_tree(p_org_id) or not public.is_org_admin(p_org_id) then
    return null;
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 40 then
    return null;
  end if;
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
  else
    update public.groups g set name = btrim(p_name), parent_group_id = p_parent
    where g.id = p_id and g.org_id = p_org_id and g.archived_at is null
    returning g.id into v_id;
  end if;
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
  if p_group_id is not null and not exists (
    select 1 from public.groups g where g.id = p_group_id and g.org_id = v_org and g.archived_at is null
  ) then
    return false;
  end if;
  update public.people set group_id = p_group_id where id = p_person_id;
  return true;
end;
$$;

create or replace function public.place_member(p_org_id uuid, p_user_id uuid, p_group_id uuid, p_name text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_person uuid;
  v_name text := left(btrim(coalesce(p_name, '')), 100);
begin
  if not public.org_has_tree(p_org_id) or not public.is_org_admin(p_org_id) then
    return null;
  end if;
  if not exists (select 1 from public.org_members m where m.org_id = p_org_id and m.user_id = p_user_id) then
    return null;
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.groups g where g.id = p_group_id and g.org_id = p_org_id and g.archived_at is null
  ) then
    return null;
  end if;
  select p.id into v_person from public.people p where p.org_id = p_org_id and p.member_user_id = p_user_id limit 1;
  if v_person is null then
    if length(v_name) < 1 then
      return null;
    end if;
    -- A name already in the list (0016: unique per org) gets a number.
    if exists (select 1 from public.people p where p.org_id = p_org_id and lower(btrim(p.name)) = lower(v_name)) then
      v_name := left(v_name, 90) || ' (' || (select count(*) + 1 from public.people p where p.org_id = p_org_id) || ')';
    end if;
    insert into public.people (org_id, name, member_user_id, group_id)
    values (p_org_id, v_name, p_user_id, p_group_id)
    returning id into v_person;
  else
    update public.people set group_id = p_group_id where id = v_person;
  end if;
  return v_person;
end;
$$;

-- archive_group (0050), plus: a förening with groups on keeps at least one group (archiving the
-- last one would leave every member unplaced, seeing nothing; turning groups off is the way out).
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
  if exists (select 1 from public.groups c where c.parent_group_id = p_id and c.archived_at is null)
    or exists (select 1 from public.meetings mt where mt.group_id = p_id and mt.status in ('live', 'ending')) then
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

-- ---------------------------------------------------------------------------------------------
-- people: a placed row (group_id set) is written by admins only, in any org. An unplaced row keeps
-- 0002's "any member" (a förening's list stays editable by its members; linking yourself to an
-- unplaced row gives no place). A Företag stays admin-only throughout (0050).

drop policy people_update on public.people;
create policy people_update on public.people for update to authenticated
  using (
    public.is_org_member(org_id)
    and (not public.org_is_foretag(org_id) or public.is_org_admin(org_id))
    and (group_id is null or public.is_org_admin(org_id))
  )
  with check (
    public.is_org_member(org_id)
    and (not public.org_is_foretag(org_id) or public.is_org_admin(org_id))
    and (group_id is null or public.is_org_admin(org_id))
    and (member_user_id is null or exists (
      select 1 from public.org_members m where m.org_id = people.org_id and m.user_id = people.member_user_id
    ))
  );
drop policy people_delete on public.people;
create policy people_delete on public.people for delete to authenticated
  using (
    public.is_org_member(org_id)
    and (not public.org_is_foretag(org_id) or public.is_org_admin(org_id))
    and (group_id is null or public.is_org_admin(org_id))
  );

-- Linking through the table is admin-only since 0051 (people_guard_link). The self-link functions
-- (0051, security definer) and every unlink are made safe for the tree here:
-- * claim_person() never links a person who has a place (group_id): 'ask_admin', an admin links
--   them (else a member could claim a placed name and inherit its place);
-- * removing a person's link clears their place (leaving, an admin's new e-mail, an unlink): the
--   next account to claim the name starts unplaced. Linking (an invitee joining through
--   link_person_by_email, an admin's link) keeps the place an admin gave the name.
create function public.people_unplace_on_relink()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.member_user_id is not null and new.member_user_id is null and old.group_id is not null
    and new.group_id is not distinct from old.group_id then
    new.group_id := null;
  end if;
  return new;
end;
$$;
revoke all on function public.people_unplace_on_relink() from public, anon, authenticated;

create trigger people_unplace_on_relink
  before update of member_user_id on public.people
  for each row execute function public.people_unplace_on_relink();

-- 0051's claim_person, plus: a person with a place is never claimed ('ask_admin').
create or replace function public.claim_person(p_person_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_org uuid;
  v_member uuid;
  v_email text;
  v_group uuid;
begin
  if v_user is null then
    return 'forbidden';
  end if;
  select p.org_id, lower(btrim(p.email)) into v_org, v_email from public.people p
  join public.orgs o on o.id = p.org_id and o.kind = 'forening'
  where p.id = p_person_id;
  if v_org is null or not public.is_org_member(v_org) then
    return 'forbidden';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || v_user::text, 0));
  select p.member_user_id, p.group_id into v_member, v_group from public.people p where p.id = p_person_id for update;
  if v_member = v_user then
    return 'ok';
  end if;
  if v_member is not null then
    return 'taken';
  end if;
  if v_group is not null then
    return 'ask_admin';
  end if;
  if v_email is not null and v_email is distinct from
    (select lower(btrim(u.email::text)) from auth.users u where u.id = v_user and u.email_confirmed_at is not null) then
    return 'taken';
  end if;
  if exists (select 1 from public.people q where q.org_id = v_org and q.member_user_id = v_user) then
    return 'already';
  end if;
  update public.people set member_user_id = v_user, self_linked_at = now() where id = p_person_id and member_user_id is null and group_id is null;
  return 'ok';
end;
$$;
revoke all on function public.claim_person(uuid) from public, anon, authenticated;
grant execute on function public.claim_person(uuid) to authenticated;
-- add_self_person (0051) claims an existing name through claim_person (so 'ask_admin' too) and
-- otherwise adds a new, unplaced person: unchanged.

-- The meetings among p_ids this account can see (service role: the join's Doc sharing shares
-- only these, so never a Privat möte or a group's meeting outside the member's place).
create function public.visible_meeting_ids(p_user uuid, p_ids uuid[])
returns setof uuid
language sql stable security definer set search_path = ''
as $$ select i from unnest(coalesce(p_ids, '{}')) as i where public.foretag_can_see(p_user, i) $$;
revoke all on function public.visible_meeting_ids(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.visible_meeting_ids(uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Handoffs (0053's body) for any org with the tree. `p_owners` may carry each task's `text` as the
-- server cleaned it (a förening's human-edited line without "(vem?)" placeholders); otherwise
-- the row's own text.

create or replace function public.create_task_handoffs(p_meeting_id uuid, p_owners jsonb)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_n int;
begin
  delete from public.task_handoffs h
  using public.people p
  where h.meeting_id = p_meeting_id and h.status = 'pending' and p.id = h.owner_person_id
    and p.member_user_id is not null and public.foretag_can_see(p.member_user_id, p_meeting_id);

  insert into public.task_handoffs (org_id, meeting_id, item_id, owner_person_id, text, due, due_date, from_user_id, from_name)
  select mt.org_id, mt.id, n.id, p.id,
    left(btrim(coalesce(nullif(btrim(w.text), ''), n.text)), 500), left(n.due, 100), n.due_date, mt.started_by,
    (select s.name from public.people s where s.org_id = mt.org_id and s.member_user_id = mt.started_by limit 1)
  from public.meetings mt
  join public.orgs o on o.id = mt.org_id and (o.kind = 'foretag' or o.groups_enabled)
  join jsonb_to_recordset(coalesce(p_owners, '[]'::jsonb)) as w(item_id text, person_id uuid, text text) on true
  join public.note_items n on n.meeting_id = mt.id and n.id = w.item_id
  join public.people p on p.id = w.person_id and p.org_id = mt.org_id and p.member_user_id is not null
  where mt.id = p_meeting_id and mt.status = 'done'
    and n.section = 'action' and not n.deleted_by_human and not coalesce(n.done, false)
    and length(btrim(coalesce(nullif(btrim(w.text), ''), n.text))) between 1 and 500
    and not public.foretag_can_see(p.member_user_id, mt.id)
  on conflict (meeting_id, item_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.create_task_handoffs(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_task_handoffs(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Reconcile queues (0053) for any org with the tree.

create or replace function public.queue_foretag_reconcile(p_org uuid)
returns void
language sql volatile security definer set search_path = ''
as $$
  insert into public.foretag_reconcile_queue (org_id)
  select o.id from public.orgs o where o.id = p_org and (o.kind = 'foretag' or o.groups_enabled)
  on conflict (org_id) do nothing;
$$;

create or replace function public.users_email_queue_reconcile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    insert into public.foretag_reconcile_queue (org_id)
    select o.id from public.org_members m join public.orgs o on o.id = m.org_id and (o.kind = 'foretag' or o.groups_enabled)
    where m.user_id = new.id
    on conflict (org_id) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.doc_share_queue_revocation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.permission_id is not null and not exists (select 1 from auth.users u where u.id = old.user_id) then
    insert into public.doc_share_revocations (doc_id, owner_user_id, permission_id)
    select mt.doc_id, mt.started_by, old.permission_id
    from public.meetings mt
    join public.orgs o on o.id = mt.org_id and (o.kind = 'foretag' or o.groups_enabled)
    where mt.id = old.meeting_id and mt.doc_id is not null and mt.started_by is not null and mt.started_by <> old.user_id;
  end if;
  return old;
end;
$$;

-- Turning groups on or off changes who sees what: queue the reconcile (Doc shares, held tasks).
create function public.orgs_groups_queue_reconcile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.foretag_reconcile_queue (org_id) values (new.id) on conflict (org_id) do nothing;
  return new;
end;
$$;
revoke all on function public.orgs_groups_queue_reconcile() from public, anon, authenticated;

create trigger orgs_groups_queue_reconcile
  after update of groups_enabled on public.orgs
  for each row when (old.groups_enabled is distinct from new.groups_enabled)
  execute function public.orgs_groups_queue_reconcile();
