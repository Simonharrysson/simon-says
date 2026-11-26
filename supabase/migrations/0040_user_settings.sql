-- Per-user settings, starting with the UI language (Simon's todo: "the whole page should be
-- swedish by default but able to change to english in settings").
--
-- Strictly additive: one new table and one function that old code never reads. No row means the
-- defaults (Swedish), so nothing changes for anyone until they pick English under Konto.
--
-- * locale: the web UI language, 'sv' or 'en'. The browser also keeps it in the `lang` cookie
--   (rendering reads the cookie; the auth callback copies this value into it on sign-in), and
--   e-mails to the user use it (lib/i18n/user-locale.ts, service role). Google Docs stay in the
--   förening's meeting language (Swedish) whatever this says.
-- Written only through set_my_locale() (the user's own row), read under RLS (own row only).

create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  locale text not null default 'sv' check (locale in ('sv', 'en')),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;
revoke all on table public.user_settings from anon, authenticated, service_role;
grant select on table public.user_settings to authenticated;
grant select, insert, update, delete on table public.user_settings to service_role;

create policy user_settings_own on public.user_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

create function public.set_my_locale(p_locale text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('sv', 'en') then
    raise exception 'unknown locale' using errcode = '22023';
  end if;
  insert into public.user_settings (user_id, locale, updated_at)
  values (v_uid, p_locale, now())
  on conflict (user_id) do update set locale = excluded.locale, updated_at = now();
end;
$$;

revoke all on function public.set_my_locale(text) from public, anon, authenticated;
grant execute on function public.set_my_locale(text) to authenticated;
