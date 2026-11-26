-- Create-org limits, split in two (todo #13). Before: org_creations (a lifetime ledger) was
-- counted against 2, so deleting a förening never freed a slot.
--   A. Max 2 EXISTING orgs created by the user (deleting one frees a slot).
--   B. Max 6 creations ever per user in org_creations: keeps create/delete cycles bounded
--      (they burn Claude/ElevenLabs budget).
-- Inserts made with the service_role key (the app does this for ADMIN_EMAILS) skip A and B but
-- are still recorded in the ledger. Same trigger, same error text for A, new text for B.
-- Backward compatible: only replaces the function body.

create or replace function public.orgs_limit_per_creator()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.created_by is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('orgs_limit:' || new.created_by::text));
  if coalesce(auth.role(), '') <> 'service_role' then
    if (select count(*) from public.orgs o where o.created_by = new.created_by) >= 2 then
      raise exception 'org limit reached: max 2 orgs per user' using errcode = 'P0001';
    end if;
    if (select count(*) from public.org_creations c where c.user_id = new.created_by) >= 6 then
      raise exception 'org creation cap reached: max 6 orgs ever per user' using errcode = 'P0001';
    end if;
  end if;
  insert into public.org_creations (org_id, user_id) values (new.id, new.created_by);
  return new;
end;
$$;
revoke all on function public.orgs_limit_per_creator() from public, anon, authenticated;
