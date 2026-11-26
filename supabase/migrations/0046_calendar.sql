-- Calendar connection (todo #14): Google Calendar READ-ONLY, optional, per user.
-- Strictly additive and backward compatible: one new table, nullable columns old code never names.

-- ---------------------------------------------------------------------------------------------
-- google_calendar_tokens: the refresh token from a user's incremental calendar.readonly consent
-- ("Koppla kalender"), kept APART from google_tokens (the sign-in token, drive.file, never widened)
-- and from google_import_tokens (drive.readonly, 24 h). Asked without include_granted_scopes, so
-- this token carries only the identity scopes and calendar.readonly. Encrypted by the app like
-- google_tokens (lib/crypto.ts). "Koppla från" deletes the row. Service role only.

create table public.google_calendar_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token_enc text not null,
  scope text not null,
  created_at timestamptz not null default now()
);

alter table public.google_calendar_tokens enable row level security;
revoke all on table public.google_calendar_tokens from anon, authenticated, service_role;
grant select, insert, update, delete on table public.google_calendar_tokens to service_role;

-- ---------------------------------------------------------------------------------------------
-- The förening's meeting calendar (admins choose it among their own calendars): its Google id,
-- the name as shown when chosen, and an optional title filter ("möte"). Each member reads it with
-- their OWN calendar grant; nothing from the calendar is stored here. The förening's text: never logged.

alter table public.orgs
  add column calendar_id text
    check (calendar_id is null or (char_length(calendar_id) between 1 and 300 and calendar_id !~ '\s')),
  add column calendar_name text
    check (calendar_name is null or char_length(calendar_name) between 1 and 200),
  add column calendar_filter text
    check (calendar_filter is null or char_length(calendar_filter) between 1 and 60);

-- orgs uses column-level update grants (0002, 0023, 0030, 0035, 0044); orgs_update lets admins only.
grant update (calendar_id, calendar_name, calendar_filter) on table public.orgs to authenticated;

-- ---------------------------------------------------------------------------------------------
-- meetings.calendar_event: the calendar event the meeting matched at start (read with the
-- starter's grant), as used for the meeting only: { "title": text, "expected": [person ids],
-- "declined": [person ids] }. Attendees are kept only as ids of the förening's people they matched
-- (never e-mails); the title goes into the Doc's name and header. Written by the server.

alter table public.meetings
  add column calendar_event jsonb
    check (calendar_event is null or jsonb_typeof(calendar_event) = 'object');
