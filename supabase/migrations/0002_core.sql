-- Core schema: orgs, members, people, meetings and everything under a meeting.
--
-- Access model
-- * Automatic API grants are off in simonsays-prod, and the local stack has them on, so every
--   table and function first revokes everything and then grants exactly what is meant.
-- * Clients (role `authenticated`) read what belongs to orgs they are members of. They write
--   only: orgs (create; admins rename/toggle/delete), people (any member), meetings (delete by
--   the starter or an org admin). Everything a running meeting writes (sessions, speaker map,
--   notes, events, usage) is written by the server with service_role.
-- * Membership changes only through security-definer functions (org creation trigger,
--   join_org), so nobody can add themselves to an org or promote themselves.
-- * `segments` is intentionally not here yet: its shape waits for the Task 0 spike.
--
-- Text + check constraints instead of enum types: easier to extend in a later migration.

-- ---------------------------------------------------------------------------------------------
-- Tables

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  invite_code text not null unique
    default translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/', '-_'),
  show_on_status boolean not null default false,
  share_transcript boolean not null default true,
  -- Null once the creator's account is deleted; the org lives on with its other members.
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index orgs_created_by_idx on public.orgs (created_by);

create table public.org_members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_id_idx on public.org_members (user_id);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  member_user_id uuid references auth.users (id) on delete set null
);
create index people_org_id_idx on public.people (org_id);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  started_by uuid references auth.users (id) on delete set null,
  doc_id text not null,
  notes_tab_id text not null,
  transcript_tab_id text,
  header_range text,
  section_ranges jsonb not null default '{}'::jsonb,
  status text not null default 'live' check (status in ('live', 'ending', 'done', 'abandoned')),
  consent_confirmed_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_heartbeat_at timestamptz,
  last_tick_at timestamptz,
  last_tick_ok_at timestamptz,
  failed_ticks int not null default 0,
  tick_lease_until timestamptz,
  doc_paused_at timestamptz,
  current_el_session_id text -- FK added below (el_sessions references meetings)
);
create index meetings_org_id_idx on public.meetings (org_id);
create index meetings_live_idx on public.meetings (status) where status in ('live', 'ending');

-- The server's record of every minted ElevenLabs session. Usage of one session:
--   least(coalesce(closed_at, now()), started_at + max_seconds) - started_at
create table public.el_sessions (
  id text primary key,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  started_at timestamptz not null default now(),
  max_seconds int not null check (max_seconds > 0),
  closed_at timestamptz
);
create index el_sessions_meeting_id_idx on public.el_sessions (meeting_id);
create index el_sessions_open_idx on public.el_sessions (meeting_id) where closed_at is null;

alter table public.meetings
  add constraint meetings_current_el_session_id_fkey
  foreign key (current_el_session_id) references public.el_sessions (id) on delete set null;

create table public.meeting_events (
  id bigint generated always as identity primary key,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (
    kind in ('tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm')
  ),
  detail jsonb not null default '{}'::jsonb
);
create index meeting_events_meeting_id_at_idx on public.meeting_events (meeting_id, at);

-- Speaker labels mean something only within one ElevenLabs session.
create table public.speaker_map (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  el_session_id text not null references public.el_sessions (id) on delete cascade,
  speaker_label text not null,
  person_id uuid references public.people (id) on delete set null,
  display_name text not null,
  needs_confirm boolean not null default false,
  primary key (meeting_id, el_session_id, speaker_label)
);
create index speaker_map_el_session_id_idx on public.speaker_map (el_session_id);
create index speaker_map_person_id_idx on public.speaker_map (person_id);

create table public.note_items (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  id text not null,
  section text not null check (section in ('decision', 'action', 'now', 'attendees')),
  text text not null,
  owner text,
  due text,
  locked boolean not null default false,
  deleted_by_human boolean not null default false,
  last_rendered_text text,
  range_name text,
  position int not null default 0,
  primary key (meeting_id, id)
);

-- `seconds` and `usd` are updated when a session closes and after every Claude call.
create table public.usage_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  day date not null,
  seconds int not null default 0,
  claude_input_tokens bigint not null default 0,
  claude_output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  usd numeric(12, 6) not null default 0,
  primary key (org_id, day)
);
create index usage_daily_day_idx on public.usage_daily (day);

