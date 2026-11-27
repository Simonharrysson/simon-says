-- Företag v1 (docs/superpowers/specs/2026-11-27-foretag-v1-design.md): a company space whose
-- visibility follows the company tree, enforced here in the database.
--
-- The rule (Simon 2026-11-27): you see the meetings of your own group, plus every meeting of any
-- group deeper in the tree than your own level. Company admins see everything. A meeting for
-- Hela företaget (no group) is seen by every member. The starter and the attendees always see the
-- meeting. A "Privat möte" is seen only by its attendees (and starter) and admins.
-- Task delivery across visibility: note_items stay readable by the meeting's viewers only. A task
-- whose owner can't see the meeting is copied to task_handoffs as pending; the starter or an admin
-- approves it (optionally reworded) before the owner sees it, and the owner sees only the
-- reviewed text, the giver's name and the due date, never the meeting.
--
-- Strictly additive and backward compatible with the deployed code:
-- * orgs.kind already allows 'foretag' (0045); only create_foretag() (service role) makes one;
-- * groups: a tree per company (parent_group_id from day 1, depth kept by a trigger);
-- * people.group_id, meetings.group_id, meetings.private, contexts.domain: nullable / defaulted,
--   no client grants (written by admin functions or the server only), never set outside a Företag;
-- * meeting_attendees: who attended (starter, calendar guest, listed), written by the server;
-- * can_see_meeting(): what meetings_select and is_meeting_member() now ask. For every org that
--   is not a Företag it is exactly is_org_member(org) as before, so föreningar and Privat keep
--   today's answers on every table under a meeting;
-- * people writes in a Företag are admin-only (a member could otherwise link a placed person row
--   to their own account and inherit its place in the tree).

-- ---------------------------------------------------------------------------------------------
-- groups

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 40 and position(chr(10) in name) = 0),
  -- No action (checked at the end of the statement), so deleting the company cascades through the tree.
  parent_group_id uuid references public.groups (id),
  depth int not null default 0 check (depth between 0 and 20),
  position int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index groups_org_name_idx on public.groups (org_id, lower(btrim(name))) where archived_at is null;
create index groups_org_idx on public.groups (org_id);
create index groups_parent_idx on public.groups (parent_group_id);

-- Depth = parent's depth + 1 (0 at a root); the parent must be in the same org; no cycles. A move
-- (new parent) recomputes the whole subtree below it.
create function public.groups_tree()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_parent public.groups;
  v_walk uuid;
  v_steps int := 0;
begin
  if new.parent_group_id is null then
    new.depth := 0;
  else
    select * into v_parent from public.groups g where g.id = new.parent_group_id;
    if v_parent.id is null or v_parent.org_id <> new.org_id then
      raise exception 'groups: the parent is not in this company' using errcode = '22023';
    end if;
    v_walk := new.parent_group_id;
    while v_walk is not null loop
      if v_walk = new.id then
        raise exception 'groups: a group cannot sit under itself' using errcode = '22023';
      end if;
      v_steps := v_steps + 1;
      if v_steps > 20 then
        raise exception 'groups: the tree is too deep' using errcode = '22023';
      end if;
      select g.parent_group_id into v_walk from public.groups g where g.id = v_walk;
    end loop;
    new.depth := v_parent.depth + 1;
  end if;
  return new;
end;
$$;
revoke all on function public.groups_tree() from public, anon, authenticated;

create trigger groups_tree
  before insert or update of parent_group_id, org_id on public.groups
  for each row execute function public.groups_tree();

