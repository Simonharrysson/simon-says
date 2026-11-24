-- Task 12: the "day passed 50 % of the dollar cap" email goes out once per UTC day. One row per
-- day marks it sent. Additive; service_role only (RLS on, no policies).

create table public.spend_alarms (
  day date primary key,
  sent_at timestamptz not null default now()
);
alter table public.spend_alarms enable row level security;
revoke all on public.spend_alarms from public, anon, authenticated;
grant select, insert, delete on public.spend_alarms to service_role;

-- True exactly once per day: when today's recorded spend is at least p_threshold_usd and no
-- row marks the day yet. The caller sends the email, and releases the day if sending fails.
create function public.claim_spend_alarm(p_threshold_usd numeric)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_total numeric;
  v_n int;
begin
  select coalesce(sum(u.usd), 0) into v_total from public.usage_daily u where u.day = v_day;
  if v_total < p_threshold_usd then
    return false;
  end if;
  insert into public.spend_alarms (day) values (v_day) on conflict (day) do nothing;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

revoke all on function public.claim_spend_alarm(numeric) from public, anon, authenticated;
grant execute on function public.claim_spend_alarm(numeric) to service_role;
