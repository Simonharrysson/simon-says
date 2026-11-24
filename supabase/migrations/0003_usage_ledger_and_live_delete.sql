-- Usage and org creations survive org deletion; live meetings can't be deleted.
--
-- 1. usage_daily no longer cascades from orgs: deleting an org must not erase spend that
--    dayUsd and the global caps rely on. Rows of a deleted org keep its (now dangling) org_id;
--    org_creations maps that id to the user who created it.
-- 2. org_creations: a ledger of every org ever created, never deleted with the org. The
--    2-orgs-per-user limit counts this ledger, so delete-and-recreate doesn't reset it.
-- 3. Meetings (and orgs) can only be deleted when no meeting is live/ending, so open
--    ElevenLabs sessions are settled before their rows disappear.
-- Backward compatible: only drops a FK, adds a table, and tightens two policies.

-- 1 ----------------------------------------------------------------------------------------
alter table public.usage_daily drop constraint if exists usage_daily_org_id_fkey;

-- 2 ----------------------------------------------------------------------------------------
create table public.org_creations (
  org_id uuid primary key, -- no FK: the row outlives the org
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index org_creations_user_id_idx on public.org_creations (user_id);

insert into public.org_creations (org_id, user_id, created_at)
select o.id, o.created_by, o.created_at from public.orgs o where o.created_by is not null
on conflict (org_id) do nothing;

alter table public.org_creations enable row level security;
revoke all on table public.org_creations from anon, authenticated, service_role;
grant select, insert, update, delete on table public.org_creations to service_role;

-- Max 2 orgs ever created per user (deleted ones count). Records the creation in the ledger.
create or replace function public.orgs_limit_per_creator()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.created_by is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('orgs_limit:' || new.created_by::text));
  if (select count(*) from public.org_creations c where c.user_id = new.created_by) >= 2 then
    raise exception 'org limit reached: max 2 orgs per user' using errcode = 'P0001';
  end if;
  insert into public.org_creations (org_id, user_id) values (new.id, new.created_by);
  return new;
end;
$$;
revoke all on function public.orgs_limit_per_creator() from public, anon, authenticated;

-- 3 ----------------------------------------------------------------------------------------
create function public.org_has_active_meeting(p_org_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.meetings mt where mt.org_id = p_org_id and mt.status in ('live', 'ending')
  );
$$;
revoke all on function public.org_has_active_meeting(uuid) from public, anon;
grant execute on function public.org_has_active_meeting(uuid) to authenticated, service_role;

drop policy if exists meetings_delete on public.meetings;
create policy meetings_delete on public.meetings for delete to authenticated
  using (
    status in ('done', 'abandoned')
    and public.is_org_member(org_id)
    and (started_by = (select auth.uid()) or public.is_org_admin(org_id))
  );

drop policy if exists orgs_delete on public.orgs;
create policy orgs_delete on public.orgs for delete to authenticated
  using (public.is_org_admin(id) and not public.org_has_active_meeting(id));
