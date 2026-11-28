-- "Claude, gör det här" (agent tasks) and "Vad Claude ska veta" (company memory) on the MCP server
-- (docs/superpowers/specs/2026-11-28-claude-tasks-memory-design.md). Strictly additive.
--
-- * agent_task_status: progress Claude reports on a task the meeting gave it (no row: open). Read by
--   whoever sees the meeting (the note_items predicate); written only through mcp_set_agent_task.
-- * org_memory: one admin-curated page per org; members read it, admins write it.
-- * The mcp_* functions act as p_user (mcp_act_as, 0060) and ask the existing predicates; nothing
--   here restates the Företag tree. org_memory_sources asks foretag_can_see for every member.

create table public.agent_task_status (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  item_id text not null check (length(item_id) between 1 and 64),
  status text not null check (status in ('in_progress', 'done', 'blocked')),
  note text check (note is null or length(note) <= 500),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (meeting_id, item_id)
);

alter table public.agent_task_status enable row level security;
revoke all on table public.agent_task_status from anon, authenticated;
grant select on table public.agent_task_status to authenticated;
grant select, insert, update, delete on table public.agent_task_status to service_role;
create policy agent_task_status_select on public.agent_task_status for select to authenticated
  using (public.is_meeting_member(meeting_id));

create table public.org_memory (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  -- [{id, section, text, sources: [meeting uuid], edited}], checked by the app (lib/memory).
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) <= 200),
  generated_at timestamptz,
  sources_from timestamptz,
  sources_count int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.org_memory enable row level security;
revoke all on table public.org_memory from anon, authenticated;
grant select, insert, update on table public.org_memory to authenticated;
grant select, insert, update, delete on table public.org_memory to service_role;
create policy org_memory_select on public.org_memory for select to authenticated
  using (public.is_org_member(org_id));
create policy org_memory_insert on public.org_memory for insert to authenticated
  with check (public.is_org_admin(org_id) and not exists (select 1 from public.orgs o where o.id = org_id and o.kind = 'privat'));
create policy org_memory_update on public.org_memory for update to authenticated
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------------------------
-- Reads and writes as a user (service role only).

-- Agent task status rows of meetings the user can see (the note_items predicate).
create function public.mcp_agent_task_status(p_user uuid, p_meeting_ids uuid[])
returns table (meeting_id uuid, item_id text, status text, note text, updated_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select s.meeting_id, s.item_id, s.status, s.note, s.updated_at from public.agent_task_status s
    where s.meeting_id = any(p_meeting_ids) and public.is_meeting_member(s.meeting_id);
end;
$$;

-- Progress on an agent task: a finished real meeting the user can see, an existing task row, and
-- the user is its assigner (the meeting's runner) or an admin of the org. The app checks first
-- that the row is an agent task (lib/agent/tasks.ts); this is the last line.
create function public.mcp_set_agent_task(p_user uuid, p_meeting uuid, p_item text, p_status text, p_note text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_m public.meetings;
begin
  perform public.mcp_act_as(p_user);
  if p_status not in ('in_progress', 'done', 'blocked') or (p_note is not null and length(p_note) > 500) then
    return false;
  end if;
  select * into v_m from public.meetings mt where mt.id = p_meeting;
  if not found or not public.is_meeting_member(p_meeting) or v_m.status <> 'done' or v_m.is_test then
    return false;
  end if;
  if not (v_m.started_by = p_user or public.is_org_admin(v_m.org_id)) then
    return false;
  end if;
  if not exists (
    select 1 from public.note_items n
    where n.meeting_id = p_meeting and n.id = p_item and n.section = 'action' and not n.deleted_by_human
  ) then
    return false;
  end if;
  insert into public.agent_task_status (meeting_id, item_id, status, note, updated_by, updated_at)
    values (p_meeting, p_item, p_status, nullif(btrim(p_note), ''), p_user, now())
    on conflict (meeting_id, item_id) do update
      set status = excluded.status,
          note = coalesce(excluded.note, public.agent_task_status.note),
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at;
  return true;
end;
$$;

-- An org's memory for a member (org_memory_select: is_org_member).
create function public.mcp_org_memory(p_user uuid, p_org uuid)
returns table (org_id uuid, lines jsonb, generated_at timestamptz, sources_from timestamptz, sources_count int, updated_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select m.org_id, m.lines, m.generated_at, m.sources_from, m.sources_count, m.updated_at from public.org_memory m
    where m.org_id = p_org and public.is_org_member(m.org_id);
end;
$$;

-- The meetings a memory draft may be built from: finished, real, and visible to EVERY current
-- member of the org (foretag_can_see, the meetings_select rule, for each one). Newest first.
create function public.org_memory_sources(p_org uuid, p_limit int)
returns setof public.meetings
language sql stable security definer set search_path = ''
as $$
  select mt.* from public.meetings mt
  where mt.org_id = p_org
    and mt.status = 'done' and not mt.is_test
    and not exists (
      select 1 from public.org_members m
      where m.org_id = p_org and not public.foretag_can_see(m.user_id, mt.id)
    )
  order by mt.started_at desc
  limit least(greatest(coalesce(p_limit, 40), 1), 100);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'mcp_agent_task_status(uuid, uuid[])',
    'mcp_set_agent_task(uuid, uuid, text, text, text)',
    'mcp_org_memory(uuid, uuid)',
    'org_memory_sources(uuid, int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