-- After a move: the children re-run groups_tree (their parent's depth changed), recursively.
create function public.groups_redepth_children()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.depth is distinct from old.depth then
    update public.groups g set parent_group_id = g.parent_group_id where g.parent_group_id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function public.groups_redepth_children() from public, anon, authenticated;

-- No column list: depth is set by groups_tree, never named in the UPDATE itself.
create trigger groups_redepth_children
  after update on public.groups
  for each row when (old.depth is distinct from new.depth) execute function public.groups_redepth_children();

-- ---------------------------------------------------------------------------------------------
-- Columns

alter table public.people add column group_id uuid references public.groups (id) on delete set null;
create index people_group_idx on public.people (group_id) where group_id is not null;

alter table public.meetings
  -- No action, not restrict: a company delete cascades to both groups and meetings in one statement.
  add column group_id uuid references public.groups (id),
  add column private boolean not null default false;
create index meetings_group_idx on public.meetings (group_id, started_at desc) where group_id is not null;

-- A Företag customer is a context with the e-mail domain it was found from (only the domain is
-- stored, never an address). Null for Privat contexts.
alter table public.contexts
  add column domain text check (domain is null or (length(domain) between 3 and 253 and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'));
create unique index contexts_org_domain_idx on public.contexts (org_id, domain) where domain is not null;

-- ---------------------------------------------------------------------------------------------
-- meeting_attendees: accounts known to have attended (fail closed: only certain matches).

create table public.meeting_attendees (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('starter', 'calendar', 'listed')),
  created_at timestamptz not null default now(),
  primary key (meeting_id, user_id)
);
create index meeting_attendees_user_idx on public.meeting_attendees (user_id);

alter table public.meeting_attendees enable row level security;
revoke all on table public.meeting_attendees from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_attendees to service_role;
grant select on table public.meeting_attendees to authenticated;
create policy meeting_attendees_select on public.meeting_attendees for select to authenticated
  using (user_id = (select auth.uid()));

alter table public.groups enable row level security;
revoke all on table public.groups from anon, authenticated, service_role;
grant select, insert, update, delete on table public.groups to service_role;
grant select on table public.groups to authenticated;
create policy groups_select on public.groups for select to authenticated
  using (public.is_org_member(org_id));

-- ---------------------------------------------------------------------------------------------
-- The visibility predicate

-- The core, for any user: the same answer RLS gives that user (the server asks it for Doc shares
-- and summary recipients).
create function public.foretag_can_see_parts(
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
  select case
    when p_user is null then false
    when not exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = p_user) then false
    when coalesce((select o.kind from public.orgs o where o.id = p_org), 'forening') <> 'foretag' then true
    when exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = p_user and m.role = 'admin') then true
    when p_started_by = p_user or p_attended then true
    when p_private then false
    when p_group is null then true
    else exists (
      select 1
      from public.people p
      join public.groups mine on mine.id = p.group_id
      join public.groups theirs on theirs.id = p_group
      where p.org_id = p_org and p.member_user_id = p_user
        and (mine.id = theirs.id or theirs.depth > mine.depth)
    )
  end;
$$;
revoke all on function public.foretag_can_see_parts(uuid, uuid, uuid, boolean, uuid, boolean) from public, anon, authenticated;

create function public.foretag_can_see(p_user uuid, p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select public.foretag_can_see_parts(
      p_user, mt.org_id, mt.group_id, mt.private, mt.started_by,
      exists (select 1 from public.meeting_attendees a where a.meeting_id = mt.id and a.user_id = p_user)
    )
    from public.meetings mt where mt.id = p_meeting_id
  ), false);
$$;
revoke all on function public.foretag_can_see(uuid, uuid) from public, anon, authenticated;
grant execute on function public.foretag_can_see(uuid, uuid) to service_role;

