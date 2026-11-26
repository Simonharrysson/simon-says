-- Invites by e-mail (todo "bjud in via mejl"): an admin types one or more addresses and Simon Says
-- sends each the invite e-mail (design A, lib/invites/email.ts) with the förening's existing join
-- link. Strictly additive: two new tables, three new functions and one new trigger on
-- org_members insert (join_org and the 0035 trigger are untouched).
--
-- Stored: the address (lowercased), who sent it, when, and whether it was delivered to Resend
-- and accepted. No e-mail body. The rows go with the förening (cascade). Only the service role
-- reads or writes them (the route checks that the caller is an admin first, and
-- claim_invite_send checks it again).
--
-- Limits, enforced here in one locking call (claim_invite_send) BEFORE the e-mail goes out:
--   50 sends per förening and 200 per admin in a rolling 24 h (attempts, delivered or not);
--   2 delivered e-mails per address in a rolling 24 h: the invite and one "Skicka igen".
-- A failed send can be tried again right away (it delivered nothing), within the first two.
--
-- Each send carries a Resend Idempotency-Key (`idem_key`): invite id + how many sends of it have
-- a definite outcome. A send whose outcome is unknown (timeout: 'uncertain', or left 'sending' by
-- a crash and swept after 5 minutes) is retried with the SAME key, so Resend never delivers it
-- twice; after a definite 'sent' or 'failed' the next send gets a new key.

create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  email text not null check (
    email = lower(btrim(email)) and length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  invited_by uuid references auth.users on delete set null,
  -- sending: claimed, the e-mail is on its way · sent: Resend took it · failed: it did not ·
  -- uncertain: no answer (timeout); a retry reuses the key · accepted: someone with this
  -- confirmed address joined the förening.
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'uncertain', 'accepted')),
  last_attempt_at timestamptz not null default now(),
  last_sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, email)
);

-- One row per attempt: the rate limits count these.
create table public.org_invite_sends (
  id bigint generated always as identity primary key,
  invite_id uuid not null references public.org_invites on delete cascade,
  org_id uuid not null references public.orgs on delete cascade,
  sent_by uuid references auth.users on delete set null,
  at timestamptz not null default now(),
  -- null while sending; then sent | failed | uncertain (no answer: may have been delivered).
  outcome text check (outcome in ('sent', 'failed', 'uncertain')),
  idem_key text not null
);
create index org_invite_sends_org_idx on public.org_invite_sends (org_id, at);
create index org_invite_sends_user_idx on public.org_invite_sends (sent_by, at);
create index org_invite_sends_invite_idx on public.org_invite_sends (invite_id, at);

alter table public.org_invites enable row level security;
alter table public.org_invite_sends enable row level security;
revoke all on table public.org_invites from anon, authenticated, service_role;
revoke all on table public.org_invite_sends from anon, authenticated, service_role;
grant select, insert, update, delete on table public.org_invites to service_role;
grant select, insert, update, delete on table public.org_invite_sends to service_role;

