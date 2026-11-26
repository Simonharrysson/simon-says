-- Protocol import jobs (branch import-batch): the import's progress lives in the database, so
-- the admin can close the page and come back to the same list, and large imports go to the
-- Anthropic Message Batches API (half price; results arrive when the whole batch ends).
-- Strictly additive: two new tables and four new functions; nothing existing changes.
--
-- Two modes, one shape:
--   'direct' (≤ 20 meetings): the admin's browser reads a few meetings at a time, one request
--            per meeting (the 0032 claim: 60 per förening per 24 h). Pauses if the page closes;
--            resumes from these rows.
--   'batch'  (> 20 meetings): the server reads every Doc once, sends all meetings in ONE
--            Anthropic batch and stores no text. The 5-minute import cron polls the batch,
--            saves the results through save_history_protocol_as (the same cleaning and checks as
--            the direct path, done in the app), then runs the goals digest ONCE and stores the
--            proposal on the job (`proposal`): the only place a proposal is stored. It is made of
--            already-cleaned, name-free lines and goes away with the job.
--
-- What is stored: no protocol text, no Doc title. Each item keeps `label`, the Drive FILE name
-- the admin ticked ("Styrelsemöte 3 mars, möte 2 av 4"), so the list reads the same when they
-- come back. It is deleted with the job: 7 days after the job ended (cleanup in the cron and
-- in delete_old_history_import_jobs), or at once when the admin removes the imported protocols.

create table public.history_import_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  created_by uuid references auth.users on delete set null,
  mode text not null check (mode in ('direct', 'batch')),
  -- running: meetings are being read · canceling: the admin cancelled a batch, Anthropic is
  -- stopping it · digesting: every result is saved, the goals digest is next · done / canceled /
  -- failed: finished (failure says why).
  status text not null default 'running' check (status in ('running', 'canceling', 'digesting', 'done', 'canceled', 'failed')),
  -- Read with the import's drive.readonly grant (folder browser) or the sign-in grant (Picker).
  via_listing boolean not null default false,
  total smallint not null check (total between 1 and 500),
  estimate_usd numeric(10, 4) not null default 0 check (estimate_usd >= 0),
  cost_usd numeric(10, 4) not null default 0,
  batch_id text check (batch_id is null or batch_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  -- Anthropic's request_counts, as last polled: { processing, succeeded, errored, canceled, expired }.
  counts jsonb,
  polled_at timestamptz,
  -- One worker at a time (cron or the status request): saving results and the digest.
  lease_until timestamptz,
  proposal jsonb,
  proposal_error text check (proposal_error is null or length(proposal_error) <= 40),
  failure text check (failure is null or length(failure) <= 40),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  finished_at timestamptz,
  -- The admin closed the finished view: the Översikt stops showing it.
  seen_at timestamptz
);
create index history_import_jobs_org_idx on public.history_import_jobs (org_id, created_at desc);
create index history_import_jobs_open_idx on public.history_import_jobs (status) where status in ('running', 'canceling', 'digesting');

create table public.history_import_items (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.history_import_jobs on delete cascade,
  org_id uuid not null references public.orgs on delete cascade,
  position smallint not null check (position between 0 and 999),
  drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  section smallint not null default 0 check (section between 0 and 59),
  sections smallint not null default 1 check (sections between 1 and 60),
  label text not null check (length(label) between 1 and 240),
  -- waiting · reading (direct: a request is running; batch: the batch has it) · done ·
  -- skipped (never sent: own Doc, empty, too long, cancelled) · failed (sent, no usable answer).
  state text not null default 'waiting' check (state in ('waiting', 'reading', 'done', 'skipped', 'failed')),
  reason text check (reason is null or length(reason) <= 40),
  -- Batch only, captured when the Docs were read (the cron has no Google grant): the section's
  -- dated heading, whether its year was inferred, and the Drive file's creation date.
  heading_date date,
  date_inferred boolean not null default false,
  file_date date,
  protocol_id uuid references public.history_protocols on delete set null,
  meeting_date date,
  date_from text check (date_from is null or date_from in ('doc', 'file', 'admin')),
  attempts smallint not null default 0,
  usd numeric(10, 4),
  started_at timestamptz,
  finished_at timestamptz,
  unique (job_id, position)
);
create index history_import_items_job_idx on public.history_import_items (job_id, position);