create function public.can_see_meeting(p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select public.foretag_can_see(auth.uid(), p_meeting_id) $$;
revoke all on function public.can_see_meeting(uuid) from public, anon;
grant execute on function public.can_see_meeting(uuid) to authenticated, service_role;

-- Every table under a meeting asks this (0002, 0008, 0045 …): now the rule above. For a non-Företag
-- org it is still "a member of the meeting's org".
create or replace function public.is_meeting_member(p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select public.foretag_can_see(auth.uid(), p_meeting_id) $$;

drop policy meetings_select on public.meetings;
create policy meetings_select on public.meetings for select to authenticated
  using (public.can_see_meeting(id));

-- The accounts that can see a meeting (Doc shares, summary recipients). Service role only.
create function public.foretag_viewer_ids(p_meeting_id uuid)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.user_id
  from public.meetings mt
  join public.org_members m on m.org_id = mt.org_id
  where mt.id = p_meeting_id and public.foretag_can_see(m.user_id, mt.id);
$$;
revoke all on function public.foretag_viewer_ids(uuid) from public, anon, authenticated;
grant execute on function public.foretag_viewer_ids(uuid) to service_role;

-- The same for a meeting not written yet (the Doc is created, and shared, before the row exists).
create function public.foretag_audience_ids(p_org uuid, p_group uuid, p_private boolean, p_started_by uuid, p_attendees uuid[])
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.user_id
  from public.org_members m
  where m.org_id = p_org
    and public.foretag_can_see_parts(m.user_id, p_org, p_group, p_private, p_started_by, m.user_id = any(coalesce(p_attendees, '{}')));
$$;
revoke all on function public.foretag_audience_ids(uuid, uuid, boolean, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.foretag_audience_ids(uuid, uuid, boolean, uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------------------------
-- people: in a Företag only admins write the list (and group_id has no client grant at all).

create function public.org_is_foretag(p_org_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.orgs o where o.id = p_org_id and o.kind = 'foretag') $$;
revoke all on function public.org_is_foretag(uuid) from public, anon;
grant execute on function public.org_is_foretag(uuid) to authenticated, service_role;

drop policy people_insert on public.people;
create policy people_insert on public.people for insert to authenticated
  with check (
    public.is_org_member(org_id)
    and (not public.org_is_foretag(org_id) or public.is_org_admin(org_id))
    and (member_user_id is null or exists (
      select 1 from public.org_members m where m.org_id = people.org_id and m.user_id = people.member_user_id
    ))
  );
drop policy people_update on public.people;
create policy people_update on public.people for update to authenticated
  using (public.is_org_member(org_id) and (not public.org_is_foretag(org_id) or public.is_org_admin(org_id)))
  with check (
    public.is_org_member(org_id)
    and (not public.org_is_foretag(org_id) or public.is_org_admin(org_id))
    and (member_user_id is null or exists (
      select 1 from public.org_members m where m.org_id = people.org_id and m.user_id = people.member_user_id
    ))
  );
drop policy people_delete on public.people;
create policy people_delete on public.people for delete to authenticated
  using (public.is_org_member(org_id) and (not public.org_is_foretag(org_id) or public.is_org_admin(org_id)));

-- ---------------------------------------------------------------------------------------------
-- Admin functions

-- A new company (service role: the app checks the allow-list first). The creator becomes admin
-- (orgs_add_creator_as_admin), gets a person row at the root group, and tasks are suggest-only.
create function public.create_foretag(p_user uuid, p_name text, p_root_name text, p_person_name text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_root uuid;
begin
  if p_user is null or length(btrim(coalesce(p_name, ''))) not between 1 and 100 then
    raise exception 'create_foretag: bad input' using errcode = '22023';
  end if;
  insert into public.orgs (name, kind, created_by, require_task_fields, summary_mode)
  values (btrim(p_name), 'foretag', p_user, false, 'all')
  returning id into v_org;
  insert into public.groups (org_id, name) values (v_org, btrim(coalesce(nullif(btrim(p_root_name), ''), 'Ledning')))
  returning id into v_root;
  insert into public.people (org_id, name, member_user_id, group_id)
  values (v_org, left(btrim(coalesce(nullif(btrim(p_person_name), ''), 'Admin')), 100), p_user, v_root);
  return v_org;
end;
$$;
revoke all on function public.create_foretag(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_foretag(uuid, text, text, text) to service_role;

-- Create (p_id null) or rename / move a group. Admins of the company only. Null when refused.
create function public.set_group(p_org_id uuid, p_id uuid, p_name text, p_parent uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.org_is_foretag(p_org_id) or not public.is_org_admin(p_org_id) then
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
revoke all on function public.set_group(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.set_group(uuid, uuid, text, uuid) to authenticated;

-- Archive a group (never deleted: meetings point at it). Not while it has active child groups or
-- a live meeting; its people become unplaced.
create function public.archive_group(p_id uuid)
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
  update public.people p set group_id = null where p.group_id = p_id;
  update public.groups g set archived_at = now() where g.id = p_id;
  return true;
end;
$$;
revoke all on function public.archive_group(uuid) from public, anon;
grant execute on function public.archive_group(uuid) to authenticated;

-- Place a person at a group (null: unplaced). Admins only.
create function public.set_person_group(p_person_id uuid, p_group_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.org_id into v_org from public.people p where p.id = p_person_id;
  if v_org is null or not public.org_is_foretag(v_org) or not public.is_org_admin(v_org) then
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
revoke all on function public.set_person_group(uuid, uuid) from public, anon;
grant execute on function public.set_person_group(uuid, uuid) to authenticated;

-- Place a member account: its person row (created when missing, named p_name) at the group.
-- Returns the person id, or null when refused.
create function public.place_member(p_org_id uuid, p_user_id uuid, p_group_id uuid, p_name text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_person uuid;
  v_name text := left(btrim(coalesce(p_name, '')), 100);
begin
  if not public.org_is_foretag(p_org_id) or not public.is_org_admin(p_org_id) then
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
revoke all on function public.place_member(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.place_member(uuid, uuid, uuid, text) to authenticated;

-- The customer for an e-mail domain: created on first sight (named by the caller), else the
-- existing one. Service role (the start of a meeting).
create function public.customer_for_domain(p_org_id uuid, p_domain text, p_name text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_domain text := lower(btrim(p_domain));
  v_name text := left(btrim(coalesce(nullif(btrim(p_name), ''), v_domain)), 80);
begin
  if not public.org_is_foretag(p_org_id) then
    return null;
  end if;
  select c.id into v_id from public.contexts c where c.org_id = p_org_id and c.domain = v_domain;
  if v_id is not null then
    return v_id;
  end if;
  -- A customer named like an existing one (renamed by hand) gets the domain as its name.
  if exists (select 1 from public.contexts c where c.org_id = p_org_id and lower(btrim(c.name)) = lower(v_name)) then
    v_name := left(v_domain, 80);
  end if;
  insert into public.contexts (org_id, name, domain)
  values (p_org_id, v_name, v_domain)
  on conflict (org_id, domain) where domain is not null do nothing
  returning id into v_id;
  if v_id is null then
    select c.id into v_id from public.contexts c where c.org_id = p_org_id and c.domain = v_domain;
  end if;
  return v_id;
end;
$$;
revoke all on function public.customer_for_domain(uuid, text, text) from public, anon, authenticated;
grant execute on function public.customer_for_domain(uuid, text, text) to service_role;

-- contexts (0045): deleting one deletes its meetings (cascade). A Företag customer is never
-- deleted by a client: it would take meetings the member may not even see with it.
drop policy contexts_delete on public.contexts;
create policy contexts_delete on public.contexts for delete to authenticated
  using (
    public.is_org_member(org_id)
    and not public.org_is_foretag(org_id)
    and not exists (
      select 1 from public.meetings mt where mt.context_id = contexts.id and mt.status in ('live', 'ending')
    )
  );

-- ---------------------------------------------------------------------------------------------
-- task_handoffs: a task crossing the visibility boundary, held for review.

create table public.task_handoffs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  item_id text not null,
  owner_person_id uuid not null references public.people (id) on delete cascade,
  -- The task's text: the AI's copy while pending, the reviewed text once approved.
  text text not null check (length(btrim(text)) between 1 and 500),
  due text check (due is null or length(due) <= 100),
  due_date date,
  from_user_id uuid references auth.users (id) on delete set null,
  from_name text check (from_name is null or length(from_name) <= 100),
  status text not null default 'pending' check (status in ('pending', 'approved', 'dropped')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  unique (meeting_id, item_id)
);
create index task_handoffs_owner_idx on public.task_handoffs (owner_person_id, status);
create index task_handoffs_org_idx on public.task_handoffs (org_id, status);

-- May this account approve the meeting's handoffs? Its starter or an admin (who can see it).
create function public.can_approve_handoff(p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.meetings mt
    where mt.id = p_meeting_id
      and public.foretag_can_see(auth.uid(), mt.id)
      and (mt.started_by = auth.uid() or public.is_org_admin(mt.org_id))
  );
$$;
revoke all on function public.can_approve_handoff(uuid) from public, anon;
grant execute on function public.can_approve_handoff(uuid) to authenticated, service_role;

alter table public.task_handoffs enable row level security;
revoke all on table public.task_handoffs from anon, authenticated, service_role;
grant select, insert, update, delete on table public.task_handoffs to service_role;
grant select on table public.task_handoffs to authenticated;
create policy task_handoffs_select on public.task_handoffs for select to authenticated
  using (
    public.can_approve_handoff(meeting_id)
    or (
      status = 'approved'
      and exists (select 1 from public.people p where p.id = task_handoffs.owner_person_id and p.member_user_id = (select auth.uid()))
    )
  );

-- After a Företag meeting: every open task whose owner is an account that can't see the meeting
-- becomes a pending handoff (once per task). Returns the number of new rows. Service role.
create function public.create_task_handoffs(p_meeting_id uuid)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_n int;
begin
  insert into public.task_handoffs (org_id, meeting_id, item_id, owner_person_id, text, due, due_date, from_user_id, from_name)
  select mt.org_id, mt.id, n.id, p.id, left(btrim(n.text), 500), left(n.due, 100), n.due_date, mt.started_by,
    (select s.name from public.people s where s.org_id = mt.org_id and s.member_user_id = mt.started_by limit 1)
  from public.meetings mt
  join public.orgs o on o.id = mt.org_id and o.kind = 'foretag'
  join public.note_items n on n.meeting_id = mt.id
  join public.people p on p.id = n.owner_person_id and p.member_user_id is not null
  where mt.id = p_meeting_id
    and n.section = 'action' and not n.deleted_by_human and not coalesce(n.done, false)
    and length(btrim(n.text)) between 1 and 500
    and not public.foretag_can_see(p.member_user_id, mt.id)
  on conflict (meeting_id, item_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.create_task_handoffs(uuid) from public, anon, authenticated;
grant execute on function public.create_task_handoffs(uuid) to service_role;

-- Approve (with the reviewed wording) or drop a pending handoff. Approvers only.
create function public.approve_task_handoff(p_id uuid, p_text text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_meeting uuid;
begin
  select h.meeting_id into v_meeting from public.task_handoffs h where h.id = p_id and h.status = 'pending';
  if v_meeting is null or not public.can_approve_handoff(v_meeting) then
    return false;
  end if;
  if length(btrim(coalesce(p_text, ''))) not between 1 and 500 then
    return false;
  end if;
  update public.task_handoffs
  set text = btrim(p_text), status = 'approved', decided_by = auth.uid(), decided_at = now()
  where id = p_id and status = 'pending';
  return found;
end;
$$;
revoke all on function public.approve_task_handoff(uuid, text) from public, anon;
grant execute on function public.approve_task_handoff(uuid, text) to authenticated;

create function public.drop_task_handoff(p_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_meeting uuid;
begin
  select h.meeting_id into v_meeting from public.task_handoffs h where h.id = p_id and h.status = 'pending';
  if v_meeting is null or not public.can_approve_handoff(v_meeting) then
    return false;
  end if;
  update public.task_handoffs set status = 'dropped', decided_by = auth.uid(), decided_at = now() where id = p_id and status = 'pending';
  return found;
end;
$$;
revoke all on function public.drop_task_handoff(uuid) from public, anon;
grant execute on function public.drop_task_handoff(uuid) to authenticated;

-- The owner ticks an approved task done (or open again).
create function public.set_task_handoff_done(p_id uuid, p_done boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  update public.task_handoffs h
  set done = p_done, done_at = case when p_done then now() else null end
  where h.id = p_id and h.status = 'approved'
    and exists (select 1 from public.people p where p.id = h.owner_person_id and p.member_user_id = auth.uid());
  return found;
end;
$$;
revoke all on function public.set_task_handoff_done(uuid, boolean) from public, anon;
grant execute on function public.set_task_handoff_done(uuid, boolean) to authenticated;

-- Invite links lead into a Företag like into a förening (join_org, 0045): unchanged.
