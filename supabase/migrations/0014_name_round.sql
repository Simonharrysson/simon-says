-- Task 11: the name round and the speaker list. Additive and backward compatible.
--
-- * el_sessions.name_round_at: when the name round last started for this ElevenLabs session
--   (claimed before the Claude call, so a tick and the page's "Klar" never run it twice at once).
--   Null: not run yet. Existing rows stay null; the deployed code never reads it.
-- * meeting_events kind 'name_round': one event per round (ok or failed, counts, cost).
-- * meeting_speakers(meeting): the raw labels heard per session with their first time and talk
--   time, aggregated in the database (the live page polls it). Server (service_role) only.

alter table public.el_sessions add column if not exists name_round_at timestamptz;

alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed', 'test_started', 'paused', 'unpaused', 'name_round'
  )
);

create function public.meeting_speakers(p_meeting_id uuid)
returns table (el_session_id text, speaker text, first_ms bigint, talk_ms bigint)
language sql stable security invoker set search_path = ''
as $$
  select s.el_session_id, s.speaker, min(s.start_ms), sum(s.end_ms - s.start_ms)::bigint
  from public.segments s
  where s.meeting_id = p_meeting_id
  group by s.el_session_id, s.speaker
$$;

revoke all on function public.meeting_speakers(uuid) from public, anon, authenticated;
grant execute on function public.meeting_speakers(uuid) to service_role;
