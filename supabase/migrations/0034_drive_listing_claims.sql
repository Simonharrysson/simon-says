-- The protocol import's own Drive browser (branch import-native).
-- Strictly additive: two new tables and one new function.

-- ---------------------------------------------------------------------------------------------
-- google_import_tokens: the refresh token from an admin's incremental drive.readonly consent,
-- kept APART from google_tokens (whose sign-in token, drive.file only, keeps serving everything
-- else exactly as before). Encrypted by the app like google_tokens (lib/crypto.ts). Used only by
-- the import's routes, and only for 24 hours: the lookup ignores older rows and the 5-minute
-- cron deletes them; "Ta bort läsåtkomst" deletes it at once. Service role only.

create table public.google_import_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token_enc text not null,
  scope text not null,
  created_at timestamptz not null default now()
);

alter table public.google_import_tokens enable row level security;
revoke all on table public.google_import_tokens from anon, authenticated, service_role;
grant select, insert, update, delete on table public.google_import_tokens to service_role;

-- ---------------------------------------------------------------------------------------------
-- drive_listing_claims: each Drive folder listed is one or a few Drive API calls on the admin's
-- own grant; this caps them so a stuck browser tab or a script cannot run the admin's Drive
-- quota (or ours) into the ground. Rows hold no content (no titles, no ids from Drive), only who
-- listed for which förening and when; older than a day they are removed.

create table public.drive_listing_claims (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  at timestamptz not null default now()
);
create index drive_listing_claims_user_idx on public.drive_listing_claims (user_id, at desc);

alter table public.drive_listing_claims enable row level security;
revoke all on table public.drive_listing_claims from anon, authenticated, service_role;
grant select, insert, update, delete on table public.drive_listing_claims to service_role;

-- Admins of the förening only: claims `p_count` folder listings (1–100). True = go ahead (the
-- rows are written), false = the caller would pass 120 in the last 10 minutes. Per user, not
-- per förening: it is the user's own Drive grant that is spent. A per-user advisory lock means
-- two concurrent claims cannot both take the last ones.
create function public.claim_drive_listing(p_org_id uuid, p_count integer default 1)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null or not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can list Drive folders for an import' using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 100 then
    raise exception 'p_count must be 1..100' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('drive_listing:' || v_user::text, 0));
  delete from public.drive_listing_claims where user_id = v_user and at < now() - interval '1 day';
  select count(*) into v_count from public.drive_listing_claims
   where user_id = v_user and at > now() - interval '10 minutes';
  if v_count + p_count > 120 then
    return false;
  end if;
  insert into public.drive_listing_claims (org_id, user_id)
    select p_org_id, v_user from generate_series(1, p_count);
  return true;
end;
$$;

revoke all on function public.claim_drive_listing(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_drive_listing(uuid, integer) to authenticated;
