-- Org dashboard (todo #2, docs/superpowers/specs/2026-11-26-org-dashboard-proposal.md):
-- agenda item labels on meetings, and the förening's approved goals.
-- Strictly additive and backward compatible with the deployed code: one new column with a default
-- (old code never names it), two new tables and three new functions.

-- ---------------------------------------------------------------------------------------------
-- meetings.agenda_labels: `ag-<n>` → the agenda item's label, as scanned from the Doc at start
-- (and when a tick adds an item). Only labels that pass the format-learning filter are stored
-- (≤ 8 words, no digits, no person's name): structure, never content. Members read it like the
-- rest of the meeting row (table-level select grant, meetings_select policy).

alter table public.meetings add column agenda_labels jsonb not null default '{}'::jsonb;

-- Service role only: merges labels into a meeting's map in one statement (a start and a tick
-- never overwrite each other's keys). Returns false when the meeting does not exist.
create function public.merge_agenda_labels(p_meeting_id uuid, p_labels jsonb)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_labels is null or jsonb_typeof(p_labels) <> 'object' then
    return false;
  end if;
  update public.meetings
     set agenda_labels = coalesce(agenda_labels, '{}'::jsonb) || p_labels
   where id = p_meeting_id;
  return found;
end;
$$;

revoke all on function public.merge_agenda_labels(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_agenda_labels(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- org_goals: the förening's approved goals (3–5 proposed by Simon Says, edited and approved by
-- an admin). Proposals are never stored; only the approved set lives here.

create table public.org_goals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  position smallint not null check (position between 0 and 9),
  title text not null check (length(btrim(title)) between 1 and 80),
  why text check (why is null or length(why) <= 240),
  approved_by uuid references auth.users on delete set null,
  approved_at timestamptz not null default now(),
  unique (org_id, position)
);
create index org_goals_org_idx on public.org_goals (org_id, position);

alter table public.org_goals enable row level security;
revoke all on table public.org_goals from anon, authenticated, service_role;
grant select, insert, update, delete on table public.org_goals to service_role;
grant select on table public.org_goals to authenticated;
create policy org_goals_select on public.org_goals for select to authenticated
  using (public.is_org_member(org_id));

-- Admins only: replaces the org's goals with `p_goals` ([{ title, why? }], 0–5, in order).
-- Returns the number of goals stored.
create function public.set_org_goals(p_org_id uuid, p_goals jsonb)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_goal jsonb;
  v_title text;
  v_why text;
  v_pos smallint := 0;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can set goals' using errcode = '42501';
  end if;
  if p_goals is null or jsonb_typeof(p_goals) <> 'array' or jsonb_array_length(p_goals) > 5 then
    raise exception 'goals must be an array of at most 5' using errcode = '22023';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  delete from public.org_goals where org_id = p_org_id;
  for v_goal in select value from jsonb_array_elements(p_goals) loop
    if jsonb_typeof(v_goal) <> 'object' or jsonb_typeof(v_goal -> 'title') is distinct from 'string' then
      raise exception 'each goal needs a title' using errcode = '22023';
    end if;
    v_title := btrim(v_goal ->> 'title');
    v_why := nullif(btrim(coalesce(v_goal ->> 'why', '')), '');
    insert into public.org_goals (org_id, position, title, why, approved_by)
    values (p_org_id, v_pos, v_title, v_why, auth.uid());
    v_pos := v_pos + 1;
  end loop;
  return v_pos;
end;
$$;

revoke all on function public.set_org_goals(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_org_goals(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- goal_proposals: one row per "Föreslå mål" (a Claude call). At most 3 per förening per 24 h, so
-- one admin can never use up the global daily Claude cap that live notes depend on. Rows hold no
-- content (org, who, when); older than 7 days they are removed by the next claim.

create table public.goal_proposals (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs on delete cascade,
  requested_by uuid references auth.users on delete set null,
  at timestamptz not null default now()
);
create index goal_proposals_org_idx on public.goal_proposals (org_id, at desc);

alter table public.goal_proposals enable row level security;
revoke all on table public.goal_proposals from anon, authenticated, service_role;
grant select, insert, update, delete on table public.goal_proposals to service_role;

-- Admins only: claims one of the org's 3 proposals per 24 h. True = go ahead (the row is written),
-- false = the limit is reached. Locks the org row, so concurrent claims cannot both get the last one.
create function public.claim_goal_proposal(p_org_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can ask for goals' using errcode = '42501';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  delete from public.goal_proposals where org_id = p_org_id and at < now() - interval '7 days';
  select count(*) into v_count from public.goal_proposals
   where org_id = p_org_id and at > now() - interval '24 hours';
  if v_count >= 3 then
    return false;
  end if;
  insert into public.goal_proposals (org_id, requested_by) values (p_org_id, auth.uid());
  return true;
end;
$$;

revoke all on function public.claim_goal_proposal(uuid) from public, anon, authenticated;
grant execute on function public.claim_goal_proposal(uuid) to authenticated;
