-- The MCP server (docs/superpowers/specs/2026-11-27-mcp-design.md): Simon Says as its own OAuth 2.1
-- authorization server for a user's Claude, and the reads its tools make as that user. Strictly
-- additive; code deployed before this migration finds no table and fails closed (no token is valid).
--
-- * The tools read through the mcp_* functions below (service role only), each for an explicit
--   p_user. They never restate a visibility rule: they act as p_user for the transaction
--   (mcp_act_as: the JWT claims auth.uid() reads) and ask the EXISTING predicates the RLS policies
--   ask (can_see_meeting → foretag_can_see, is_org_member, is_context_member, can_approve_handoff),
--   so föreningar, the Företag tree, Privat möte, task approval and Privat spaces apply unchanged.
--
-- * Every token, code and pending request is server-only (service role). Tokens and codes are
--   stored as SHA-256 hex only, never in clear.
-- * mcp_grants: one per user and client ("Kopplade AI-assistenter" in Konto). The user selects
--   their own rows and revokes through revoke_mcp_grant() (auth.uid()).
-- * mcp_audit: one row per tool call: who, which tool, which ids, when, ok. Never a query, a point
--   or any other text. The user selects their own rows.
-- * mcp_rate + mcp_rate_take(): fixed-window counters (Vercel has no shared memory).

create table public.mcp_clients (
  id text primary key,
  client_name text not null check (length(client_name) between 1 and 100),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5),
  created_at timestamptz not null default now()
);

