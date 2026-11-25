-- Task R: the 24-month retention promised on /integritet ("Användningsposterna och loggen över
-- skapade föreningar ... sparas i 24 månader"). Deletes usage_daily and org_creations rows older
-- than 24 months. Nothing else: the page names no period for any other table. Additive,
-- idempotent (a second run deletes nothing), service_role only. Called by the daily alarm cron.

create index if not exists org_creations_created_at_idx on public.org_creations (created_at);

create or replace function public.cleanup_retention()
returns table (usage_daily_deleted bigint, org_creations_deleted bigint)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - interval '24 months';
  v_usage bigint;
  v_orgs bigint;
begin
  delete from public.usage_daily u where u.day < (v_cutoff at time zone 'utc')::date;
  get diagnostics v_usage = row_count;
  delete from public.org_creations c where c.created_at < v_cutoff;
  get diagnostics v_orgs = row_count;
  return query select v_usage, v_orgs;
end;
$$;

revoke all on function public.cleanup_retention() from public, anon, authenticated;
grant execute on function public.cleanup_retention() to service_role;
