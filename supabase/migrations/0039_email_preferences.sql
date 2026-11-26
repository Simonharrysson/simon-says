-- E-mail preferences (Simon's todo: "a user should be able to turn down all different kinds of
-- emails in settings").
--
-- Strictly additive: two new tables and four functions that old code never reads. Nothing on v1
-- mails users yet (only the operator's ALARM_EMAIL, which is not gated); the meeting summary
-- (0037) and invite (0038) senders call may_email() before every user-facing send.
--
-- Two kinds of rows, one rule:
-- * email_preferences: one row per account (user id), written by the user from Konto
--   (set_my_email_preferences) and read under RLS (own row only).
-- * email_address_preferences: one row per address (trimmed, lowercased), for people without an
--   account (a person on a förening's list, an invited address). Written only by the server, from
--   the signed unsubscribe link (set_email_preferences_for_address). Service role only.
-- No row means every category is on (default all on), so a first invite to an unknown address
-- goes out, but a prior "Inga mejl alls" from that address is honoured.
--
-- The gate (may_email) merges both: the account row of every confirmed account with that address,
-- and the address row of the account's own address. So an "Inga mejl alls" given before signing up
-- still holds after, and a link unsubscribe by someone with an account blocks that account too.
-- Both writers keep the two rows of one person in step, so the settings page shows what the gate
-- does.
--
-- Categories (lib/email/categories.ts is the list the app uses): meeting_summary, invite. Adding a
-- category = a migration that widens the two check constraints.

create table public.email_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  all_off boolean not null default false,
  off_categories text[] not null default '{}'
    check (off_categories <@ array['meeting_summary', 'invite']::text[]),
  updated_at timestamptz not null default now()
);

alter table public.email_preferences enable row level security;
revoke all on table public.email_preferences from anon, authenticated, service_role;
grant select on table public.email_preferences to authenticated;
grant select, insert, update, delete on table public.email_preferences to service_role;

create policy email_preferences_own on public.email_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

create table public.email_address_preferences (
  email text primary key
    check (email = lower(btrim(email)) and length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  all_off boolean not null default false,
  off_categories text[] not null default '{}'
    check (off_categories <@ array['meeting_summary', 'invite']::text[]),
  updated_at timestamptz not null default now()
);

alter table public.email_address_preferences enable row level security;
revoke all on table public.email_address_preferences from anon, authenticated, service_role;
grant select, insert, update, delete on table public.email_address_preferences to service_role;

-- ---------------------------------------------------------------------------------------------
-- What applies to a recipient: the user id when known, the address otherwise (or both). Merges
-- every matching row: any all_off wins, off categories are the union. No row: all on.

create function public.email_preferences_for(p_user_id uuid, p_email text)
returns table (all_off boolean, off_categories text[])
language sql stable security definer set search_path = ''
as $$
  with addrs as (
    select lower(btrim(p_email)) as email where nullif(btrim(p_email), '') is not null
    union
    select lower(btrim(u.email::text)) from auth.users u
    where u.id = p_user_id and u.email is not null and u.email_confirmed_at is not null
  ),
  users as (
    select p_user_id as id where p_user_id is not null
    union
    select u.id from auth.users u join addrs a on lower(btrim(u.email::text)) = a.email
    where u.email_confirmed_at is not null
  ),
  matched as (
    select p.all_off, p.off_categories from public.email_preferences p where p.user_id in (select id from users)
    union all
    select a.all_off, a.off_categories from public.email_address_preferences a where a.email in (select email from addrs)
  )
  select
    coalesce(bool_or(r.all_off), false),
    coalesce(array(select distinct c from matched r2, unnest(r2.off_categories) c order by c), '{}'::text[])
  from matched r;
$$;

revoke all on function public.email_preferences_for(uuid, text) from public, anon, authenticated;
grant execute on function public.email_preferences_for(uuid, text) to service_role;

-- The gate. Every user-facing send asks this first (lib/email/prefs.ts mayEmail).
create function public.may_email(p_user_id uuid, p_email text, p_category text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select not (f.all_off or p_category = any(f.off_categories))
  from public.email_preferences_for(p_user_id, p_email) f;
$$;

revoke all on function public.may_email(uuid, text, text) from public, anon, authenticated;
grant execute on function public.may_email(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Konto → Mejl: the signed-in user's own row. Also updates the address row of their own
-- (confirmed) address, if one exists, so turning a category back on here really turns it on.

create function public.set_my_email_preferences(p_all_off boolean, p_off_categories text[])
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_off text[] := coalesce(p_off_categories, '{}'::text[]);
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_all_off is null or not (v_off <@ array['meeting_summary', 'invite']::text[]) then
    raise exception 'unknown e-mail category' using errcode = '22023';
  end if;
  insert into public.email_preferences (user_id, all_off, off_categories, updated_at)
  values (v_uid, p_all_off, v_off, now())
  on conflict (user_id) do update
    set all_off = excluded.all_off, off_categories = excluded.off_categories, updated_at = now();
  update public.email_address_preferences a
  set all_off = p_all_off, off_categories = v_off, updated_at = now()
  from auth.users u
  where u.id = v_uid and u.email_confirmed_at is not null and a.email = lower(btrim(u.email::text));
end;
$$;

revoke all on function public.set_my_email_preferences(boolean, text[]) from public, anon, authenticated;
grant execute on function public.set_my_email_preferences(boolean, text[]) to authenticated;

-- The unsubscribe page (signed link, no login; the server checks the signature and calls this as
-- the service role). Writes the address row, and the account rows of confirmed accounts with that
-- address: the link proves the inbox, which is what the account is.
create function public.set_email_preferences_for_address(p_email text, p_all_off boolean, p_off_categories text[])
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_off text[] := coalesce(p_off_categories, '{}'::text[]);
begin
  if p_all_off is null or not (v_off <@ array['meeting_summary', 'invite']::text[]) then
    raise exception 'unknown e-mail category' using errcode = '22023';
  end if;
  insert into public.email_address_preferences (email, all_off, off_categories, updated_at)
  values (v_email, p_all_off, v_off, now())
  on conflict (email) do update
    set all_off = excluded.all_off, off_categories = excluded.off_categories, updated_at = now();
  update public.email_preferences p
  set all_off = p_all_off, off_categories = v_off, updated_at = now()
  from auth.users u
  where p.user_id = u.id and u.email_confirmed_at is not null and lower(btrim(u.email::text)) = v_email;
end;
$$;

revoke all on function public.set_email_preferences_for_address(text, boolean, text[]) from public, anon, authenticated;
grant execute on function public.set_email_preferences_for_address(text, boolean, text[]) to service_role;
