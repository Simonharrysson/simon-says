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
