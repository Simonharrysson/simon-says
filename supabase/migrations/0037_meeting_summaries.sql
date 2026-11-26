-- Meeting summaries by e-mail (Simon's todo: "the people in the förening that missed the meeting get
-- a summary of the meeting. this is the default, but the admins can make it so everybody or
-- selected people get the summary").
--
-- Strictly additive and backward compatible with the deployed code:
-- * new columns with defaults (orgs.summary_mode, people.summary_selected,
--   people.summary_removed_at, meetings.summary_state, meetings.summary_at) that old code never
--   reads;
-- * unsubscribing is NOT here: every summary goes through the e-mail gate of 0039 (category
--   'meeting_summary', may_email; /mejl and the one-click endpoint), so no second opt-out list;
-- * every meeting that has already ended is stamped as handled ('before'), so the first sweep after
--   the deploy never mails the backlog;
-- * a server-only ledger table meeting_summary_sends (one row per meeting and person: at most one
--   e-mail each, ever);
-- * one admin-checked security-definer function for the setting;
-- * meeting_events gets the kind 'summary' (counts only, never content or addresses).

-- ---------------------------------------------------------------------------------------------
-- orgs: who gets the summary. missed = people with an e-mail who were not at the meeting
-- (default), all = everyone with an e-mail, selected = the ticked people, off = nobody.

alter table public.orgs
  add column summary_mode text not null default 'missed'
    check (summary_mode in ('missed', 'all', 'selected', 'off'));

-- ---------------------------------------------------------------------------------------------
-- people: ticked for "Till utvalda personer" (written only through set_summary_settings()).

alter table public.people
  add column summary_selected boolean not null default false,
  -- Set when the linked member is removed from the förening (0018 clears member_user_id) or their
  -- account is deleted: the person stays as a name, but gets no summary by the old address until
  -- they are linked again or an admin sets an e-mail for them.
  add column summary_removed_at timestamptz;

-- Members may update people directly (0002: table-wide grant, any member), so the columns a
-- summary is sent by are guarded here: a client (role authenticated) can neither tick people,
-- clear the removal mark, nor write an e-mail address. E-mail goes only
-- through the admin functions (set_person_email, add_board_person; security definer), so an
-- e-mail-only recipient is always one an admin added. The server (service role) can write all.
create function public.people_guard_summary()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.summary_selected or new.summary_removed_at is not null
        or new.email is not null then
        raise exception 'summary settings and e-mail change only through the admin functions' using errcode = '42501';
      end if;
    elsif new.summary_selected is distinct from old.summary_selected
      or new.summary_removed_at is distinct from old.summary_removed_at
      or new.email is distinct from old.email then
      raise exception 'summary settings and e-mail change only through the admin functions' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.people_guard_summary() from public, anon, authenticated;

create trigger people_guard_summary
  before insert or update on public.people
  for each row execute function public.people_guard_summary();

-- The removal mark. A link cleared while the user is no longer a member of the förening (0018:
-- the membership row is deleted first) or no longer exists is a removal; a link cleared by
-- set_person_email (a new address, the user still a member) is not. Linking again, or an admin
-- setting an e-mail, clears the mark.
create function public.people_mark_removed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.member_user_id is not null or new.email is distinct from old.email then
    new.summary_removed_at := null;
  elsif old.member_user_id is not null and new.member_user_id is null and (
    not exists (select 1 from public.org_members m where m.org_id = old.org_id and m.user_id = old.member_user_id)
    or not exists (select 1 from auth.users u where u.id = old.member_user_id)
  ) then
    new.summary_removed_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.people_mark_removed() from public, anon, authenticated;

-- Runs after the guard (same-timing triggers fire in name order), so the guard only judges what
-- the client wrote, never the mark this trigger sets.
create trigger people_z_mark_removed
  before update of member_user_id, email on public.people
  for each row execute function public.people_mark_removed();

-- ---------------------------------------------------------------------------------------------
-- meetings: whether the summary was handled. null = not yet (the end hook or the 5-minute cron
-- picks it up once the meeting is done and its final pass is written); sending = claimed, e-mails
-- going out (a run that stopped at its deadline or died is resumed by the cron); otherwise why it
-- is done: sent (every recipient was tried), none (nobody to send to), uncertain ("missed" mode but
-- we couldn't tell who was there, e.g. unnamed voices on a shared mic), no_notes, off, test,
-- before (ended before this migration).

alter table public.meetings
  add column summary_state text
    check (summary_state is null or summary_state in ('sending', 'sent', 'none', 'uncertain', 'no_notes', 'off', 'test', 'before')),
  add column summary_at timestamptz;

update public.meetings set summary_state = 'before', summary_at = now()
where status in ('done', 'abandoned', 'ending');

-- The sweep's lookup: done meetings not handled yet.
create index meetings_summary_pending_idx on public.meetings (ended_at)
  where status = 'done' and (summary_state is null or summary_state = 'sending');

-- ---------------------------------------------------------------------------------------------
-- meeting_summary_sends: the per-recipient ledger. A row is inserted BEFORE the e-mail is handed
-- to the mailer, so a retry (or a second sender) never mails the same person twice. No address,
-- no content: the person id says who, sent says whether the provider accepted it.

create table public.meeting_summary_sends (
  meeting_id uuid not null references public.meetings on delete cascade,
  person_id uuid not null references public.people on delete cascade,
  claimed_at timestamptz not null default now(),
  sent boolean,
  primary key (meeting_id, person_id)
);
create index meeting_summary_sends_person_idx on public.meeting_summary_sends (person_id);

alter table public.meeting_summary_sends enable row level security;
revoke all on table public.meeting_summary_sends from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_summary_sends to service_role;

-- ---------------------------------------------------------------------------------------------
-- The setting (Inställningar → "Sammanfattning efter mötet"). Admins only. p_person_ids are the
-- ticked people for 'selected' (ignored for the other modes, so switching back keeps the ticks);
-- ids of other föreningar are refused.

create function public.set_summary_settings(p_org_id uuid, p_mode text, p_person_ids uuid[])
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can change summary settings' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('missed', 'all', 'selected', 'off') then
    raise exception 'unknown summary mode' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_person_ids, '{}'::uuid[])) as x(id)
    where not exists (select 1 from public.people p where p.id = x.id and p.org_id = p_org_id)
  ) then
    raise exception 'person is not in this förening' using errcode = '22023';
  end if;
  update public.orgs set summary_mode = p_mode where id = p_org_id;
  if p_mode = 'selected' then
    update public.people
    set summary_selected = (id = any(coalesce(p_person_ids, '{}'::uuid[])))
    where org_id = p_org_id;
  end if;
end;
$$;

revoke all on function public.set_summary_settings(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.set_summary_settings(uuid, text, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- meeting_events: keep every kind up to 0036 (0023) and add 'summary'.

alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed', 'test_started', 'paused', 'unpaused', 'name_round', 'final_without_claude',
    'agenda_anchored', 'format_learned', 'followup_prefilled', 'checkin', 'summary'
  )
);
