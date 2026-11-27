-- The MCP server (docs/superpowers/specs/2026-11-27-mcp-design.md): Simon Says as its own OAuth 2.1
-- authorization server for a user's Claude. Strictly additive; code deployed before this migration
-- finds no table and fails closed (no token is valid).
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
