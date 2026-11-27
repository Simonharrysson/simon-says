-- "Hämta styrelsen från webbplatsen" (föreningar): an admin asks the app to read the förening's
-- public website and suggest its board. Each attempt is one row here, so attempts can be limited
-- per förening (a fetch costs a Claude call and hits someone else's server) and failures can be
-- read later. Reason codes only: never page text, names or URLs.
--
-- Strictly additive: a new table and a function, both service role only (RLS on, no policies; the
-- route checks that the caller is an admin before it calls). Nothing existing changes.

create table public.website_fetches (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  at timestamptz not null default now(),
  -- null while running; then 'ok', 'empty' or a failure code (lib/website/board.ts FetchOutcome).
  outcome text check (outcome is null or outcome ~ '^[a-z_]{1,40}$'),
  found integer check (found is null or found between 0 and 100)
);

create index website_fetches_org_at on public.website_fetches (org_id, at desc);

alter table public.website_fetches enable row level security;
revoke all on table public.website_fetches from public, anon, authenticated;
grant select, insert, update on table public.website_fetches to service_role;

-- Claims one attempt for the förening, or refuses when it already had p_hour_limit attempts in the
-- last hour or p_day_limit in the last day. Serialized per förening (an advisory lock), so two
-- clicks at once cannot both slip under the limit. Returns the new row's id, or null when refused.
create function public.claim_website_fetch(p_org_id uuid, p_hour_limit integer, p_day_limit integer)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('website_fetch:' || p_org_id::text, 0));
  if (select count(*) from public.website_fetches where org_id = p_org_id and at > now() - interval '1 hour') >= p_hour_limit
     or (select count(*) from public.website_fetches where org_id = p_org_id and at > now() - interval '1 day') >= p_day_limit then
    return null;
  end if;
  insert into public.website_fetches (org_id) values (p_org_id) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.claim_website_fetch(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_website_fetch(uuid, integer, integer) to service_role;
