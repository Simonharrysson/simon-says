-- Task 9 fix round 1: the header line the service last wrote, so a header a human typed into
-- is never replaced (compared with the header range's paragraph before each write).
-- Nullable and additive: older code ignores it.
alter table public.meetings add column if not exists header_rendered text;
