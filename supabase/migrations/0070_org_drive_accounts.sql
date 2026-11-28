-- The förening's own Drive account ("Använd ett annat Google-konto"). Most föreningar keep their
-- documents in a Google account of the förening (a Workspace like simon@liuais.com), not in the
-- admin's personal one they sign in with. An admin connects that account once: Google OAuth with
-- the sign-in's own Drive scope (drive.file, never wider), and the förening's meeting Docs are then
-- created, written and shared through it.
-- Strictly additive and backward compatible: one new table, nullable columns old code never names.

-- ---------------------------------------------------------------------------------------------
-- org_drive_accounts: at most one per förening. The refresh token is encrypted by the app like
-- google_tokens (lib/crypto.ts, AES-256-GCM). Service role only: never readable by a client.
--   google_sub    Google's stable account id (from tokeninfo). Meetings and prepared agendas
--                 record it (drive_account_sub below): a Doc is reached with the account that made it.
--   google_email  shown to admins ("Dokumenten ligger i …").
--   folder_id     the meeting folder picked in THIS account's Picker (drive.file only sees a
--                 folder its own grant picked). Docs use the account only while it equals
--                 orgs.meeting_folder_id.
--   lost_at       Google refused the token (revoked or expired): admins see "behöver förnyas";
--                 nothing is written with any other account instead.
-- Deleted with the förening, with the connecting user, and (trigger below) when the connecting user
-- leaves the förening or stops being an admin.

create table public.org_drive_accounts (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  connected_by uuid not null references auth.users (id) on delete cascade,
  google_sub text not null check (char_length(google_sub) between 1 and 255),
  google_email text not null check (char_length(google_email) between 3 and 320),
  refresh_token_enc text not null,
  scope text not null,
  folder_id text check (folder_id is null or folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  lost_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.org_drive_accounts enable row level security;
revoke all on table public.org_drive_accounts from anon, authenticated, service_role;
grant select, insert, update, delete on table public.org_drive_accounts to service_role;

-- ---------------------------------------------------------------------------------------------
-- The connecting admin leaves the förening, or is no longer an admin: the credential goes too.

create function public.drop_org_drive_account_on_admin_loss()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.org_drive_accounts where org_id = old.org_id and connected_by = old.user_id;
    return old;
  end if;
  if old.role = 'admin' and new.role is distinct from 'admin' then
    delete from public.org_drive_accounts where org_id = old.org_id and connected_by = old.user_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.drop_org_drive_account_on_admin_loss() from public, anon, authenticated;

create trigger org_members_drop_drive_account
  after delete or update of role on public.org_members
  for each row execute function public.drop_org_drive_account_on_admin_loss();

-- ---------------------------------------------------------------------------------------------
-- Which Google account made a meeting's (or a prepared agenda's) Doc: the förening's Drive
-- account's google_sub, or null for the starter's own grant (every row before this migration).
-- Written by the server only (meetings: no insert/update grant to authenticated; prepared_agendas:
-- select only).

alter table public.meetings
  add column drive_account_sub text check (drive_account_sub is null or char_length(drive_account_sub) between 1 and 255);

alter table public.prepared_agendas
  add column drive_account_sub text check (drive_account_sub is null or char_length(drive_account_sub) between 1 and 255);

-- ---------------------------------------------------------------------------------------------
-- A deleted account's share on a Doc the förening's account made: revoked through THAT account
-- (the starter's grant would get a 404 and count it as done while the access stayed). The queue
-- (0053/0054) records the Doc's förening and account; the reconcile uses them when set.

alter table public.doc_share_revocations
  add column org_id uuid references public.orgs (id) on delete cascade,
  add column drive_account_sub text check (drive_account_sub is null or char_length(drive_account_sub) between 1 and 255);

create or replace function public.doc_share_queue_revocation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Part of an account deletion: never in its way (any error is a warning).
  begin
    if old.permission_id is not null and not exists (select 1 from auth.users u where u.id = old.user_id) then
      insert into public.doc_share_revocations (doc_id, owner_user_id, permission_id, org_id, drive_account_sub)
      select mt.doc_id, mt.started_by, old.permission_id, mt.org_id, mt.drive_account_sub
      from public.meetings mt
      join public.orgs o on o.id = mt.org_id and (o.kind = 'foretag' or o.groups_enabled)
      where mt.id = old.meeting_id and mt.doc_id is not null and mt.started_by is not null and mt.started_by <> old.user_id;
    end if;
  exception when others then
    raise warning 'doc_share_queue_revocation: % (%)', sqlerrm, sqlstate;
  end;
  return old;
end;
$$;

revoke all on function public.doc_share_queue_revocation() from public, anon, authenticated;
