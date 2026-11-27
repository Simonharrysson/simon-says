-- Gentle concrete tasks: learn how the Avsluta question about Vem / När / Klart när is met.
-- Counts only, never task text (lib/notes/tasks.ts EndStats). Two new meeting_events kinds:
-- * 'end_tasks': one per meeting end that showed the dialog. detail = { incomplete, filled,
--   dismissed, untouched, skipped } (POST /api/meetings/[id]/end, checked by parseEndStats);
-- * 'task_setting': an admin turned the question off ("Fråga inte igen i den här föreningen")
--   or back on (Ångra) from the dialog. detail = { on, from: 'end_dialog' }.
-- Read with the SQL in docs/superpowers/specs/2026-11-26-concrete-tasks-design.md ("Measuring").
-- Additive: keeps every kind up to 0037 and adds the two.

alter table public.meeting_events drop constraint if exists meeting_events_kind_check;
alter table public.meeting_events add constraint meeting_events_kind_check check (
  kind in (
    'tick_ok', 'tick_failed', 'tick_conflict', 'doc_paused', 'reconnect', 'consent', 'alarm', 'started',
    'ended', 'abandoned', 'resumed', 'test_started', 'paused', 'unpaused', 'name_round', 'final_without_claude',
    'agenda_anchored', 'format_learned', 'followup_prefilled', 'checkin', 'summary', 'end_tasks', 'task_setting'
  )
);
