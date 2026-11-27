-- Inför möten (pre-meeting brief): ~10 minutes before a meeting on the user's linked calendar
-- that is a förening's or a Företag's meeting (its shared calendar) or a meeting with a Företag
-- customer (the guests' e-mail domain), the user gets one short mail: when they last met, the
-- most relevant decisions, open tasks, what was promised, and the prepared agenda. Built by the
-- 5-minute cron (app/api/cron/brief) with the RECIPIENT's own visibility.
--
-- Strictly additive and backward compatible with the deployed code:
-- * a new e-mail category 'meeting_brief' (default on, like every category: the gate stays as in
--   0039; "Inga mejl alls" and the unsubscribe link turn it off);
-- * user_settings.brief_foreningar (default false): briefs for FÖRENING meetings are opt-in on top
--   of the category (Konto → Mejl). Företag briefs need only the category;
-- * meeting_brief_sends: the sent-log, one row per (user, calendar event), claimed under a lease
--   BEFORE anything is built or mailed, so two cron runs never mail (or pay Claude) twice, and a
--   run killed mid-brief (function timeout) leaves a claim a later run may take over;
-- * meeting_brief_checks: when the cron last looked at each user, so every run starts with the
--   longest-waiting users and nobody starves behind the time budget.
-- The recipient's visibility is 0054's visible_meeting_ids() (the RLS predicate for a user).

-- ---------------------------------------------------------------------------------------------
-- E-mail category (0039): replace the one list.

create or replace function public.email_categories()
returns text[]
language sql immutable set search_path = ''
as $$ select array['meeting_summary', 'invite', 'private_summary', 'meeting_brief']::text[] $$;

-- ---------------------------------------------------------------------------------------------
-- The opt-in for förening briefs (own row; read under 0043's RLS, written only through this).

alter table public.user_settings add column brief_foreningar boolean not null default false;

create function public.set_my_brief_foreningar(p_on boolean)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'missing value' using errcode = '22023';
  end if;
  insert into public.user_settings (user_id, brief_foreningar, updated_at)
  values (v_uid, p_on, now())
  on conflict (user_id) do update set brief_foreningar = excluded.brief_foreningar, updated_at = now();
end;
$$;

revoke all on function public.set_my_brief_foreningar(boolean) from public, anon, authenticated;
grant execute on function public.set_my_brief_foreningar(boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- meeting_brief_sends: one row per user and calendar event (event_key = sha256 of the Google event
-- id: never the id, title or guests themselves). Claimed (state 'claimed', lease_until) through
-- claim_meeting_brief() before the brief is built; then the outcome, which is final ("never
-- again" for that event). A claim whose lease ran out (the function died) may be taken over, at
-- most 3 attempts; the mail's Idempotency-Key keeps a retry from delivering twice. Service role
-- only; kept 30 days (the cron deletes older rows).

create table public.meeting_brief_sends (
  user_id uuid not null references auth.users (id) on delete cascade,
  event_key text not null check (event_key ~ '^[0-9a-f]{64}$'),
  event_start timestamptz not null,
  scope text not null check (scope in ('org', 'customer')),
  state text not null default 'claimed'
    check (state in ('claimed', 'sent', 'skipped', 'opted_out', 'failed', 'uncertain')),
  -- Claude picked the decisions (true), or the template did (false); null until built.
  picked boolean,
  lease_until timestamptz,
  attempts int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, event_key)
);
create index meeting_brief_sends_created_idx on public.meeting_brief_sends (created_at);

alter table public.meeting_brief_sends enable row level security;
revoke all on table public.meeting_brief_sends from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_brief_sends to service_role;

-- Claim (or take over an expired claim of) one user's brief for one event. True: the caller owns
-- it until the lease ends. False: done, or another run holds it, or out of attempts.
create function public.claim_meeting_brief(p_user uuid, p_key text, p_start timestamptz, p_scope text, p_lease_seconds int)
returns boolean
language sql volatile security definer set search_path = ''
as $$
  insert into public.meeting_brief_sends as s (user_id, event_key, event_start, scope, lease_until)
  values (p_user, p_key, p_start, p_scope, now() + make_interval(secs => p_lease_seconds))
  on conflict (user_id, event_key) do update
    set lease_until = excluded.lease_until, attempts = s.attempts + 1, updated_at = now()
    where s.state = 'claimed' and s.lease_until < now() and s.attempts < 3
  returning true;
$$;

revoke all on function public.claim_meeting_brief(uuid, text, timestamptz, text, int) from public, anon, authenticated;
grant execute on function public.claim_meeting_brief(uuid, text, timestamptz, text, int) to service_role;

-- ---------------------------------------------------------------------------------------------
-- meeting_brief_checks: when the cron last looked at a user (oldest first next run). Service role.

create table public.meeting_brief_checks (
  user_id uuid primary key references auth.users (id) on delete cascade,
  checked_at timestamptz not null default now()
);

alter table public.meeting_brief_checks enable row level security;
revoke all on table public.meeting_brief_checks from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_brief_checks to service_role;
