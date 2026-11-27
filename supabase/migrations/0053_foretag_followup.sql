-- 0053: Företag follow-up (security re-review lows on 0050).
--
-- 1. A pending handoff whose owner can now see the meeting is withdrawn by deleting it (it was
--    never decided), so it comes back if they lose sight again. A human drop stays dropped.
-- 2. meeting_doc_shares records the Drive permission Simon Says created (permission_id) and the
--    address it went to (email). Revoking removes only that permission, never a share the starter
--    added by hand: when the address already had access before we shared, `preexisting` is set and
--    nothing is ever removed for it. Rows from before 0053 have neither (permission_id null, not
--    preexisting): those were all made on a new Doc Simon Says created, so revoking falls back to
--    the address's non-owner permission as 0050 did (lib/foretag/reconcile.ts).
-- 3. Who sees a meeting also changes outside the app's actions: a person relinked to another
--    account (join, link by e-mail), an account's e-mail changed, an account deleted. Each queues
--    the company for reconcile (foretag_reconcile_queue); a deleted account's Drive permissions are
--    queued by id (doc_share_revocations), since its share rows go with it. The 5-minute cron
--    drains both.

-- ---------------------------------------------------------------------------------------------
-- 1. Handoffs: withdraw by delete

create or replace function public.create_task_handoffs(p_meeting_id uuid, p_owners jsonb)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_n int;
begin
  -- Withdrawn first: a pending handoff whose owner can see the meeting now (they read the task
  -- there). Deleted, not dropped, so it is created again if they lose sight later.
  delete from public.task_handoffs h
  using public.people p
  where h.meeting_id = p_meeting_id and h.status = 'pending' and p.id = h.owner_person_id
    and p.member_user_id is not null and public.foretag_can_see(p.member_user_id, p_meeting_id);

  insert into public.task_handoffs (org_id, meeting_id, item_id, owner_person_id, text, due, due_date, from_user_id, from_name)
  select mt.org_id, mt.id, n.id, p.id, left(btrim(n.text), 500), left(n.due, 100), n.due_date, mt.started_by,
    (select s.name from public.people s where s.org_id = mt.org_id and s.member_user_id = mt.started_by limit 1)
  from public.meetings mt
  join public.orgs o on o.id = mt.org_id and o.kind = 'foretag'
  join jsonb_to_recordset(coalesce(p_owners, '[]'::jsonb)) as w(item_id text, person_id uuid) on true
  join public.note_items n on n.meeting_id = mt.id and n.id = w.item_id
  join public.people p on p.id = w.person_id and p.org_id = mt.org_id and p.member_user_id is not null
  where mt.id = p_meeting_id and mt.status = 'done'
    and n.section = 'action' and not n.deleted_by_human and not coalesce(n.done, false)
    and length(btrim(n.text)) between 1 and 500
    and not public.foretag_can_see(p.member_user_id, mt.id)
  on conflict (meeting_id, item_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.create_task_handoffs(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_task_handoffs(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Which Drive permission is ours

alter table public.meeting_doc_shares
  add column permission_id text check (permission_id is null or length(permission_id) between 1 and 200),
  add column email text check (email is null or length(email) between 3 and 320),
  add column preexisting boolean not null default false;

-- ---------------------------------------------------------------------------------------------
-- 3. Queues for changes made outside the app's actions (service role only)

create table public.foretag_reconcile_queue (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  queued_at timestamptz not null default now()
);
alter table public.foretag_reconcile_queue enable row level security;
revoke all on table public.foretag_reconcile_queue from anon, authenticated, service_role;
grant select, insert, update, delete on table public.foretag_reconcile_queue to service_role;

create table public.doc_share_revocations (
  id uuid primary key default gen_random_uuid(),
  doc_id text not null,
  -- The meeting's starter: their grant owns the Doc. Gone with their account (nothing to revoke with).
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  permission_id text not null,
  attempts int not null default 0,
  queued_at timestamptz not null default now()
);
alter table public.doc_share_revocations enable row level security;
revoke all on table public.doc_share_revocations from anon, authenticated, service_role;
grant select, insert, update, delete on table public.doc_share_revocations to service_role;

create function public.queue_foretag_reconcile(p_org uuid)
returns void
language sql volatile security definer set search_path = ''
as $$
  insert into public.foretag_reconcile_queue (org_id)
  select o.id from public.orgs o where o.id = p_org and o.kind = 'foretag'
  on conflict (org_id) do nothing;
$$;
revoke all on function public.queue_foretag_reconcile(uuid) from public, anon, authenticated;

-- A person linked, unlinked, relinked, moved or deleted.
create function public.people_queue_reconcile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.member_user_id is not null then perform public.queue_foretag_reconcile(old.org_id); end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.member_user_id is not null then perform public.queue_foretag_reconcile(new.org_id); end if;
    return new;
  end if;
  if new.member_user_id is distinct from old.member_user_id or new.group_id is distinct from old.group_id then
    perform public.queue_foretag_reconcile(new.org_id);
  end if;
  return new;
end;
$$;
revoke all on function public.people_queue_reconcile() from public, anon, authenticated;

create trigger people_queue_reconcile
  after insert or update of member_user_id, group_id or delete on public.people
  for each row execute function public.people_queue_reconcile();

-- An account's e-mail changed: every company it belongs to.
create function public.users_email_queue_reconcile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    insert into public.foretag_reconcile_queue (org_id)
    select o.id from public.org_members m join public.orgs o on o.id = m.org_id and o.kind = 'foretag'
    where m.user_id = new.id
    on conflict (org_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.users_email_queue_reconcile() from public, anon, authenticated;

create trigger users_email_queue_reconcile
  after update of email on auth.users
  for each row execute function public.users_email_queue_reconcile();

-- A share row gone because its account was deleted (the cascade runs after the user row is
-- gone): our permission on a Företag Doc is queued for removal by id.
create function public.doc_share_queue_revocation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.permission_id is not null and not exists (select 1 from auth.users u where u.id = old.user_id) then
    insert into public.doc_share_revocations (doc_id, owner_user_id, permission_id)
    select mt.doc_id, mt.started_by, old.permission_id
    from public.meetings mt
    join public.orgs o on o.id = mt.org_id and o.kind = 'foretag'
    where mt.id = old.meeting_id and mt.doc_id is not null and mt.started_by is not null and mt.started_by <> old.user_id;
  end if;
  return old;
end;
$$;
revoke all on function public.doc_share_queue_revocation() from public, anon, authenticated;

create trigger doc_share_queue_revocation
  after delete on public.meeting_doc_shares
  for each row execute function public.doc_share_queue_revocation();
