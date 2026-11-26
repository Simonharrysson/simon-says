-- The protocol import's own Drive browser (branch import-native): an admin who granted
-- drive.readonly lists folders and the Docs in them. Each listing is one or a few Drive API
-- calls on the admin's own grant; this caps them so a stuck browser tab or a script cannot run
-- the admin's Drive quota (or ours) into the ground. Rows hold no content (no titles, no ids
-- from Drive), only who listed for which förening and when; older than a day they are removed.
-- Strictly additive: one new table and one new function.

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

-- Admins of the förening only: claims one Drive listing. True = go ahead (the row is written),
-- false = the caller has listed 120 times in the last 10 minutes. Per user, not per förening:
-- it is the user's own Drive grant that is spent. A per-user advisory lock means two
-- concurrent claims cannot both take the last one.
create function public.claim_drive_listing(p_org_id uuid)
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
  perform pg_advisory_xact_lock(hashtextextended('drive_listing:' || v_user::text, 0));
  delete from public.drive_listing_claims where user_id = v_user and at < now() - interval '1 day';
  select count(*) into v_count from public.drive_listing_claims
   where user_id = v_user and at > now() - interval '10 minutes';
  if v_count >= 120 then
    return false;
  end if;
  insert into public.drive_listing_claims (org_id, user_id) values (p_org_id, v_user);
  return true;
end;
$$;

revoke all on function public.claim_drive_listing(uuid) from public, anon, authenticated;
grant execute on function public.claim_drive_listing(uuid) to authenticated;
