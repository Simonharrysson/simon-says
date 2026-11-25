-- Meeting formats A10 fix round 1 (Ruling R-A9): meetings.is_test (0023) defaulted to false, so
-- Testmöten from before 0023 look like real meetings to previousMeeting ("Från förra veckan")
-- and could carry fictional tasks into a real förening's agenda Doc. A meeting is a Testmöte when
-- it logged 'test_started' or has a test ElevenLabs session (el_sessions.kind = 'test', 0011).
-- Additive and idempotent: one service-role-only function (no table change), run once here; it
-- only ever sets false -> true, so running it again changes nothing.

create or replace function public.backfill_test_meetings()
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_count int;
begin
  update public.meetings mt
  set is_test = true
  where not mt.is_test
    and (
      exists (select 1 from public.meeting_events e where e.meeting_id = mt.id and e.kind = 'test_started')
      or exists (select 1 from public.el_sessions s where s.meeting_id = mt.id and s.kind = 'test')
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.backfill_test_meetings() from public, anon, authenticated;
grant execute on function public.backfill_test_meetings() to service_role;

select public.backfill_test_meetings();
