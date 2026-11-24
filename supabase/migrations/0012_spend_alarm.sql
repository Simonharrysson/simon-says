-- Task 12: the "day passed 50 % of the dollar cap" email goes out once per UTC day. One row per
-- day marks it sent. Additive; service_role only (RLS on, no policies).

create table public.spend_alarms (
  day date primary key,
  -- Set once the email went out. Until then next_attempt_at paces retries (a failed send is
  -- retried at most every p_retry_secs, never on every usage update).
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now()
);
alter table public.spend_alarms enable row level security;
revoke all on public.spend_alarms from public, anon, authenticated;
grant select, insert, update on public.spend_alarms to service_role;

-- True when today's spend is strictly over p_threshold_usd, the email is not sent yet and no
-- other attempt is due-pending: the caller then sends and calls mark_spend_alarm_sent(). The
-- claim pushes next_attempt_at p_retry_secs ahead, so a failed or crashed send is retried
-- after that, and concurrent callers don't double-send.
create function public.claim_spend_alarm(p_threshold_usd numeric, p_retry_secs int)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_total numeric;
  v_n int;
begin
  select coalesce(sum(u.usd), 0) into v_total from public.usage_daily u where u.day = v_day;
  if v_total <= p_threshold_usd then
    return false;
  end if;
  insert into public.spend_alarms (day) values (v_day) on conflict (day) do nothing;
  update public.spend_alarms a
  set next_attempt_at = now() + make_interval(secs => p_retry_secs)
  where a.day = v_day and a.sent_at is null and a.next_attempt_at <= now();
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

create function public.mark_spend_alarm_sent()
returns void
language sql volatile security definer set search_path = ''
as $$
  update public.spend_alarms set sent_at = now() where day = (now() at time zone 'utc')::date;
$$;

revoke all on function public.claim_spend_alarm(numeric, int) from public, anon, authenticated;
revoke all on function public.mark_spend_alarm_sent() from public, anon, authenticated;
grant execute on function public.claim_spend_alarm(numeric, int) to service_role;
grant execute on function public.mark_spend_alarm_sent() to service_role;
