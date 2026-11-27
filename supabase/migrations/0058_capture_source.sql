-- 0058: where a meeting was recorded. 'room': the laptop's mic around a table (every meeting so
-- far). 'call': a video call (Google Meet etc.), the call tab's audio shared from the starter's
-- own browser and mixed with their mic; no bot joins and nothing shows to the other participants.
-- It records which consent the starter gave (Förening: "Alla i samtalet vet…"; Företag and
-- Privat: "Jag spelar in samtalet jag själv deltar i"), and lets "Fortsätt mötet" ask for the
-- call tab again after a reload.
alter table public.meetings
  add column if not exists capture_source text not null default 'room'
    constraint meetings_capture_source_check check (capture_source in ('room', 'call'));