-- Admins of the förening read their jobs (the progress view); nobody writes directly: the
-- server writes with the service role after its own admin check, and the functions below.
alter table public.history_import_jobs enable row level security;
alter table public.history_import_items enable row level security;
revoke all on table public.history_import_jobs from anon, authenticated, service_role;
revoke all on table public.history_import_items from anon, authenticated, service_role;
grant select, insert, update, delete on table public.history_import_jobs to service_role;
grant select, insert, update, delete on table public.history_import_items to service_role;
grant select on table public.history_import_jobs to authenticated;
grant select on table public.history_import_items to authenticated;
create policy history_import_jobs_select on public.history_import_jobs for select to authenticated
  using (public.is_org_admin(org_id));
create policy history_import_items_select on public.history_import_items for select to authenticated
  using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------------------------
-- Service role only (the server checked that the caller is an admin): creates a job with its
-- items. `p_items`: [{ drive_file_id, section, sections, label, state?, reason?, heading_date?,
-- date_inferred?, file_date? }] in order. Refuses (returns null with `p_reason` codes via
-- exception) when:
--   - another job of the förening is still running ('busy');
--   - batch: the förening's batch imports in the last 24 h plus this one pass 500 meetings
--     ('rate_limited');
--   - batch: the estimates of every batch still in flight (all föreningar) plus this one pass
--     `p_spend_room` USD, what the server says is left of today's Claude budget for imports
--     ('spend'). A global advisory lock makes two concurrent creates see each other.
-- A direct job left running (the page was closed) is cancelled by a new one: its waiting items
-- are skipped. Returns the job id.
create function public.create_history_import_job(
  p_org_id uuid,
  p_created_by uuid,
  p_mode text,
  p_via_listing boolean,
  p_estimate_usd numeric,
  p_spend_room numeric,
  p_items jsonb
)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_total integer;
  v_sent integer;
  v_recent integer;
  v_inflight numeric;
  v_item jsonb;
  v_pos smallint := 0;
begin
  if p_mode not in ('direct', 'batch') then
    raise exception 'bad mode' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'items must be an array of 1..500' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_items);
  select count(*) into v_sent from jsonb_array_elements(p_items) e where coalesce(e ->> 'state', 'waiting') = 'waiting';

  perform pg_advisory_xact_lock(hashtextextended('history_import_jobs', 0));
  perform 1 from public.orgs o where o.id = p_org_id for update;

  -- A direct job whose page was closed: the new import replaces it.
  update public.history_import_items i set state = 'skipped', reason = 'replaced', finished_at = now()
   where i.state in ('waiting', 'reading')
     and i.job_id in (select j.id from public.history_import_jobs j where j.org_id = p_org_id and j.mode = 'direct' and j.status = 'running');
  update public.history_import_jobs set status = 'canceled', finished_at = now()
   where org_id = p_org_id and mode = 'direct' and status = 'running';

  if exists (select 1 from public.history_import_jobs where org_id = p_org_id and status in ('running', 'canceling', 'digesting')) then
    raise exception 'busy' using errcode = 'P0001', hint = 'busy';
  end if;

  if p_mode = 'batch' then
    select coalesce(sum(total), 0) into v_recent from public.history_import_jobs
     where org_id = p_org_id and mode = 'batch' and created_at > now() - interval '24 hours' and status <> 'failed';
    if v_recent + v_sent > 500 then
      raise exception 'rate_limited' using errcode = 'P0001', hint = 'rate_limited';
    end if;
    select coalesce(sum(estimate_usd), 0) into v_inflight from public.history_import_jobs
     where mode = 'batch' and status in ('running', 'canceling', 'digesting');
    if p_spend_room is null or v_inflight + coalesce(p_estimate_usd, 0) > p_spend_room then
      raise exception 'spend' using errcode = 'P0001', hint = 'spend';
    end if;
  end if;

  insert into public.history_import_jobs (org_id, created_by, mode, via_listing, total, estimate_usd)
  values (p_org_id, p_created_by, p_mode, coalesce(p_via_listing, false), v_total, coalesce(p_estimate_usd, 0))
  returning id into v_id;

  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into public.history_import_items
      (job_id, org_id, position, drive_file_id, section, sections, label, state, reason, heading_date, date_inferred, file_date, finished_at)
    values (
      v_id,
      p_org_id,
      v_pos,
      v_item ->> 'drive_file_id',
      coalesce((v_item ->> 'section')::smallint, 0),
      coalesce((v_item ->> 'sections')::smallint, 1),
      left(btrim(v_item ->> 'label'), 240),
      coalesce(v_item ->> 'state', 'waiting'),
      v_item ->> 'reason',
      nullif(v_item ->> 'heading_date', '')::date,
      coalesce((v_item ->> 'date_inferred')::boolean, false),
      nullif(v_item ->> 'file_date', '')::date,
      case when coalesce(v_item ->> 'state', 'waiting') = 'skipped' then now() end
    );
    v_pos := v_pos + 1;
  end loop;
  return v_id;
