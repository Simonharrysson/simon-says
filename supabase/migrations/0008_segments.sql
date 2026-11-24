-- Transcript segments: one row per diarized run from ElevenLabs. Additive.
--
-- Key (el_session_id, segment_index, run_index) comes from ElevenLabs only, so a resent batch
-- (crash/resume/retry) hits the same key and is ignored (insert ... on conflict do nothing).
-- Speaker labels are raw and only meaningful within one ElevenLabs session (see speaker_map).
-- start_ms / end_ms are meeting-relative (session-relative + session start - meeting start).
-- tick_no / transcript_written_at are set by the tick (Task 10).
-- Written by the server (service_role) only; members of the meeting's org may read.

create table public.segments (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  el_session_id text not null references public.el_sessions (id) on delete cascade,
  segment_index int not null check (segment_index >= 0),
  run_index int not null check (run_index >= 0),
  speaker text not null,
  text text not null check (length(text) between 1 and 2000),
  start_ms bigint not null check (start_ms >= 0),
  end_ms bigint not null check (end_ms >= start_ms),
  lang text,
  tick_no int,
  transcript_written_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (el_session_id, segment_index, run_index)
);
create index segments_meeting_tick_idx on public.segments (meeting_id, tick_no);
create index segments_meeting_created_idx on public.segments (meeting_id, created_at);

revoke all on table public.segments from anon, authenticated, service_role;
grant select, insert, update, delete on table public.segments to service_role;
grant select on table public.segments to authenticated;

alter table public.segments enable row level security;
create policy segments_select on public.segments for select to authenticated
  using (public.is_meeting_member(meeting_id));