create table public.mcp_auth_requests (
  id text primary key,
  client_id text not null references public.mcp_clients (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  state text,
  resource text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.mcp_auth_codes (
  code_hash text primary key,
  client_id text not null references public.mcp_clients (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.mcp_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null references public.mcp_clients (id) on delete cascade,
  client_name text not null,
  resource text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index mcp_grants_user_idx on public.mcp_grants (user_id, created_at desc);

create table public.mcp_tokens (
  token_hash text primary key,
  grant_id uuid not null references public.mcp_grants (id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  expires_at timestamptz not null,
  -- A refresh token is spent once (rotation); a second use revokes the grant.
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index mcp_tokens_grant_idx on public.mcp_tokens (grant_id);

create table public.mcp_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  grant_id uuid references public.mcp_grants (id) on delete set null,
  tool text not null check (length(tool) between 1 and 64),
  ids jsonb not null default '{}'::jsonb,
  ok boolean not null,
  at timestamptz not null default now()
);
create index mcp_audit_user_idx on public.mcp_audit (user_id, at desc);

create table public.mcp_rate (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);

-- ---------------------------------------------------------------------------------------------
-- Access: server-only by default; the user reads their own grants and audit rows.

alter table public.mcp_clients enable row level security;
alter table public.mcp_auth_requests enable row level security;
alter table public.mcp_auth_codes enable row level security;
alter table public.mcp_grants enable row level security;
alter table public.mcp_tokens enable row level security;
alter table public.mcp_audit enable row level security;
alter table public.mcp_rate enable row level security;

revoke all on table public.mcp_clients, public.mcp_auth_requests, public.mcp_auth_codes, public.mcp_grants,
  public.mcp_tokens, public.mcp_audit, public.mcp_rate from anon, authenticated;
grant select, insert, update, delete on table public.mcp_clients, public.mcp_auth_requests, public.mcp_auth_codes,
  public.mcp_grants, public.mcp_tokens, public.mcp_audit, public.mcp_rate to service_role;

grant select (id, client_name, created_at, last_used_at, revoked_at) on table public.mcp_grants to authenticated;
create policy mcp_grants_select_own on public.mcp_grants for select to authenticated using (user_id = (select auth.uid()));

grant select (id, grant_id, tool, ids, ok, at) on table public.mcp_audit to authenticated;
create policy mcp_audit_select_own on public.mcp_audit for select to authenticated using (user_id = (select auth.uid()));

-- Återkalla in Konto: the user's own grant only; its tokens go at once.
create function public.revoke_mcp_grant(p_grant_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_found uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update public.mcp_grants set revoked_at = coalesce(revoked_at, now())
    where id = p_grant_id and user_id = v_uid
    returning id into v_found;
  if v_found is null then
    return false;
  end if;
  delete from public.mcp_tokens where grant_id = v_found;
  return true;
end;
$$;
revoke all on function public.revoke_mcp_grant(uuid) from public, anon;
grant execute on function public.revoke_mcp_grant(uuid) to authenticated;

-- One hit in a fixed window; false when the key is over its limit. Server only.
create function public.mcp_rate_take(p_key text, p_limit int, p_seconds int)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_seconds) * p_seconds);
  v_hits int;
begin
  insert into public.mcp_rate (key, window_start, hits) values (p_key, v_window, 1)
    on conflict (key, window_start) do update set hits = public.mcp_rate.hits + 1
    returning hits into v_hits;
  -- Old windows of this key are dead weight.
  delete from public.mcp_rate where key = p_key and window_start < v_window;
  return v_hits <= p_limit;
end;
$$;
revoke all on function public.mcp_rate_take(text, int, int) from public, anon, authenticated;
grant execute on function public.mcp_rate_take(text, int, int) to service_role;

-- A refresh token spent exactly once: marks it used and returns its grant, or null when it was
-- already spent, expired or unknown (the caller then revokes on reuse).
create function public.mcp_spend_refresh(p_hash text)
returns table (grant_id uuid, reused boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.mcp_tokens;
begin
  select * into v_row from public.mcp_tokens t where t.token_hash = p_hash and t.kind = 'refresh' for update;
  if not found then
    return;
  end if;
  if v_row.used_at is not null then
    return query select v_row.grant_id, true;
    return;
  end if;
  if v_row.expires_at <= now() then
    return;
  end if;
  update public.mcp_tokens set used_at = now() where token_hash = p_hash;
  return query select v_row.grant_id, false;
end;
$$;
revoke all on function public.mcp_spend_refresh(text) from public, anon, authenticated;
grant execute on function public.mcp_spend_refresh(text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Reads as a user. Every function: security definer, search_path '', service role only, and the
-- same predicate as the table's select policy, evaluated for p_user.

-- Act as p_user until the end of the transaction (the one PostgREST request): auth.uid() and
-- auth.role() then answer for that user inside the predicates. Never granted to anyone.
create function public.mcp_act_as(p_user uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_user is null then
    raise exception 'mcp: no user' using errcode = '42501';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;
revoke all on function public.mcp_act_as(uuid) from public, anon, authenticated, service_role;

-- The user's spaces (orgs_select + org_members: membership) with their role.
create function public.mcp_orgs(p_user uuid)
returns table (id uuid, name text, kind text, role text)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select o.id, o.name, o.kind, m.role
    from public.orgs o join public.org_members m on m.org_id = o.id and m.user_id = p_user
    where public.is_org_member(o.id);
end;
$$;

-- Meetings the user can see (meetings_select: can_see_meeting), newest first. p_done: finished, real
-- meetings only (what the tools list); p_org / p_ids / p_from / p_to narrow.
create function public.mcp_meetings(p_user uuid, p_org uuid, p_ids uuid[], p_from timestamptz, p_to timestamptz, p_done boolean, p_limit int)
returns setof public.meetings
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select mt.* from public.meetings mt
    where public.can_see_meeting(mt.id)
      and (p_org is null or mt.org_id = p_org)
      and (p_ids is null or mt.id = any(p_ids))
      and (p_from is null or mt.started_at >= p_from)
      and (p_to is null or mt.started_at <= p_to)
      and (not p_done or (mt.status = 'done' and not mt.is_test))
    order by mt.started_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 1000);
end;
$$;

-- Note rows of meetings the user can see (note_items_select: is_meeting_member). p_like: an ilike
-- pattern on the text, or null.
create function public.mcp_note_items(p_user uuid, p_meeting_ids uuid[], p_like text)
returns setof public.note_items
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select n.* from public.note_items n
    where n.meeting_id = any(p_meeting_ids)
      and public.is_meeting_member(n.meeting_id)
      and (p_like is null or n.text ilike p_like)
    order by n.meeting_id, n.position
    limit 5000;
end;
$$;

-- People of the user's spaces (people_select: is_org_member).
create function public.mcp_people(p_user uuid, p_org_ids uuid[])
returns table (id uuid, org_id uuid, name text, role text, member_user_id uuid)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select p.id, p.org_id, p.name, p.role, p.member_user_id from public.people p
    where p.org_id = any(p_org_ids) and public.is_org_member(p.org_id);
end;
$$;

-- Privat contexts (contexts_select, the Privat branch: is_org_member of a Privat space).
create function public.mcp_contexts(p_user uuid, p_org_ids uuid[])
returns table (id uuid, org_id uuid, name text)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select c.id, c.org_id, c.name from public.contexts c
    join public.orgs o on o.id = c.org_id and o.kind = 'privat'
    where c.org_id = any(p_org_ids) and public.is_org_member(c.org_id);
end;
$$;

-- Privat summaries (private_summaries_select: is_meeting_member). p_like as above.
create function public.mcp_private_summaries(p_user uuid, p_meeting_ids uuid[], p_like text)
returns table (meeting_id uuid, summary text, decisions text[], people text[])
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select s.meeting_id, s.summary, s.decisions, s.people from public.private_summaries s
    where s.meeting_id = any(p_meeting_ids) and public.is_meeting_member(s.meeting_id)
      and (p_like is null or s.summary ilike p_like);
end;
$$;

-- Privat tasks (context_tasks_select: is_context_member).
create function public.mcp_context_tasks(p_user uuid, p_context_ids uuid[])
returns table (id uuid, context_id uuid, meeting_id uuid, text text, owner text, done boolean, done_at timestamptz, created_at timestamptz, "position" int)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select t.id, t.context_id, t.meeting_id, t.text, t.owner, t.done, t.done_at, t.created_at, t.position from public.context_tasks t
    where t.context_id = any(p_context_ids) and public.is_context_member(t.context_id);
end;
$$;

-- Reviewed Företag tasks (task_handoffs_select: an approver, or the owner of an approved one).
create function public.mcp_handoffs(p_user uuid, p_org_ids uuid[])
returns table (id uuid, org_id uuid, meeting_id uuid, owner_person_id uuid, text text, due text, due_date date, from_name text, status text, done boolean, created_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return query
    select h.id, h.org_id, h.meeting_id, h.owner_person_id, h.text, h.due, h.due_date, h.from_name, h.status, h.done, h.created_at
    from public.task_handoffs h
    where h.org_id = any(p_org_ids) and h.status in ('pending', 'approved')
      and (
        public.can_approve_handoff(h.meeting_id)
        or (h.status = 'approved' and exists (select 1 from public.people p where p.id = h.owner_person_id and p.member_user_id = (select auth.uid())))
      );
end;
$$;

-- Writes the app makes through the user's own client, made for p_user: the same functions and
-- policies decide (set_task_handoff_done; context_tasks_update: is_context_member).
create function public.mcp_set_handoff_done(p_user uuid, p_id uuid, p_done boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  return public.set_task_handoff_done(p_id, p_done);
end;
$$;

create function public.mcp_set_privat_task_done(p_user uuid, p_id uuid, p_done boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public.mcp_act_as(p_user);
  update public.context_tasks t set done = p_done, done_at = case when p_done then now() else null end
    where t.id = p_id and public.is_context_member(t.context_id);
  return found;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'mcp_orgs(uuid)',
    'mcp_meetings(uuid, uuid, uuid[], timestamptz, timestamptz, boolean, int)',
    'mcp_note_items(uuid, uuid[], text)',
    'mcp_people(uuid, uuid[])',
    'mcp_contexts(uuid, uuid[])',
    'mcp_private_summaries(uuid, uuid[], text)',
    'mcp_context_tasks(uuid, uuid[])',
    'mcp_handoffs(uuid, uuid[])',
    'mcp_set_handoff_done(uuid, uuid, boolean)',
    'mcp_set_privat_task_done(uuid, uuid, boolean)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Retention (the daily cron, /api/cron/alarm): audit rows after 90 days; expired requests, codes
-- and tokens; dead rate windows.
create function public.mcp_cleanup()
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare v_n int := 0; v_k int;
begin
  delete from public.mcp_audit where at < now() - interval '90 days';
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  delete from public.mcp_auth_requests where expires_at < now();
  delete from public.mcp_auth_codes where expires_at < now();
  delete from public.mcp_tokens where expires_at < now() - interval '1 day';
  delete from public.mcp_rate where window_start < now() - interval '1 day';
  return v_n;
end;
$$;
revoke all on function public.mcp_cleanup() from public, anon, authenticated;
grant execute on function public.mcp_cleanup() to service_role;
