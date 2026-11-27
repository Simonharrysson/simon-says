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
-- * meeting_brief_sends: the sent-log, one row per (user, calendar event), claimed BEFORE anything
--   is built or mailed, so two cron runs never mail (or pay Claude) twice;
-- * brief_visible_meetings(): which of a set of meetings a user may see, by the same predicate RLS
--   uses (foretag_can_see, 0050), for the cron that reads with the service role.

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
-- id: never the id, title or guests themselves). Inserted as 'claimed' before the brief is built;
-- then the outcome. A row means "never again" for that event, whatever the outcome (at most once,
-- like the summaries). Service role only; kept 30 days (the cron deletes older rows).

create table public.meeting_brief_sends (
  user_id uuid not null references auth.users (id) on delete cascade,
  event_key text not null check (event_key ~ '^[0-9a-f]{64}$'),
  event_start timestamptz not null,
  scope text not null check (scope in ('org', 'customer')),
  state text not null default 'claimed'
    check (state in ('claimed', 'sent', 'skipped', 'opted_out', 'failed', 'uncertain')),
  -- Claude picked the decisions (true), or the template did (false); null until built.
  picked boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, event_key)
);
create index meeting_brief_sends_created_idx on public.meeting_brief_sends (created_at);

alter table public.meeting_brief_sends enable row level security;
revoke all on table public.meeting_brief_sends from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_brief_sends to service_role;

-- ---------------------------------------------------------------------------------------------
-- The recipient's visibility for the cron (service role, so RLS does not apply): exactly the
-- meetings_select predicate (can_see_meeting = foretag_can_see(auth.uid(), id)), for p_user.

create function public.brief_visible_meetings(p_user uuid, p_ids uuid[])
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select i.id from unnest(coalesce(p_ids, '{}'::uuid[])) as i(id)
  where public.foretag_can_see(p_user, i.id);
$$;

revoke all on function public.brief_visible_meetings(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.brief_visible_meetings(uuid, uuid[]) to service_role;
