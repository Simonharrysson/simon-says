-- Meeting titles (förening page, the meeting list): a short title per meeting ("Budget och
-- prova-på-kväll"), shown as the list's main line with the date under it.
--
-- Strictly additive and backward compatible: one nullable column old code never names. Written by
-- the server only (service role), in the final notes pass: Claude's answer to that pass carries the
-- title, no extra call. Read by members through the table-level select grant (0002) and the
-- meetings_select policy; authenticated has no update grant on meetings, so nobody else writes it.
-- A meeting without a title shows its calendar event's title, its agenda topics or only its date
-- (lib/meetings/title.ts). The förening's text: shown in the UI, never logged.

alter table public.meetings
  add column title text
    check (title is null or (char_length(title) between 1 and 80 and position(chr(10) in title) = 0));
