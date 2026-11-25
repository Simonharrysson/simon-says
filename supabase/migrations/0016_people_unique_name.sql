-- Task 11 review (I3): one person per name per förening (any case, outer spaces ignored), so
-- the name round and the speaker list's confirmations can add people without duplicates
-- (lib/names/people.ts reads the existing row on a unique violation).
--
-- Backward compatible: the deployed code adds people only from the förening page (a duplicate
-- name now fails there instead of creating a second row; lib/db/orgs.ts treats that as done).
-- Dedupe-safe: if an org already has duplicate names the index is not created (a notice is
-- raised instead of failing the migration); prod has no people yet.

do $$
begin
  if exists (
    select 1 from public.people group by org_id, lower(btrim(name)) having count(*) > 1
  ) then
    raise notice 'people has duplicate names per org: people_org_name_key not created';
  else
    create unique index if not exists people_org_name_key on public.people (org_id, lower(btrim(name)));
  end if;
end
$$;
