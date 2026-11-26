-- Goals from old protocols (todo #7, docs/superpowers/specs/2026-11-26-onboarding-proposal.md,
-- Simon's answer 3): an admin picks the förening's old protocol Docs; each is read once and
-- reduced to short structured items (agenda topics, decisions, tasks with a role and done flag,
-- one-line status reports). The Doc text is never stored, nor its title; names are scrubbed
-- before a row is written. The goals digest reads these rows with the förening's own meetings.
-- Strictly additive: three new tables and four new functions; nothing existing changes.

-- ---------------------------------------------------------------------------------------------
-- history_protocols: one row per imported Doc. `drive_file_id` is unique per org, so importing
-- the same Doc again replaces it (never two copies in the chronology). `date_from`: 'doc' when
-- the date was read from the protocol, 'file' when it fell back to the Drive file's date.

create table public.history_protocols (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  meeting_date date not null,
  date_from text not null check (date_from in ('doc', 'file')),
  imported_by uuid references auth.users on delete set null,
  imported_at timestamptz not null default now(),
  unique (org_id, drive_file_id)
);
create index history_protocols_org_idx on public.history_protocols (org_id, meeting_date);

create table public.history_items (
  id bigint generated always as identity primary key,
  protocol_id uuid not null references public.history_protocols on delete cascade,
  org_id uuid not null references public.orgs on delete cascade,
  position smallint not null check (position between 0 and 199),
  kind text not null check (kind in ('topic', 'decision', 'task', 'report')),
  text text not null check (length(btrim(text)) between 1 and 300),
  topic text check (topic is null or length(topic) <= 120),
  owner text check (owner is null or length(owner) <= 60),
  done boolean,
  unique (protocol_id, position)
);
create index history_items_org_idx on public.history_items (org_id, protocol_id);

-- Members read (the Översikt shows how many protocols are imported; the goals come from them);
-- nobody writes the tables directly: only the functions below.
alter table public.history_protocols enable row level security;
alter table public.history_items enable row level security;
revoke all on table public.history_protocols from anon, authenticated, service_role;
revoke all on table public.history_items from anon, authenticated, service_role;
grant select, insert, update, delete on table public.history_protocols to service_role;
grant select, insert, update, delete on table public.history_items to service_role;
grant select on table public.history_protocols to authenticated;
grant select on table public.history_items to authenticated;
create policy history_protocols_select on public.history_protocols for select to authenticated
  using (public.is_org_member(org_id));
create policy history_items_select on public.history_items for select to authenticated
  using (public.is_org_member(org_id));

-- Admins only: stores one imported protocol, replacing an earlier import of the same Doc.
-- `p_items`: [{ kind, text, topic?, owner?, done? }] (at most 200, in order). Returns the row id.
create function public.save_history_protocol(
  p_org_id uuid,
  p_drive_file_id text,
  p_meeting_date date,
  p_date_from text,
  p_items jsonb
)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_item jsonb;
  v_pos smallint := 0;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can import protocols' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'items must be an array of at most 200' using errcode = '22023';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  delete from public.history_protocols where org_id = p_org_id and drive_file_id = p_drive_file_id;
  insert into public.history_protocols (org_id, drive_file_id, meeting_date, date_from, imported_by)
  values (p_org_id, p_drive_file_id, p_meeting_date, p_date_from, auth.uid())
  returning id into v_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'text') is distinct from 'string' then
      raise exception 'each item needs a text' using errcode = '22023';
    end if;
    insert into public.history_items (protocol_id, org_id, position, kind, text, topic, owner, done)
    values (
      v_id,
      p_org_id,
      v_pos,
      v_item ->> 'kind',
      btrim(v_item ->> 'text'),
      nullif(btrim(coalesce(v_item ->> 'topic', '')), ''),
      nullif(btrim(coalesce(v_item ->> 'owner', '')), ''),
      case jsonb_typeof(v_item -> 'done') when 'boolean' then (v_item ->> 'done')::boolean else null end
    );
    v_pos := v_pos + 1;
  end loop;
  return v_id;
end;
$$;

revoke all on function public.save_history_protocol(uuid, text, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_history_protocol(uuid, text, date, text, jsonb) to authenticated;

-- Admins only: removes every imported protocol of the org (the "Ta bort" on the Översikt).
-- Returns how many protocols were removed.
create function public.clear_history_protocols(p_org_id uuid)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can remove imported protocols' using errcode = '42501';
  end if;
  delete from public.history_protocols where org_id = p_org_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.clear_history_protocols(uuid) from public, anon, authenticated;
grant execute on function public.clear_history_protocols(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- history_import_claims: one row per protocol read with Claude. At most 60 per förening per 24 h,
-- so one admin can never use up the global daily Claude cap that live notes depend on (the same
-- reason as goal_proposals, 0028). Rows hold no content; older than 7 days they are removed.

create table public.history_import_claims (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs on delete cascade,
  requested_by uuid references auth.users on delete set null,
  at timestamptz not null default now()
);
create index history_import_claims_org_idx on public.history_import_claims (org_id, at desc);

alter table public.history_import_claims enable row level security;
revoke all on table public.history_import_claims from anon, authenticated, service_role;
grant select, insert, update, delete on table public.history_import_claims to service_role;

-- Admins only: claims one protocol read. True = go ahead (the row is written), false = the 60 per
-- 24 h are used up. Locks the org row, so concurrent claims cannot both get the last one.
create function public.claim_history_import(p_org_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can import protocols' using errcode = '42501';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  delete from public.history_import_claims where org_id = p_org_id and at < now() - interval '7 days';
  select count(*) into v_count from public.history_import_claims
   where org_id = p_org_id and at > now() - interval '24 hours';
  if v_count >= 60 then
    return false;
  end if;
  insert into public.history_import_claims (org_id, requested_by) values (p_org_id, auth.uid());
  return true;
end;
$$;

revoke all on function public.claim_history_import(uuid) from public, anon, authenticated;
grant execute on function public.claim_history_import(uuid) to authenticated;