end;
$$;

revoke all on function public.create_history_import_job(uuid, uuid, text, boolean, numeric, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.create_history_import_job(uuid, uuid, text, boolean, numeric, numeric, jsonb) to service_role;

-- Service role only: save_history_protocol (0032) for the import cron, which has no user. The
-- server already holds the job (created by an admin); `p_imported_by` is the job's creator.
-- Same checks and replace semantics as save_history_protocol.
create function public.save_history_protocol_as(
  p_org_id uuid,
  p_imported_by uuid,
  p_drive_file_id text,
  p_section smallint,
  p_sections smallint,
  p_meeting_date date,
  p_date_from text,
  p_items jsonb
)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_item jsonb;
  v_pos smallint := 0;
begin
  if p_meeting_date > current_date then
    raise exception 'meeting date in the future' using errcode = '22023';
  end if;
  if p_sections is null or p_sections < 1 or p_section is null or p_section < 0 or p_section >= p_sections then
    raise exception 'bad section' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'items must be an array of at most 200' using errcode = '22023';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  delete from public.history_protocols
   where org_id = p_org_id and drive_file_id = p_drive_file_id and (section = p_section or section >= p_sections);
  insert into public.history_protocols (org_id, drive_file_id, section, meeting_date, date_from, imported_by)
  values (p_org_id, p_drive_file_id, p_section, p_meeting_date, p_date_from, p_imported_by)
  returning id into v_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'text') is distinct from 'string' then
      raise exception 'each item needs a text' using errcode = '22023';
    end if;
    insert into public.history_items (protocol_id, org_id, position, kind, text, topic, owner, done)
    values (
      v_id,
      p_org_id,
      v_pos,
      v_item ->> 'kind',
      btrim(v_item ->> 'text'),
      nullif(btrim(coalesce(v_item ->> 'topic', '')), ''),
      nullif(btrim(coalesce(v_item ->> 'owner', '')), ''),
      case jsonb_typeof(v_item -> 'done') when 'boolean' then (v_item ->> 'done')::boolean else null end
    );
    v_pos := v_pos + 1;
  end loop;
  return v_id;
end;
$$;

revoke all on function public.save_history_protocol_as(uuid, uuid, text, smallint, smallint, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_history_protocol_as(uuid, uuid, text, smallint, smallint, date, text, jsonb) to service_role;

-- Service role only: takes the job's lease for `p_seconds` (saving results, the digest) when
-- nobody holds it. True = this caller may work on the job now.
create function public.lease_history_import_job(p_job_id uuid, p_seconds integer)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  update public.history_import_jobs set lease_until = now() + make_interval(secs => greatest(10, least(p_seconds, 900)))
   where id = p_job_id and (lease_until is null or lease_until < now());
  return found;
end;
$$;

revoke all on function public.lease_history_import_job(uuid, integer) from public, anon, authenticated;
grant execute on function public.lease_history_import_job(uuid, integer) to service_role;

-- Service role only (the cron): removes finished jobs (and their file names) after 7 days.
create function public.delete_old_history_import_jobs()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.history_import_jobs
   where status in ('done', 'canceled', 'failed') and coalesce(finished_at, created_at) < now() - interval '7 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.delete_old_history_import_jobs() from public, anon, authenticated;
grant execute on function public.delete_old_history_import_jobs() to service_role;
