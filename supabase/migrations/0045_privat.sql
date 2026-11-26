-- Privat v1 (docs/superpowers/specs/2026-11-26-privat-design.md): a personal space per account,
-- next to the user's föreningar. It reuses orgs/meetings (so the live engine, caps, kill switch,
-- deletion and RLS keep working) with a space kind, and adds contexts, a stored summary per
-- meeting and a per-context task list.
--
-- Strictly additive and backward compatible with the deployed code:
-- * orgs.kind defaults to 'forening' (every existing row); clients can't write it (no column
--   grant), so only ensure_my_privat_space() makes a Privat space;
-- * a Privat space has exactly one member, its creator: a trigger on org_members refuses anyone
--   else (join_org, invites and every other way in go through that insert), and invite codes of a
--   Privat space resolve to nothing;
-- * meetings.doc_id / notes_tab_id become nullable: a Privat recording without a Google Doc
--   stores its notes in note_items only. Old code never sees such rows (no Privat space exists
--   before this deploy);
-- * new tables contexts, private_summaries, context_tasks (RLS: members of the space only);
-- * e-mail category 'private_summary' ("Sammanfattning av mina inspelningar").

-- ---------------------------------------------------------------------------------------------
-- orgs.kind

alter table public.orgs
  add column kind text not null default 'forening' check (kind in ('forening', 'privat', 'foretag'));

-- One Privat space per account.
create unique index orgs_one_privat_per_user on public.orgs (created_by) where kind = 'privat';

-- The create-org limits (0041) are about föreningar: a Privat space neither counts nor is counted
-- (no org_creations row either: it is not a creation the user chose).
create or replace function public.orgs_limit_per_creator()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.created_by is null or new.kind = 'privat' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('orgs_limit:' || new.created_by::text));
  if coalesce(auth.role(), '') <> 'service_role' then
    if (select count(*) from public.orgs o where o.created_by = new.created_by and o.kind <> 'privat') >= 10 then
      raise exception 'org limit reached: max 10 orgs per user' using errcode = 'P0001';
    end if;
    if (select count(*) from public.org_creations c where c.user_id = new.created_by) >= 30 then
      raise exception 'org creation cap reached: max 30 orgs ever per user' using errcode = 'P0001';
    end if;
  end if;
  insert into public.org_creations (org_id, user_id) values (new.id, new.created_by);
  return new;
end;
$$;
revoke all on function public.orgs_limit_per_creator() from public, anon, authenticated;

-- The signed-in user's Privat space, created on first use (lazily: the Privat page and the start
-- of a recording call this). Idempotent and race-safe (the unique index above).
create function public.ensure_my_privat_space()
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select o.id into v_org from public.orgs o where o.created_by = v_uid and o.kind = 'privat';
  if v_org is not null then
    return v_org;
  end if;
  insert into public.orgs (name, kind, created_by, share_transcript, summary_mode)
  values ('Privat', 'privat', v_uid, false, 'off')
  on conflict (created_by) where kind = 'privat' do nothing
  returning id into v_org;
  if v_org is null then
    select o.id into v_org from public.orgs o where o.created_by = v_uid and o.kind = 'privat';
  end if;
  return v_org;
end;
$$;
revoke all on function public.ensure_my_privat_space() from public, anon, authenticated;
grant execute on function public.ensure_my_privat_space() to authenticated;

-- Exactly one member: the creator (added by orgs_add_creator_as_admin). Every way into an org
-- (join_org, accepted invites, the service role) inserts here, so this is the one guard.
create function public.privat_single_member()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind text;
  v_owner uuid;
begin
  select o.kind, o.created_by into v_kind, v_owner from public.orgs o where o.id = new.org_id;
  if v_kind = 'privat' and new.user_id is distinct from v_owner then
    raise exception 'privat: a Privat space has exactly one member' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.privat_single_member() from public, anon, authenticated;

create trigger org_members_privat_single
  before insert or update of user_id, org_id on public.org_members
  for each row execute function public.privat_single_member();

-- The member gone (account deleted): the Privat space and everything in it goes too.
create function public.privat_delete_when_empty()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.orgs o
  where o.id = old.org_id and o.kind = 'privat'
    and not exists (select 1 from public.org_members m where m.org_id = o.id);
  return null;
end;
$$;
revoke all on function public.privat_delete_when_empty() from public, anon, authenticated;

create trigger org_members_privat_cleanup
  after delete on public.org_members
  for each row execute function public.privat_delete_when_empty();

-- Invite links never lead into a Privat space.
create or replace function public.invite_org_name(p_code text)
returns text
language sql stable security definer set search_path = ''
as $$
  select o.name from public.orgs o where o.invite_code = p_code and o.kind <> 'privat';
$$;

