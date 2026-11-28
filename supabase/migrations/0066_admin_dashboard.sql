-- Internal admin dashboard (/admin, ADMIN_EMAILS only): how Simon Says is used, as counts.
--
-- Two read-only aggregate functions for the service role. They return counts, dates and org
-- names only: never transcripts, notes, task text, e-mail addresses or user ids. Strictly
-- additive (two new functions, nothing else changes).
--
-- * admin_overview(p_now): the KPI tiles, two weekly series and the health line, as one jsonb.
--   p_now is "now" (a parameter so tests can place their seeded rows in a known window).
-- * admin_org_stats(): one row per org (förening, företag, Privat space) with its counts.
--
-- Definitions (the page states them):
-- * an account is a row in auth.users;
-- * active in a window = signed in (auth.users.last_sign_in_at), refreshed a session while using
--   the app (auth.sessions; the session refreshes about hourly while the app is open), or started
--   a meeting (meetings.started_by) in that window. Opening the app is not logged on its own;
-- * meetings never count test meetings (meetings.is_test, Testmöte);
-- * minutes transcribed = usage_daily.seconds (live ElevenLabs sessions; test sessions bill nothing);
-- * weeks are Monday-start weeks in Europe/Stockholm, the last 12 including the current one;
-- * health, last 7 days: Privat summaries that gave up (summary_state 'failed'), summary mails the
--   provider refused (meeting_summary_sends.sent = false), meeting briefs that failed
--   (meeting_brief_sends.state 'failed') and invite mails that failed (org_invite_sends 'failed').

create function public.admin_overview(p_now timestamptz default now())
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with
  activity as (
    select u.last_sign_in_at as at, u.id as user_id from auth.users u where u.last_sign_in_at is not null
    union all
    -- refreshed_at exists on newer Auth versions only: read it through jsonb, fall back to updated_at.
    select coalesce((to_jsonb(s) ->> 'refreshed_at')::timestamptz, s.updated_at, s.created_at), s.user_id
    from auth.sessions s
    union all
    select m.started_at, m.started_by from public.meetings m where m.started_by is not null
  ),
  weeks as (
    select (date_trunc('week', (p_now at time zone 'Europe/Stockholm'))::date - (7 * g)) as week
    from generate_series(0, 11) as g
  ),
  real_meetings as (
    select m.org_id, m.started_at,
           date_trunc('week', (m.started_at at time zone 'Europe/Stockholm'))::date as week
    from public.meetings m
    where not m.is_test and m.started_at <= p_now
  ),
  new_users as (
    select date_trunc('week', (u.created_at at time zone 'Europe/Stockholm'))::date as week
    from auth.users u
    where u.created_at <= p_now
  )
  select jsonb_build_object(
    'users', (select count(*) from auth.users u where u.created_at <= p_now),
    'active7', (select count(distinct a.user_id) from activity a where a.at > p_now - interval '7 days' and a.at <= p_now),
    'active30', (select count(distinct a.user_id) from activity a where a.at > p_now - interval '30 days' and a.at <= p_now),
    'orgs', jsonb_build_object(
      'forening', (select count(*) from public.orgs o where o.kind = 'forening' and o.created_at <= p_now),
      'foretag', (select count(*) from public.orgs o where o.kind = 'foretag' and o.created_at <= p_now),
      'privat', (select count(*) from public.orgs o where o.kind = 'privat' and o.created_at <= p_now)
    ),
    'meetings', (select count(*) from real_meetings),
    'meetings7', (select count(*) from real_meetings r where r.started_at > p_now - interval '7 days'),
    'minutes30', (
      select coalesce(round(sum(u.seconds) / 60.0), 0)::bigint from public.usage_daily u
      where u.day > (p_now at time zone 'utc')::date - 30 and u.day <= (p_now at time zone 'utc')::date
    ),
    'weeks', (
      select jsonb_agg(jsonb_build_object(
        'week', w.week,
        'meetings', (select count(*) from real_meetings r where r.week = w.week),
        'users', (select count(*) from new_users n where n.week = w.week)
      ) order by w.week)
      from weeks w
    ),
    'health', jsonb_build_object(
      'summaries', (
        select count(*) from public.meetings m
        where m.summary_state = 'failed' and m.summary_at > p_now - interval '7 days' and m.summary_at <= p_now
      ),
      'summaryMails', (
        select count(*) from public.meeting_summary_sends s
        where s.sent = false and s.claimed_at > p_now - interval '7 days' and s.claimed_at <= p_now
      ),
      'briefs', (
        select count(*) from public.meeting_brief_sends b
        where b.state = 'failed' and b.updated_at > p_now - interval '7 days' and b.updated_at <= p_now
      ),
      'invites', (
        select count(*) from public.org_invite_sends i
        where i.outcome = 'failed' and i.at > p_now - interval '7 days' and i.at <= p_now
      )
    )
  );
$$;

revoke all on function public.admin_overview(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_overview(timestamptz) to service_role;

-- One row per org: name and kind, how many members, its real meetings and the latest one, when it
-- was made. The id is only a row key for the page (it never links anywhere).
create function public.admin_org_stats()
returns table (
  id uuid,
  name text,
  kind text,
  members bigint,
  meetings bigint,
  last_meeting_at timestamptz,
  created_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select
    o.id,
    o.name,
    o.kind,
    (select count(*) from public.org_members om where om.org_id = o.id),
    (select count(*) from public.meetings m where m.org_id = o.id and not m.is_test),
    (select max(m.started_at) from public.meetings m where m.org_id = o.id and not m.is_test),
    o.created_at
  from public.orgs o
  order by o.created_at desc;
$$;

revoke all on function public.admin_org_stats() from public, anon, authenticated;
grant execute on function public.admin_org_stats() to service_role;
