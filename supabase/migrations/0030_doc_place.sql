-- Docs live in the förening (audit 2026-11-26 item 2): the meeting folder's name, and which
-- members a meeting's Doc has been shared with.
-- Strictly additive and backward compatible with the deployed code: one nullable column, one new
-- table (old code never names either) and a backfill into that new table only.

-- ---------------------------------------------------------------------------------------------
-- orgs.meeting_folder_name: the folder's name as the Google Picker returned it when an admin
-- picked it, so the förening page can name the folder without a Drive call per page view. The
-- förening's own text: shown in the UI, never logged. Null for a folder picked before 0030 (or
-- set from a learned format's Doc), which the UI shows as "mötesmapp vald".

alter table public.orgs add column meeting_folder_name text
  check (meeting_folder_name is null or length(meeting_folder_name) between 1 and 200);
-- orgs uses column-level update grants (0002, 0023); orgs_update lets admins only.
grant update (meeting_folder_name) on table public.orgs to authenticated;

-- ---------------------------------------------------------------------------------------------
-- meeting_doc_shares: a member the meeting's Doc was shared with as writer by Simon Says (at the
-- start, when they joined later, or when they asked on the förening page). The org page shows the
-- "Dokument" link only to the starter and to members with a row here, so nobody gets Google's
-- access-denied page. Written by the service role only; members read their own rows.

create table public.meeting_doc_shares (
  meeting_id uuid not null references public.meetings on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  shared_at timestamptz not null default now(),
  primary key (meeting_id, user_id)
);
create index meeting_doc_shares_user_idx on public.meeting_doc_shares (user_id);

alter table public.meeting_doc_shares enable row level security;
revoke all on table public.meeting_doc_shares from anon, authenticated, service_role;
grant select, insert, update, delete on table public.meeting_doc_shares to service_role;
grant select on table public.meeting_doc_shares to authenticated;
create policy meeting_doc_shares_select on public.meeting_doc_shares for select to authenticated
  using (user_id = (select auth.uid()));

-- Backfill: before 0030 a new Doc (not an agenda Doc) was shared at the start with every member
-- of that moment. Record that for members who joined before the meeting started, unless the
-- start logged a failed share (we don't know whose). Everyone else can ask on the org page.
insert into public.meeting_doc_shares (meeting_id, user_id, shared_at)
select mt.id, m.user_id, mt.started_at
  from public.meetings mt
  join public.org_members m on m.org_id = mt.org_id
 where not mt.agenda_doc
   and m.joined_at <= mt.started_at
   and m.user_id is distinct from mt.started_by
   and not exists (
     select 1 from public.meeting_events e
      where e.meeting_id = mt.id
        and e.kind in ('started', 'test_started')
        and jsonb_typeof(e.detail -> 'shareFailed') = 'number'
        and (e.detail ->> 'shareFailed')::numeric > 0
   )
on conflict do nothing;