create or replace function public.join_org(p_code text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_org uuid;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select o.id into v_org from public.orgs o where o.invite_code = p_code and o.kind <> 'privat';
  if v_org is null then
    return null;
  end if;
  insert into public.org_members (org_id, user_id, role)
  values (v_org, v_user, 'member')
  on conflict (org_id, user_id) do nothing;
  return v_org;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- contexts: what a recording is about (a course, a project, "Övrigt"). Per space.

create table public.contexts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80 and position(chr(10) in name) = 0),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create unique index contexts_org_name_idx on public.contexts (org_id, lower(btrim(name)));
create index contexts_org_used_idx on public.contexts (org_id, last_used_at desc nulls last);

create function public.is_context_member(p_context_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.contexts c
    join public.org_members m on m.org_id = c.org_id
    where c.id = p_context_id and m.user_id = auth.uid()
  );
$$;
revoke all on function public.is_context_member(uuid) from public, anon;
grant execute on function public.is_context_member(uuid) to authenticated, service_role;

alter table public.contexts enable row level security;
revoke all on table public.contexts from anon, authenticated, service_role;
grant select, insert, update, delete on table public.contexts to service_role;
grant select, delete on table public.contexts to authenticated;
grant insert (org_id, name) on table public.contexts to authenticated;
grant update (name, last_used_at) on table public.contexts to authenticated;

create policy contexts_select on public.contexts for select to authenticated
  using (public.is_org_member(org_id));
create policy contexts_insert on public.contexts for insert to authenticated
  with check (public.is_org_member(org_id));
create policy contexts_update on public.contexts for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
-- Deleting a context deletes its meetings (cascade below), so never while one of them runs.
create policy contexts_delete on public.contexts for delete to authenticated
  using (
    public.is_org_member(org_id)
    and not exists (
      select 1 from public.meetings mt where mt.context_id = contexts.id and mt.status in ('live', 'ending')
    )
  );

-- ---------------------------------------------------------------------------------------------
-- meetings: the context, and no Doc for a Privat recording

alter table public.meetings
  add column context_id uuid references public.contexts (id) on delete cascade;
create index meetings_context_idx on public.meetings (context_id, started_at desc) where context_id is not null;

alter table public.meetings alter column doc_id drop not null;
alter table public.meetings alter column notes_tab_id drop not null;

-- ---------------------------------------------------------------------------------------------
-- private_summaries: the one Claude summary after a Privat meeting (written by the server).
-- since_last: [{ "taskId": uuid, "text": "...", "owner": "...", "status": "done"|"open"|"not_mentioned" }].
-- mailed_at: the e-mail went to the mailer (at most once: set before the send).

create table public.private_summaries (
  meeting_id uuid primary key references public.meetings (id) on delete cascade,
  context_id uuid references public.contexts (id) on delete cascade,
  summary text not null,
  decisions text[] not null default '{}',
  facts text[] not null default '{}',
  questions text[] not null default '{}',
  people text[] not null default '{}',
  topics text[] not null default '{}',
  since_last jsonb not null default '[]'::jsonb,
  previous_meeting_id uuid references public.meetings (id) on delete set null,
  locale text not null default 'sv' check (locale in ('sv', 'en')),
  created_at timestamptz not null default now(),
  mail_claimed_at timestamptz,
  mailed boolean
);
create index private_summaries_context_idx on public.private_summaries (context_id, created_at desc);

alter table public.private_summaries enable row level security;
revoke all on table public.private_summaries from anon, authenticated, service_role;
grant select, insert, update, delete on table public.private_summaries to service_role;
grant select on table public.private_summaries to authenticated;
create policy private_summaries_select on public.private_summaries for select to authenticated
  using (public.is_meeting_member(meeting_id));

-- ---------------------------------------------------------------------------------------------
-- context_tasks: the open tasks of a context across meetings. Made by the summary (server); the
-- member ticks them done on the context page.

create table public.context_tasks (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references public.contexts (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  text text not null check (length(btrim(text)) between 1 and 500),
  owner text check (owner is null or length(btrim(owner)) between 1 and 100),
  position int not null default 0,
  done boolean not null default false,
  done_at timestamptz,
  -- The meeting whose summary found it done ("Sedan sist: klart"); null when ticked by hand.
  done_meeting_id uuid references public.meetings (id) on delete set null,
  created_at timestamptz not null default now()
);
create index context_tasks_context_idx on public.context_tasks (context_id, done, created_at);
create index context_tasks_meeting_idx on public.context_tasks (meeting_id);

alter table public.context_tasks enable row level security;
revoke all on table public.context_tasks from anon, authenticated, service_role;
grant select, insert, update, delete on table public.context_tasks to service_role;
grant select on table public.context_tasks to authenticated;
grant update (done, done_at) on table public.context_tasks to authenticated;
create policy context_tasks_select on public.context_tasks for select to authenticated
  using (public.is_context_member(context_id));
create policy context_tasks_update on public.context_tasks for update to authenticated
  using (public.is_context_member(context_id)) with check (public.is_context_member(context_id));

-- ---------------------------------------------------------------------------------------------
-- E-mail category (0039): replace the one list.

create or replace function public.email_categories()
returns text[]
language sql immutable set search_path = ''
as $$ select array['meeting_summary', 'invite', 'private_summary']::text[] $$;
