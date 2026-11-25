-- Task 7: the live page's Paus/Fortsätt is logged per meeting (consent: anyone can ask for a
-- pause). Widening the event kinds only; backward compatible with the deployed code.
alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed', 'test_started', 'paused', 'unpaused'
  )
);
