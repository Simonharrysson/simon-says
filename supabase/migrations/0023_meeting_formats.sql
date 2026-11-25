-- Meeting formats: format profiles, person roles, agenda meetings, richer note items.
-- Additive and backward compatible with the deployed code (every new column is nullable or has a default).

-- ---------------------------------------------------------------------------------------------
-- format_profiles: an org's meeting formats (versions); one row per org may be the default.

create table public.format_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  kind text not null check (kind in ('veckomote', 'styrelseprotokoll', 'enkel', 'learned')),
  profile jsonb not null,
  approved_by uuid references auth.users on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  is_default boolean not null default false
);
create unique index format_profiles_one_default_idx on public.format_profiles (org_id) where is_default;
create index format_profiles_org_idx on public.format_profiles (org_id, created_at desc);

alter table public.format_profiles enable row level security;
revoke all on table public.format_profiles from anon, authenticated, service_role;
grant select, insert, update, delete on table public.format_profiles to service_role;
grant select on table public.format_profiles to authenticated;
create policy format_profiles_select on public.format_profiles for select to authenticated
  using (public.is_org_member(org_id));

-- Admins only: inserts an approved version and makes it the org's default.
create function public.set_default_format(p_org_id uuid, p_kind text, p_profile jsonb)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can set the default format' using errcode = '42501';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  update public.format_profiles set is_default = false where org_id = p_org_id and is_default;
  insert into public.format_profiles (org_id, kind, profile, approved_by, approved_at, is_default)
  values (p_org_id, p_kind, p_profile, auth.uid(), now(), true)
  returning id into v_id;
  return v_id;
end;
$$;

-- Admins only: makes an existing profile of this org the default (rollback / re-adopt).
create function public.set_default_format_id(p_org_id uuid, p_profile_id uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can set the default format' using errcode = '42501';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  perform 1 from public.format_profiles f where f.id = p_profile_id and f.org_id = p_org_id;
  if not found then
    raise exception 'format profile not found in this org' using errcode = '42501';
  end if;
  update public.format_profiles set is_default = false where org_id = p_org_id and is_default and id <> p_profile_id;
  update public.format_profiles set is_default = true where id = p_profile_id;
end;
$$;

revoke all on function public.set_default_format(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.set_default_format_id(uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_default_format(uuid, text, jsonb) to authenticated;
grant execute on function public.set_default_format_id(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- orgs, people

alter table public.orgs add column meeting_folder_id text;
grant update (meeting_folder_id) on table public.orgs to authenticated;

alter table public.people add column role text
  check (role is null or length(btrim(role)) between 1 and 40);

-- ---------------------------------------------------------------------------------------------
-- meetings

alter table public.meetings
  add column agenda_doc boolean not null default false,
  add column format_profile_id uuid references public.format_profiles on delete set null,
  add column layout text not null default 'v1' check (layout in ('v1', 'format')),
  add column is_test boolean not null default false,
  add column agenda_roles jsonb not null default '{}'::jsonb,
  add column checkin_window jsonb;

-- ---------------------------------------------------------------------------------------------
-- note_items

alter table public.note_items
  add column kind text check (kind in ('decision', 'task', 'note', 'attendee', 'now')),
  add column anchor text,
  add column done boolean not null default false,
  add column owner_person_id uuid references public.people on delete set null,
  add column carried_from_meeting uuid,
  add column carried_from_id text,
  add column copy_of text;

alter table public.note_items drop constraint if exists note_items_section_check;
alter table public.note_items add constraint note_items_section_check
  check (section in ('decision', 'action', 'now', 'attendees', 'note'));

-- ---------------------------------------------------------------------------------------------
-- meeting_events: keep every kind up to 0022 (0020) and add the four new ones.
-- 'format_learned' is allowed per the spec but nothing logs it (meeting_id is NOT NULL).

alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed', 'test_started', 'paused', 'unpaused', 'name_round', 'final_without_claude',
    'agenda_anchored', 'format_learned', 'followup_prefilled', 'checkin'
  )
);
