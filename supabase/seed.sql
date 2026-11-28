-- Local and CI only: `supabase db reset` loads this after the migrations; `db push` (prod) never
-- does. Nothing here is data; it is fault injection for tests/db.

-- tests/db/foretag.test.ts: a company named exactly "Testfel: kön" makes every write to the
-- reconcile queue fail, to show the triggers that enqueue (0053) never fail the write they ride on
-- (an e-mail change in auth.users, a person moved).
create function public.test_fail_reconcile_queue()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.orgs o where o.id = new.org_id and o.name = 'Testfel: kön') then
    raise exception 'test: injected reconcile queue failure';
  end if;
  return new;
end;
$$;
revoke all on function public.test_fail_reconcile_queue() from public, anon, authenticated;

create trigger test_fail_reconcile_queue
  before insert or update on public.foretag_reconcile_queue
  for each row execute function public.test_fail_reconcile_queue();

-- tests/db/growth-loop.test.ts and the e2e sign-in (/api/e2e/login): the invite claim (0067)
-- requires a Google identity; test users are made by e-mail, so they get one here.
create function public.test_add_google_identity(p_user uuid)
returns void
language sql volatile security definer set search_path = ''
as $$
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
  select u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), 'google', now(), now(), now()
  from auth.users u
  where u.id = p_user
    and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'google');
$$;
revoke all on function public.test_add_google_identity(uuid) from public, anon, authenticated;
grant execute on function public.test_add_google_identity(uuid) to service_role;