-- ---------------------------------------------------------------------------------------------
-- Helpers for policies. Security definer so policies on org_members don't recurse into
-- org_members' own policies.

create function public.is_org_member(p_org_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m where m.org_id = p_org_id and m.user_id = auth.uid()
  );
$$;

create function public.is_org_admin(p_org_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

create function public.is_meeting_member(p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.meetings mt
    join public.org_members m on m.org_id = mt.org_id
    where mt.id = p_meeting_id and m.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Triggers on orgs

-- Max 2 orgs per creator. Security definer so the count sees every org, not only RLS-visible
-- ones; the advisory lock serialises concurrent creates by the same user.
create function public.orgs_limit_per_creator()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.created_by is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('orgs_limit:' || new.created_by::text));
  if (select count(*) from public.orgs o where o.created_by = new.created_by) >= 2 then
    raise exception 'org limit reached: max 2 orgs per user' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger orgs_limit_per_creator
before insert on public.orgs
for each row execute function public.orgs_limit_per_creator();

-- The creator becomes the org's first admin.
create function public.orgs_add_creator_as_admin()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.org_members (org_id, user_id, role)
    values (new.id, new.created_by, 'admin')
    on conflict (org_id, user_id) do update set role = 'admin';
  end if;
  return new;
end;
$$;

create trigger orgs_add_creator_as_admin
after insert on public.orgs
for each row execute function public.orgs_add_creator_as_admin();

-- ---------------------------------------------------------------------------------------------
-- Invite codes

-- Name of the org behind an invite code (for the join page), or null.
create function public.invite_org_name(p_code text)
returns text
language sql stable security definer set search_path = ''
as $$
  select o.name from public.orgs o where o.invite_code = p_code;
$$;

-- Join the org behind an invite code as a member. Returns the org id, or null for an unknown
-- code. Joining an org you're already in keeps your role.
create function public.join_org(p_code text)
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
  select o.id into v_org from public.orgs o where o.invite_code = p_code;
  if v_org is null then
    return null;
  end if;
  insert into public.org_members (org_id, user_id, role)
  values (v_org, v_user, 'member')
  on conflict (org_id, user_id) do nothing;
  return v_org;
end;
$$;

-- New invite code (admins only); the old link stops working.
create function public.rotate_invite_code(p_org_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_code text := translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/', '-_');
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can rotate the invite code' using errcode = '42501';
  end if;
  update public.orgs set invite_code = v_code where id = p_org_id;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Server-side helpers (service_role only)

-- Seconds an org has used this calendar month (UTC): closed sessions' seconds from
-- usage_daily plus the elapsed time of sessions still open. The single source for caps.
create function public.org_month_seconds(p_org_id uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select
    coalesce((
      select sum(u.seconds)::bigint from public.usage_daily u
      where u.org_id = p_org_id
        and u.day >= date_trunc('month', now() at time zone 'utc')::date
    ), 0)
    + coalesce((
      select sum(greatest(0, extract(epoch from
          least(now(), s.started_at + make_interval(secs => s.max_seconds)) - s.started_at
        )))::bigint
      from public.el_sessions s
      join public.meetings mt on mt.id = s.meeting_id
      where mt.org_id = p_org_id and s.closed_at is null
    ), 0);
$$;

-- Emails of an org's members (for alarms and summaries). auth.users isn't exposed over the API.
create function public.member_emails(p_org_id uuid)
returns setof text
language sql stable security definer set search_path = ''
as $$
  select u.email::text from public.org_members m
  join auth.users u on u.id = m.user_id
  where m.org_id = p_org_id and u.email is not null
  order by m.joined_at;
$$;

-- ---------------------------------------------------------------------------------------------
-- Function privileges: execute defaults to PUBLIC, so revoke and grant explicitly.

revoke all on function public.is_org_member(uuid) from public, anon;
revoke all on function public.is_org_admin(uuid) from public, anon;
revoke all on function public.is_meeting_member(uuid) from public, anon;
revoke all on function public.orgs_limit_per_creator() from public, anon, authenticated;
revoke all on function public.orgs_add_creator_as_admin() from public, anon, authenticated;
revoke all on function public.invite_org_name(text) from public, anon;
revoke all on function public.join_org(text) from public, anon;
revoke all on function public.rotate_invite_code(uuid) from public, anon;
revoke all on function public.org_month_seconds(uuid) from public, anon, authenticated;
revoke all on function public.member_emails(uuid) from public, anon, authenticated;

grant execute on function public.is_org_member(uuid) to authenticated, service_role;
grant execute on function public.is_org_admin(uuid) to authenticated, service_role;
grant execute on function public.is_meeting_member(uuid) to authenticated, service_role;
grant execute on function public.invite_org_name(text) to authenticated, service_role;
grant execute on function public.join_org(text) to authenticated;
grant execute on function public.rotate_invite_code(uuid) to authenticated;
grant execute on function public.org_month_seconds(uuid) to service_role;
grant execute on function public.member_emails(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Table privileges: start from nothing, then grant.

revoke all on table
  public.orgs, public.org_members, public.people, public.meetings, public.el_sessions,
  public.meeting_events, public.speaker_map, public.note_items, public.usage_daily
from anon, authenticated, service_role;

grant select, insert, update, delete on table
  public.orgs, public.org_members, public.people, public.meetings, public.el_sessions,
  public.meeting_events, public.speaker_map, public.note_items, public.usage_daily
to service_role;
grant usage on sequence public.meeting_events_id_seq to service_role;

grant select, delete on table public.orgs to authenticated;
grant insert (name, show_on_status, share_transcript, created_by) on table public.orgs to authenticated;
grant update (name, show_on_status, share_transcript) on table public.orgs to authenticated;
grant select on table public.org_members to authenticated;
grant select, insert, update, delete on table public.people to authenticated;
grant select, delete on table public.meetings to authenticated;
grant select on table
  public.el_sessions, public.meeting_events, public.speaker_map, public.note_items,
  public.usage_daily
to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row level security

alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.people enable row level security;
alter table public.meetings enable row level security;
alter table public.el_sessions enable row level security;
alter table public.meeting_events enable row level security;
alter table public.speaker_map enable row level security;
alter table public.note_items enable row level security;
alter table public.usage_daily enable row level security;

-- orgs. `created_by = auth.uid()` in SELECT lets `insert ... returning` see the new row
-- (the RETURNING check can run before the creator's membership row exists).
create policy orgs_select on public.orgs for select to authenticated
  using (public.is_org_member(id) or created_by = (select auth.uid()));
create policy orgs_insert on public.orgs for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy orgs_update on public.orgs for update to authenticated
  using (public.is_org_admin(id)) with check (public.is_org_admin(id));
create policy orgs_delete on public.orgs for delete to authenticated
  using (public.is_org_admin(id));

-- org_members: read your orgs' member lists. No client writes.
create policy org_members_select on public.org_members for select to authenticated
  using (public.is_org_member(org_id));

-- people: any member manages the org's person list. A person may only be linked to a member
-- of the same org.
create policy people_select on public.people for select to authenticated
  using (public.is_org_member(org_id));
create policy people_insert on public.people for insert to authenticated
  with check (
    public.is_org_member(org_id)
    and (member_user_id is null or exists (
      select 1 from public.org_members m where m.org_id = people.org_id and m.user_id = people.member_user_id
    ))
  );
create policy people_update on public.people for update to authenticated
  using (public.is_org_member(org_id))
  with check (
    public.is_org_member(org_id)
    and (member_user_id is null or exists (
      select 1 from public.org_members m where m.org_id = people.org_id and m.user_id = people.member_user_id
    ))
  );
create policy people_delete on public.people for delete to authenticated
  using (public.is_org_member(org_id));

-- meetings: members read; the starter or an org admin deletes.
create policy meetings_select on public.meetings for select to authenticated
  using (public.is_org_member(org_id));
create policy meetings_delete on public.meetings for delete to authenticated
  using (
    public.is_org_member(org_id)
    and (started_by = (select auth.uid()) or public.is_org_admin(org_id))
  );

-- Everything under a meeting: members of the meeting's org read.
create policy el_sessions_select on public.el_sessions for select to authenticated
  using (public.is_meeting_member(meeting_id));
create policy meeting_events_select on public.meeting_events for select to authenticated
  using (public.is_meeting_member(meeting_id));
create policy speaker_map_select on public.speaker_map for select to authenticated
  using (public.is_meeting_member(meeting_id));
create policy note_items_select on public.note_items for select to authenticated
  using (public.is_meeting_member(meeting_id));

create policy usage_daily_select on public.usage_daily for select to authenticated
  using (public.is_org_member(org_id));