-- Claims one send before the e-mail goes out. p_resend: the admin pressed "Skicka igen" (or
-- "Försök igen"); without it an address delivered in the last 24 h is `already_invited`.
-- Returns jsonb {"result": ok | forbidden | invalid | member | already_invited | resend_limit |
-- org_limit | user_limit | busy, "send_id"?, "idem_key"?, "next_at"?}.
create function public.claim_invite_send(
  p_org_id uuid, p_user_id uuid, p_email text, p_resend boolean,
  p_org_limit integer, p_user_limit integer, p_address_limit integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_invite public.org_invites%rowtype;
  v_recent integer;
  v_oldest timestamptz;
  v_send bigint;
  v_seq integer;
  v_key text;
begin
  if not exists (select 1 from public.org_members m where m.org_id = p_org_id and m.user_id = p_user_id and m.role = 'admin') then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if length(v_email) not between 3 and 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('result', 'invalid');
  end if;
  -- One claim at a time per förening and per admin, so the counts below hold.
  perform 1 from public.orgs o where o.id = p_org_id for update;
  perform pg_advisory_xact_lock(hashtextextended('org_invite_sends:' || p_user_id::text, 0));

  if exists (
    select 1 from public.org_members m join auth.users u on u.id = m.user_id
    where m.org_id = p_org_id and lower(btrim(u.email)) = v_email
  ) then
    return jsonb_build_object('result', 'member');
  end if;

  select * into v_invite from public.org_invites i where i.org_id = p_org_id and i.email = v_email for update;
  if found then
    if v_invite.status = 'sending' and v_invite.last_attempt_at > now() - interval '2 minutes' then
      return jsonb_build_object('result', 'busy');
    end if;
    select count(*), min(s.at) into v_recent, v_oldest from public.org_invite_sends s
    where s.invite_id = v_invite.id and s.outcome = 'sent' and s.at > now() - interval '24 hours';
    if v_recent > 0 and not p_resend then
      return jsonb_build_object('result', 'already_invited');
    end if;
    if v_recent >= p_address_limit then
      return jsonb_build_object('result', 'resend_limit', 'next_at', v_oldest + interval '24 hours');
    end if;
  end if;

  if (select count(*) from public.org_invite_sends s where s.org_id = p_org_id and s.at > now() - interval '24 hours') >= p_org_limit then
    return jsonb_build_object('result', 'org_limit');
  end if;
  if (select count(*) from public.org_invite_sends s where s.sent_by = p_user_id and s.at > now() - interval '24 hours') >= p_user_limit then
    return jsonb_build_object('result', 'user_limit');
  end if;

  insert into public.org_invites (org_id, email, invited_by, status, last_attempt_at)
  values (p_org_id, v_email, p_user_id, 'sending', now())
  on conflict (org_id, email) do update
    set invited_by = excluded.invited_by, status = 'sending', last_attempt_at = now(), accepted_at = null
  returning * into v_invite;
  select count(*) into v_seq from public.org_invite_sends s where s.invite_id = v_invite.id and s.outcome in ('sent', 'failed');
  insert into public.org_invite_sends (invite_id, org_id, sent_by, idem_key)
  values (v_invite.id, p_org_id, p_user_id, 'invite-' || v_invite.id::text || '-' || v_seq::text)
  returning id, idem_key into v_send, v_key;
  return jsonb_build_object('result', 'ok', 'send_id', v_send, 'idem_key', v_key);
end;
$$;

-- Records how a claimed send went (sent | failed | uncertain). An invite accepted meanwhile stays accepted.
create function public.finish_invite_send(p_send_id bigint, p_outcome text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_invite uuid;
begin
  if p_outcome not in ('sent', 'failed', 'uncertain') then
    raise exception 'unknown outcome' using errcode = '22023';
  end if;
  update public.org_invite_sends set outcome = p_outcome where id = p_send_id and outcome is null returning invite_id into v_invite;
  if v_invite is null then
    return;
  end if;
  update public.org_invites
  set status = case when status = 'accepted' then status else p_outcome end,
      last_sent_at = case when p_outcome = 'sent' then now() else last_sent_at end
  where id = v_invite;
end;
$$;

-- Cron (every 5 min): sends left 'sending' for 5 minutes (the function died) become 'uncertain',
-- so the admin can try again (with the same Idempotency-Key). Returns how many.
create function public.sweep_stale_invite_sends()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.org_invite_sends set outcome = 'uncertain'
  where outcome is null and at < now() - interval '5 minutes';
  update public.org_invites set status = 'uncertain'
  where status = 'sending' and last_attempt_at < now() - interval '5 minutes';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The förening's invites for the admin's list, newest first, with what "Skicka igen" needs.
create function public.org_invite_list(p_org_id uuid)
returns table (
  email text, status text, last_sent_at timestamptz, accepted_at timestamptz,
  recent_sends integer, next_resend_at timestamptz, last_attempt_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select i.email, i.status, i.last_sent_at, i.accepted_at,
    coalesce(r.n, 0)::integer, r.oldest + interval '24 hours', i.last_attempt_at
  from public.org_invites i
  left join lateral (
    select count(*) as n, min(s.at) as oldest from public.org_invite_sends s
    where s.invite_id = i.id and s.outcome = 'sent' and s.at > now() - interval '24 hours'
  ) r on true
  where i.org_id = p_org_id
  order by i.last_attempt_at desc
  limit 200;
$$;

revoke all on function public.claim_invite_send(uuid, uuid, text, boolean, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_invite_send(bigint, text) from public, anon, authenticated;
revoke all on function public.sweep_stale_invite_sends() from public, anon, authenticated;
revoke all on function public.org_invite_list(uuid) from public, anon, authenticated;
grant execute on function public.claim_invite_send(uuid, uuid, text, boolean, integer, integer, integer) to service_role;
grant execute on function public.finish_invite_send(bigint, text) to service_role;
grant execute on function public.sweep_stale_invite_sends() to service_role;
grant execute on function public.org_invite_list(uuid) to service_role;

-- Someone joins: the invite to their CONFIRMED address (trimmed, lowercased) is accepted. An
-- unverified sign-up never marks anything (the same rule as link_person_on_join, 0035).
create function public.accept_invite_on_join()
returns trigger
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_email text;
begin
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = new.user_id and u.email_confirmed_at is not null;
  if v_email is null then
    return null;
  end if;
  update public.org_invites
  set status = 'accepted', accepted_at = now()
  where org_id = new.org_id and email = v_email and status <> 'accepted';
  return null;
end;
$$;
revoke all on function public.accept_invite_on_join() from public, anon, authenticated;

create trigger org_members_accept_invite
  after insert on public.org_members
  for each row execute function public.accept_invite_on_join();
