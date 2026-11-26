-- Onboarding (todo #5, docs/superpowers/specs/2026-11-26-onboarding-proposal.md): a step-by-step
-- "Kom igång" after "Skapa förening": name & logo, the board as ONE list (people optionally linked
-- to a member account by e-mail), meeting folder, formats (Veckomöte + the stadgar's Styrelsemöte
-- and Årsmöte), old protocols, and voice consent recorded for later.
--
-- Strictly additive and backward compatible with the deployed code:
-- * new table org_onboarding (old code never names it); a row is created for every NEW org by a
--   trigger, so existing föreningar never see the card (they have no row);
-- * new nullable columns (orgs.logo_updated_at, orgs.styrelse_format_id, orgs.arsmote_format_id,
--   people.email, people.voice_consent_at, people.voice_consent_by) that old code never reads;
-- * new security-definer functions; a trigger on org_members insert that only fills
--   people.member_user_id where it is null;
-- * a private storage bucket `org-logos` with policies.

-- ---------------------------------------------------------------------------------------------
-- orgs: logo version + per-meeting-type formats

-- The logo lives at storage `org-logos/<org id>/logo` (a fixed path, never client-supplied); this
-- timestamp says there is one and versions its URL. Written by the logo route (admins only).
alter table public.orgs add column logo_updated_at timestamptz;
grant update (logo_updated_at) on table public.orgs to authenticated;

-- The förening's own Styrelsemöte / Årsmöte formats (from the stadgar), used by Förbered möte when
-- the default format is another kind. Written only through set_type_format().
alter table public.orgs
  add column styrelse_format_id uuid references public.format_profiles on delete set null,
  add column arsmote_format_id uuid references public.format_profiles on delete set null;

-- Admins only: stores an approved, NON-default version of a Styrelsemöte or Årsmöte format and
-- points the org at it, so the org's default (e.g. Veckomöte) stays as it is.
create function public.set_type_format(p_org_id uuid, p_type text, p_profile jsonb)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_kind text;
  v_id uuid;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can set formats' using errcode = '42501';
  end if;
  if p_type = 'styrelsemote' then
    v_kind := 'styrelseprotokoll';
  elsif p_type = 'arsmote' then
    v_kind := 'arsmote';
  else
    raise exception 'unknown meeting type' using errcode = '22023';
  end if;
  if jsonb_typeof(p_profile) <> 'object' or p_profile->>'kind' is distinct from v_kind then
    raise exception 'profile kind does not match the meeting type' using errcode = '22023';
  end if;
  perform 1 from public.orgs o where o.id = p_org_id for update;
  -- The same profile again (a retried save): keep the row the förening already points at.
  select f.id into v_id from public.orgs o
  join public.format_profiles f on f.id = case when p_type = 'styrelsemote' then o.styrelse_format_id else o.arsmote_format_id end
  where o.id = p_org_id and f.profile = p_profile;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.format_profiles (org_id, kind, profile, approved_by, approved_at, is_default)
  values (p_org_id, v_kind, p_profile, auth.uid(), now(), false)
  returning id into v_id;
  if p_type = 'styrelsemote' then
    update public.orgs set styrelse_format_id = v_id where id = p_org_id;
  else
    update public.orgs set arsmote_format_id = v_id where id = p_org_id;
  end if;
  return v_id;
end;
$$;

-- Both from the stadgar in one transaction (onboarding step 4): null leaves that type as it is.
create function public.set_type_formats(p_org_id uuid, p_styrelse jsonb, p_arsmote jsonb)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'only org admins can set formats' using errcode = '42501';
  end if;
  if p_styrelse is not null then
    perform public.set_type_format(p_org_id, 'styrelsemote', p_styrelse);
  end if;
  if p_arsmote is not null then
    perform public.set_type_format(p_org_id, 'arsmote', p_arsmote);
  end if;
end;
$$;

revoke all on function public.set_type_format(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_type_format(uuid, text, jsonb) to authenticated;
revoke all on function public.set_type_formats(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.set_type_formats(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- org_onboarding: where the admin is in "Kom igång". Steps: namn, styrelsen, mapp, format,
-- protokoll, roster. `done` = completed, `skipped` = passed over; the card shows until every step
-- is one of them (completed_at) or an admin hides it (dismissed_at).

create table public.org_onboarding (
  org_id uuid primary key references public.orgs on delete cascade,
  done text[] not null default '{}'
    check (done <@ array['namn', 'styrelsen', 'mapp', 'format', 'protokoll', 'roster']::text[]),
  skipped text[] not null default '{}'
    check (skipped <@ array['namn', 'styrelsen', 'mapp', 'format', 'protokoll', 'roster']::text[]),
  completed_at timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.org_onboarding enable row level security;
revoke all on table public.org_onboarding from anon, authenticated, service_role;
grant select, insert, update, delete on table public.org_onboarding to service_role;
grant select on table public.org_onboarding to authenticated;
grant update (done, skipped, completed_at, dismissed_at, updated_at) on table public.org_onboarding to authenticated;

create policy org_onboarding_select on public.org_onboarding for select to authenticated
  using (public.is_org_member(org_id));
create policy org_onboarding_update on public.org_onboarding for update to authenticated
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- Every new förening starts its onboarding. Existing ones have no row: no card.
create function public.orgs_start_onboarding()
returns trigger
language plpgsql volatile security definer set search_path = ''
as $$
begin
  insert into public.org_onboarding (org_id) values (new.id) on conflict do nothing;
  return null;
end;
$$;
revoke all on function public.orgs_start_onboarding() from public, anon, authenticated;

create trigger orgs_start_onboarding
  after insert on public.orgs
  for each row execute function public.orgs_start_onboarding();

-- ---------------------------------------------------------------------------------------------
-- people: the board list. A person is a name (+ role); an optional e-mail invites them, and the
-- person is linked to their member account (people.member_user_id, since 0002) when someone with
-- that e-mail joins, or right away when they already are a member.

alter table public.people
  add column email text check (
    email is null or (length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  ),
  -- Voice consent recorded during onboarding (step 6), for the voice feature that is still a
  -- spike: when and by whom it was recorded. The feature itself must ask the person again.
  add column voice_consent_at timestamptz,
  add column voice_consent_by uuid references auth.users on delete set null;
create index people_org_email_idx on public.people (org_id, lower(email)) where email is not null;

-- Links a person to the member of their org whose CONFIRMED e-mail (trimmed, lowercased) is
-- p_email, when that member is not linked to anyone else yet. Unconfirmed addresses never link.
create function public.link_person_by_email(p_person_id uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_email text;
  v_user uuid;
begin
  select p.org_id, lower(btrim(p.email)) into v_org, v_email from public.people p
  where p.id = p_person_id and p.member_user_id is null;
  if v_email is null then
    return;
  end if;
  select m.user_id into v_user from public.org_members m
  join auth.users u on u.id = m.user_id
  where m.org_id = v_org and lower(btrim(u.email)) = v_email and u.email_confirmed_at is not null
    and not exists (select 1 from public.people q where q.org_id = v_org and q.member_user_id = m.user_id)
  limit 1;
  if v_user is not null then
    update public.people set member_user_id = v_user where id = p_person_id and member_user_id is null;
  end if;
end;
$$;
revoke all on function public.link_person_by_email(uuid) from public, anon, authenticated;

-- Admins only: set or clear a person's e-mail (invite). A new address that is not the linked
-- account's unlinks it, then links the member with that (confirmed) address, if any. Clearing
-- keeps the link. Returns ok | invalid | taken (another person in the org has it) | forbidden.
create function public.set_person_email(p_person_id uuid, p_email text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_member uuid;
  v_email text := nullif(lower(btrim(p_email)), '');
begin
  if auth.uid() is null then
    return 'forbidden';
  end if;
  select p.org_id, p.member_user_id into v_org, v_member from public.people p where p.id = p_person_id;
  if v_org is null or not public.is_org_admin(v_org) then
    return 'forbidden';
  end if;
  if v_email is not null and (length(v_email) not between 3 and 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    return 'invalid';
  end if;
  if v_email is not null and exists (
    select 1 from public.people p where p.org_id = v_org and p.id <> p_person_id and lower(p.email) = v_email
  ) then
    return 'taken';
  end if;
  update public.people set email = v_email where id = p_person_id;
  if v_email is not null and v_member is not null and not exists (
    select 1 from auth.users u where u.id = v_member and lower(btrim(u.email)) = v_email
  ) then
    update public.people set member_user_id = null where id = p_person_id;
  end if;
  perform public.link_person_by_email(p_person_id);
  return 'ok';
end;
$$;

-- Admins only, ONE transaction (onboarding step 2): adds a board person with role and e-mail,
-- optionally linked to a member nobody has named (p_member_user_id). Returns jsonb:
-- {"result": "ok", "id"} | {"result": "duplicate", "id"} (that name exists: edit it instead) |
-- {"result": "taken" | "invalid" | "forbidden"}. Name and role are validated by the caller too.
create function public.add_board_person(p_org_id uuid, p_name text, p_role text, p_email text, p_member_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_role text := nullif(btrim(p_role), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_id uuid;
begin
  if auth.uid() is null or not public.is_org_admin(p_org_id) then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if length(v_name) not between 1 and 100 or (v_role is not null and length(v_role) not between 1 and 40) then
    return jsonb_build_object('result', 'invalid');
  end if;
  if v_email is not null and (length(v_email) not between 3 and 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    return jsonb_build_object('result', 'invalid');
  end if;
  select p.id into v_id from public.people p where p.org_id = p_org_id and lower(btrim(p.name)) = lower(v_name);
  if v_id is not null then
    return jsonb_build_object('result', 'duplicate', 'id', v_id);
  end if;
  if v_email is not null and exists (select 1 from public.people p where p.org_id = p_org_id and lower(p.email) = v_email) then
    return jsonb_build_object('result', 'taken');
  end if;
  if p_member_user_id is not null and (
    not exists (select 1 from public.org_members m where m.org_id = p_org_id and m.user_id = p_member_user_id)
    or exists (select 1 from public.people q where q.org_id = p_org_id and q.member_user_id = p_member_user_id)
  ) then
    return jsonb_build_object('result', 'invalid');
  end if;
  insert into public.people (org_id, name, role, email, member_user_id)
  values (p_org_id, v_name, v_role, v_email, p_member_user_id)
  returning id into v_id;
  perform public.link_person_by_email(v_id);
  return jsonb_build_object('result', 'ok', 'id', v_id);
exception when unique_violation then
  select p.id into v_id from public.people p where p.org_id = p_org_id and lower(btrim(p.name)) = lower(v_name);
  return jsonb_build_object('result', 'duplicate', 'id', v_id);
end;
$$;
revoke all on function public.add_board_person(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.add_board_person(uuid, text, text, text, uuid) to authenticated;

-- An admin, or the person's own linked member, records (true) or withdraws (false) voice consent.
create function public.set_voice_consent(p_person_id uuid, p_consent boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_member uuid;
begin
  if auth.uid() is null then
    return false;
  end if;
  select p.org_id, p.member_user_id into v_org, v_member from public.people p where p.id = p_person_id;
  -- coalesce: an unlinked person (member_user_id null) must refuse, not make the test null.
  if v_org is null or not (public.is_org_admin(v_org) or coalesce(v_member = auth.uid() and public.is_org_member(v_org), false)) then
    return false;
  end if;
  update public.people
  set voice_consent_at = case when p_consent then now() else null end,
      voice_consent_by = case when p_consent then auth.uid() else null end
  where id = p_person_id;
  return true;
end;
$$;

revoke all on function public.set_person_email(uuid, text) from public, anon, authenticated;
revoke all on function public.set_voice_consent(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_person_email(uuid, text) to authenticated;
grant execute on function public.set_voice_consent(uuid, boolean) to authenticated;

-- Someone joins: the board person invited with their e-mail (and not linked yet) becomes theirs.
create function public.link_person_on_join()
returns trigger
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_email text;
begin
  -- Only a confirmed address links (an unverified sign-up must not claim someone's invite).
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = new.user_id and u.email_confirmed_at is not null;
  if v_email is null then
    return null;
  end if;
  if exists (select 1 from public.people q where q.org_id = new.org_id and q.member_user_id = new.user_id) then
    return null;
  end if;
  update public.people p set member_user_id = new.user_id
  where p.id = (
    select p2.id from public.people p2
    where p2.org_id = new.org_id and lower(btrim(p2.email)) = v_email and p2.member_user_id is null
    limit 1
  );
  return null;
end;
$$;
revoke all on function public.link_person_on_join() from public, anon, authenticated;

create trigger org_members_link_person
  after insert on public.org_members
  for each row execute function public.link_person_on_join();

-- The person's account link goes (member removed, left, account deleted, or e-mail changed):
-- their voice consent goes with it; it is asked again.
create function public.people_clear_voice_consent()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.member_user_id is not null and new.member_user_id is distinct from old.member_user_id then
    new.voice_consent_at := null;
    new.voice_consent_by := null;
  end if;
  return new;
end;
$$;
revoke all on function public.people_clear_voice_consent() from public, anon, authenticated;

create trigger people_clear_voice_consent
  before update of member_user_id on public.people
  for each row execute function public.people_clear_voice_consent();

-- ---------------------------------------------------------------------------------------------
-- Storage: org logos. Private bucket; one object per förening at `<org id>/logo` (a square image
-- the browser cropped and resized, at most 1 MB, PNG/JPEG/WebP; no SVG). Members read their
-- förening's logo, admins write it.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-logos', 'org-logos', false, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- The org an object name belongs to: `<uuid>/logo` only; anything else is null (so a bad name is
-- refused, never a cast error).
create function public.org_logo_org(p_name text)
returns uuid
language sql immutable set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/logo$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;
revoke all on function public.org_logo_org(text) from public, anon;
grant execute on function public.org_logo_org(text) to authenticated, service_role;

create policy org_logos_select on storage.objects for select to authenticated
  using (bucket_id = 'org-logos' and public.is_org_member(public.org_logo_org(name)));
create policy org_logos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'org-logos' and public.is_org_admin(public.org_logo_org(name)));
create policy org_logos_update on storage.objects for update to authenticated
  using (bucket_id = 'org-logos' and public.is_org_admin(public.org_logo_org(name)))
  with check (bucket_id = 'org-logos' and public.is_org_admin(public.org_logo_org(name)));
create policy org_logos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'org-logos' and public.is_org_admin(public.org_logo_org(name)));
