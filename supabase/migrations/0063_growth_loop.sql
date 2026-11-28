-- 0063: the growth loop (docs/superpowers/specs/2026-11-27-growth-loop-design.md).
--
-- After a meeting, every attendee WITHOUT an account gets one invite mail ("Johanna bjöd in dig till
-- …") with their own tasks and one button; at most one reminder. Attendees with an account keep the
-- summary flow (0037). Additive only.
--
-- * email_categories() + 'meeting_invite' (0039's one list; lib/email/categories.ts mirrors it).
-- * orgs.invite_attendees (Inställningar, default on) and meetings.invite_attendees (the starter's
--   toggle at Starta, default on).
-- * meeting_calendar_guests: guests of the matched calendar event who are NOT in the people list,
--   written at start (the event only keeps people ids, 0046). Service role only; deleted with the
--   meeting, and 30 days after its end (cleanup_growth_loop, from the cron).
-- * meeting_invites: the ledger (one row per meeting and address, before the mailer is called) and
--   the funnel (sent → clicked → signed up → came back within 7 days). Service role only: guest
--   addresses never sit where members can read them.
-- * meeting_guests: a calendar guest outside the people list who signed in through their invite
--   gets THAT ONE MEETING (a per-meeting grant), never membership. Read-only. Never a private
--   meeting, never in a Privat space; checked at read time, so a meeting made private later drops
--   its guests. Admins see the grants (the meeting's attendee list) and revoke them.
--   The shared visibility functions (can_see_meeting, is_meeting_member, foretag_can_see) are NOT
--   widened: they also gate el_sessions, speaker_map, meeting_events, contexts and the MCP
--   functions. The guest gets extra SELECT policies on exactly what the meeting page reads:
--   meetings and note_items.
-- * claim_meeting_invite(): the claim and the link (people row + membership) or the grant, in one
--   transaction, only for the invited address.
-- * person_may_see_meeting(): the tree rule (0050/0054) for a people row that is not linked yet:
--   an invite is itself access, so a tree förening only mails people who will see the meeting.
-- * meeting_invite_funnel: counts per meeting (operator only).

-- ---------------------------------------------------------------------------------------------
-- The category

create or replace function public.email_categories()
returns text[]
language sql immutable set search_path = ''
as $$ select array['meeting_summary', 'invite', 'private_summary', 'meeting_brief', 'meeting_invite']::text[] $$;

-- ---------------------------------------------------------------------------------------------
-- The switches

alter table public.orgs add column invite_attendees boolean not null default true;
grant update (invite_attendees) on table public.orgs to authenticated;

alter table public.meetings add column invite_attendees boolean not null default true;

-- ---------------------------------------------------------------------------------------------
-- Calendar guests outside the people list

create table public.meeting_calendar_guests (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name text check (name is null or length(name) <= 120),
  response text check (response is null or length(response) <= 20),
  created_at timestamptz not null default now(),
  primary key (meeting_id, email)
);
alter table public.meeting_calendar_guests enable row level security;
revoke all on table public.meeting_calendar_guests from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_calendar_guests to service_role;

-- ---------------------------------------------------------------------------------------------
-- The ledger

create table public.meeting_invites (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- null: a calendar guest outside the people list (the claim gives a per-meeting grant).
  person_id uuid references public.people (id) on delete set null,
  email text check (email is null or (email = lower(btrim(email)) and length(email) between 3 and 254)),
  name text check (name is null or length(name) <= 120),
  source text not null check (source in ('calendar', 'name_round', 'both')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'uncertain', 'skipped')),
  skip_reason text check (skip_reason is null or length(skip_reason) <= 40),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  -- Our own signed redirect (/r/<token>): any GET, scanners included.
  clicked_at timestamptz,
  -- The landing page's beacon: a browser that ran our script.
  clicked_human_at timestamptz,
  reminder_status text check (reminder_status in ('sending', 'sent', 'failed', 'uncertain', 'skipped')),
  reminder_at timestamptz,
  claimed_at timestamptz,
  claimed_by uuid references auth.users (id) on delete set null,
  claim_kind text check (claim_kind in ('new_account', 'existing_account')),
  -- The first signed-in page view 12 h to 7 days after the claim.
  returned_at timestamptz,
  unique (meeting_id, email)
);
create index meeting_invites_org_email_idx on public.meeting_invites (org_id, email, sent_at desc);
create index meeting_invites_reminder_idx on public.meeting_invites (sent_at) where status = 'sent' and reminder_status is null and claimed_at is null;
create index meeting_invites_queued_idx on public.meeting_invites (created_at) where status = 'queued';
create index meeting_invites_claimed_by_idx on public.meeting_invites (claimed_by) where returned_at is null;
alter table public.meeting_invites enable row level security;
revoke all on table public.meeting_invites from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_invites to service_role;

-- ---------------------------------------------------------------------------------------------
-- The per-meeting grant

create table public.meeting_guests (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  invite_id uuid references public.meeting_invites (id) on delete set null,
  -- What the admins see in the attendee list (copied from the invite; members never read the ledger).
  email text not null,
  name text,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  primary key (meeting_id, user_id)
);
create index meeting_guests_user_idx on public.meeting_guests (user_id) where revoked_at is null;
alter table public.meeting_guests enable row level security;
revoke all on table public.meeting_guests from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_guests to service_role;
grant select on table public.meeting_guests to authenticated;

-- Does p_user hold a live grant to p_meeting? Read at every check: not revoked, the meeting not
-- private, not a Privat space.
create function public.guest_can_see_meeting(p_user uuid, p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_user is not null and exists (
    select 1
    from public.meeting_guests g
    join public.meetings mt on mt.id = g.meeting_id
    join public.orgs o on o.id = mt.org_id
    where g.meeting_id = p_meeting_id and g.user_id = p_user and g.revoked_at is null
      and not coalesce(mt.private, false) and o.kind <> 'privat'
  );
$$;
revoke all on function public.guest_can_see_meeting(uuid, uuid) from public, anon;
grant execute on function public.guest_can_see_meeting(uuid, uuid) to authenticated, service_role;

-- Is the caller an admin of the meeting's org? (No RLS detour through meetings.)
create function public.is_meeting_org_admin(p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.meetings mt
    join public.org_members m on m.org_id = mt.org_id and m.user_id = auth.uid() and m.role = 'admin'
    where mt.id = p_meeting_id
  );
$$;
revoke all on function public.is_meeting_org_admin(uuid) from public, anon;
grant execute on function public.is_meeting_org_admin(uuid) to authenticated, service_role;

-- The guest's own grants (live or revoked: the page says the access was removed), and every grant
-- of a meeting to the admins of its org.
create policy meeting_guests_select on public.meeting_guests for select to authenticated
  using (user_id = (select auth.uid()) or public.is_meeting_org_admin(meeting_id));

-- The two tables the meeting page reads. Permissive: OR'ed with the members' policies.
create policy meetings_guest_select on public.meetings for select to authenticated
  using (public.guest_can_see_meeting((select auth.uid()), id));
create policy note_items_guest_select on public.note_items for select to authenticated
  using (public.guest_can_see_meeting((select auth.uid()), meeting_id));

-- Admins only: take a guest's access away (or give it back). False when refused.
create function public.set_meeting_guest_access(p_meeting_id uuid, p_user_id uuid, p_on boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
begin
  select mt.org_id into v_org from public.meetings mt where mt.id = p_meeting_id;
  if v_org is null or p_on is null or not public.is_meeting_org_admin(p_meeting_id) then
    return false;
  end if;
  update public.meeting_guests
  set revoked_at = case when p_on then null else now() end,
      revoked_by = case when p_on then null else auth.uid() end
  where meeting_id = p_meeting_id and user_id = p_user_id;
  return found;
end;
$$;
revoke all on function public.set_meeting_guest_access(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_meeting_guest_access(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Would this (unlinked) people row see the meeting once linked? The tree rule (0050, 0054) with the
-- person's place instead of an account. Never a private meeting, never a Företag (no invites
-- there in v1: the DPA gate), always in a förening without groups.

create function public.person_may_see_meeting(p_person_id uuid, p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case
      when coalesce(mt.private, false) or o.kind <> 'forening' then false
      when not o.groups_enabled then true
      else exists (
        select 1 from public.groups mine
        where mine.id = p.group_id
          and (
            mt.group_id is null
            or mine.id = mt.group_id
            or (select theirs.depth from public.groups theirs where theirs.id = mt.group_id) > mine.depth
          )
      )
    end
    from public.meetings mt
    join public.orgs o on o.id = mt.org_id
    join public.people p on p.id = p_person_id and p.org_id = mt.org_id
    where mt.id = p_meeting_id
  ), false);
$$;
revoke all on function public.person_may_see_meeting(uuid, uuid) from public, anon, authenticated;
grant execute on function public.person_may_see_meeting(uuid, uuid) to service_role;

-- Which of these addresses belong to an account (a confirmed sign-in address, or an address a
-- förening lists at a person linked to an account)? Lower-cased in, lower-cased out.
create function public.emails_with_account(p_emails text[])
returns setof text
language sql stable security definer set search_path = ''
as $$
  select distinct e from unnest(coalesce(p_emails, '{}')) as e
  where exists (select 1 from auth.users u where lower(btrim(u.email::text)) = e and u.email_confirmed_at is not null)
     or exists (select 1 from public.people p where lower(btrim(p.email)) = e and p.member_user_id is not null);
$$;
revoke all on function public.emails_with_account(text[]) from public, anon, authenticated;
grant execute on function public.emails_with_account(text[]) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The claim (service role, from /in/<token>/klar after the Google sign-in). One transaction:
-- the invite is taken, and the people row linked plus membership, or the per-meeting grant.
--
-- Returns: ok | mismatch (the account's confirmed address is not the invited one: nothing is
-- taken, the token stays usable for the right person) | used (claimed by another account) |
-- expired | gone (the meeting is gone, private now, or the person's address changed) | ok_again
-- (the same account again: no grant is given back after an admin revoked it).
create function public.claim_meeting_invite(p_invite_id uuid, p_user_id uuid, p_new_account boolean)
returns table (outcome text, org_id uuid, meeting_id uuid)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_inv public.meeting_invites;
  v_email text;
  v_private boolean;
  v_kind text;
  v_person_email text;
  v_person_user uuid;
begin
  select * into v_inv from public.meeting_invites i where i.id = p_invite_id for update;
  if not found or v_inv.email is null then
    return query select 'gone'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_inv.claimed_by is not null then
    return query select (case when v_inv.claimed_by = p_user_id then 'ok_again' else 'used' end)::text, v_inv.org_id, v_inv.meeting_id;
    return;
  end if;
  select lower(btrim(u.email::text)) into v_email from auth.users u where u.id = p_user_id and u.email_confirmed_at is not null;
  if v_email is null or v_email <> v_inv.email then
    return query select 'mismatch'::text, v_inv.org_id, v_inv.meeting_id;
    return;
  end if;
  if v_inv.expires_at < now() then
    return query select 'expired'::text, v_inv.org_id, v_inv.meeting_id;
    return;
  end if;
  select coalesce(mt.private, false), o.kind into v_private, v_kind
  from public.meetings mt join public.orgs o on o.id = mt.org_id where mt.id = v_inv.meeting_id;
  if v_kind is null or v_private or v_kind = 'privat' then
    return query select 'gone'::text, v_inv.org_id, v_inv.meeting_id;
    return;
  end if;

  if v_inv.person_id is not null then
    select lower(btrim(p.email)), p.member_user_id into v_person_email, v_person_user
    from public.people p where p.id = v_inv.person_id and p.org_id = v_inv.org_id;
    if v_person_email is distinct from v_inv.email or (v_person_user is not null and v_person_user <> p_user_id) then
      return query select 'gone'::text, v_inv.org_id, v_inv.meeting_id;
      return;
    end if;
    -- Membership (the join trigger, 0035, links the person with this confirmed address) …
    insert into public.org_members (org_id, user_id, role) values (v_inv.org_id, p_user_id, 'member')
    on conflict (org_id, user_id) do nothing;
    -- … and this row explicitly, when the account isn't linked to another row of the förening.
    update public.people p set member_user_id = p_user_id
    where p.id = v_inv.person_id and p.member_user_id is null
      and not exists (select 1 from public.people q where q.org_id = v_inv.org_id and q.member_user_id = p_user_id);
  else
    insert into public.meeting_guests (meeting_id, user_id, invite_id, email, name)
    values (v_inv.meeting_id, p_user_id, v_inv.id, v_inv.email, v_inv.name)
    on conflict on constraint meeting_guests_pkey do nothing;
  end if;

  update public.meeting_invites i
  set claimed_at = now(), claimed_by = p_user_id, claim_kind = case when p_new_account then 'new_account' else 'existing_account' end
  where i.id = v_inv.id;
  return query select 'ok'::text, v_inv.org_id, v_inv.meeting_id;
end;
$$;
revoke all on function public.claim_meeting_invite(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_meeting_invite(uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The funnel (operator only): sent → clicked → signed up → came back within 7 days.

create view public.meeting_invite_funnel
with (security_invoker = true)
as
select
  i.org_id,
  i.meeting_id,
  count(*) filter (where i.status = 'sent') as sent,
  count(*) filter (where i.reminder_status = 'sent') as reminded,
  count(*) filter (where i.clicked_at is not null) as clicked,
  count(*) filter (where i.clicked_human_at is not null) as clicked_human,
  count(*) filter (where i.claimed_at is not null) as signed_up,
  count(*) filter (where i.returned_at is not null) as returned_7d
from public.meeting_invites i
group by i.org_id, i.meeting_id;
revoke all on table public.meeting_invite_funnel from anon, authenticated, service_role;
grant select on table public.meeting_invite_funnel to service_role;

-- ---------------------------------------------------------------------------------------------
-- Retention (the cron): calendar guests 30 days after the meeting's end; an unclaimed invite's
-- address and name after 90 days (the counts stay for the funnel).

create function public.cleanup_growth_loop()
returns table (guests_deleted bigint, invites_cleared bigint)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_guests bigint;
  v_invites bigint;
begin
  delete from public.meeting_calendar_guests g
  using public.meetings mt
  where mt.id = g.meeting_id and mt.ended_at < now() - interval '30 days';
  get diagnostics v_guests = row_count;
  update public.meeting_invites i set email = null, name = null
  where i.email is not null and i.claimed_at is null and i.created_at < now() - interval '90 days';
  get diagnostics v_invites = row_count;
  return query select v_guests, v_invites;
end;
$$;
revoke all on function public.cleanup_growth_loop() from public, anon, authenticated;
grant execute on function public.cleanup_growth_loop() to service_role;

-- ---------------------------------------------------------------------------------------------
-- The meeting's event log: one 'invites' event per run (counts only, never addresses).

alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed', 'test_started', 'paused', 'unpaused', 'name_round', 'final_without_claude',
    'agenda_anchored', 'format_learned', 'followup_prefilled', 'checkin', 'summary', 'end_tasks', 'task_setting',
    'invites'
  )
);
