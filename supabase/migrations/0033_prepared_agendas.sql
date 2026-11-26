-- "Förbered möte" (todo #6, docs/superpowers/specs/2026-11-26-prepare-meeting-design.md): an
-- agenda prepared before the meeting, in a Doc Simon Says created in the förening's meeting folder.
-- Strictly additive and backward compatible with the deployed code: one new table (old code never
-- names it) and a wider format_profiles.kind check (old code never writes 'arsmote').

-- ---------------------------------------------------------------------------------------------
-- format_profiles.kind: the new standard Årsmöte format.

alter table public.format_profiles drop constraint if exists format_profiles_kind_check;
alter table public.format_profiles add constraint format_profiles_kind_check
  check (kind in ('veckomote', 'styrelseprotokoll', 'enkel', 'learned', 'arsmote'));

-- ---------------------------------------------------------------------------------------------
-- prepared_agendas: one prepared agenda per förening and meeting date. Preparing again for the
-- same date edits the row and the Doc. The start screen suggests today's (or the nearest
-- upcoming) one. Written by the service role only (the routes check membership); members read.
--
-- - kind: the meeting type the ordförande chose (Veckomöte, Styrelsemöte, Årsmöte);
-- - format_profile_id: the format the meeting will run in (the förening's own version of that
--   kind, else the standard row);
-- - items: the approved draft (labels, roles, sources), the förening's text: never logged;
-- - doc_lines: what Simon Says wrote in the Doc (range name + exact text per line), so preparing
--   again only touches lines nobody edited;
-- - carried: the "Från förra veckan" lines as note_items-shaped rows (rendered by the notes
--   engine, carried_from_* set); the meeting started in the Doc adopts them;
-- - dropped: carried sources (`<meeting>:<item>`) the ordförande took off the agenda;
-- - shared_with: members the Doc was shared with as writers (recorded as the meeting's shares);
-- - gen / journal: preparing again writes ranges under a new generation and journals each Doc
--   batch before sending it (lib/prepare/reprepare.ts), so a crash between the Doc write and the
--   save is settled on the next run;
-- - busy_until: a lease, so two people preparing the same date never plan from the same state.

create table public.prepared_agendas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  meeting_date date not null,
  meeting_time text check (meeting_time is null or meeting_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  kind text not null check (kind in ('veckomote', 'styrelsemote', 'arsmote')),
  format_profile_id uuid references public.format_profiles on delete set null,
  doc_id text not null,
  tab_id text not null,
  doc_name text not null check (length(doc_name) between 1 and 300),
  items jsonb not null default '[]'::jsonb,
  doc_lines jsonb not null default '[]'::jsonb,
  carried jsonb not null default '[]'::jsonb,
  dropped jsonb not null default '[]'::jsonb,
  source_meeting_id uuid references public.meetings on delete set null,
  shared_with uuid[] not null default '{}',
  gen integer not null default 0,
  journal jsonb,
  busy_until timestamptz,
  prepared_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index prepared_agendas_org_date_idx on public.prepared_agendas (org_id, meeting_date);
create index prepared_agendas_doc_idx on public.prepared_agendas (doc_id);

alter table public.prepared_agendas enable row level security;
revoke all on table public.prepared_agendas from anon, authenticated, service_role;
grant select, insert, update, delete on table public.prepared_agendas to service_role;
grant select on table public.prepared_agendas to authenticated;
create policy prepared_agendas_select on public.prepared_agendas for select to authenticated
  using (public.is_org_member(org_id));

-- The lease (service role only): one conditional update, so of two concurrent callers exactly one
-- gets the row back; an expired lease (a crashed request) is taken over.
create function public.acquire_prepared_lease(p_id uuid, p_ms integer)
returns setof public.prepared_agendas
language sql volatile security definer set search_path = ''
as $$
  update public.prepared_agendas
     set busy_until = now() + make_interval(secs => p_ms / 1000.0)
   where id = p_id
     and (busy_until is null or busy_until < now())
  returning *;
$$;
revoke all on function public.acquire_prepared_lease(uuid, integer) from public, anon, authenticated;
grant execute on function public.acquire_prepared_lease(uuid, integer) to service_role;
