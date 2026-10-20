-- ============================================================================
-- Acceptance check: consume_quotas with per-minute windows (Phase 14,
-- ADR-0010/0011). Counts up to a windowed limit, keeps minute and daily
-- counters all-or-nothing, aligns windows to the clock, prunes old windows,
-- still accepts the 3-argument (all daily) call, and is server-only.
-- now() is fixed inside the transaction, so every call lands in one window.
-- ROLLS BACK: nothing persists.
-- ============================================================================

begin;

do $$
declare
  r record;
  today date := (now() at time zone 'utc')::date;
  this_minute timestamptz := date_trunc('minute', now());
begin
  -- 1. A minute window: allowed up to the limit, then blocked at the limit.
  for i in 1..2 loop
    select * into r from consume_quotas(array['b:minute'], array['k1'], array[2], array[60]);
    assert r.allowed, format('call %s of 2 should be allowed', i);
  end loop;
  select * into r from consume_quotas(array['b:minute'], array['k1'], array[2], array[60]);
  assert not r.allowed and r.blocked_scope = 'b:minute' and r.used = 2, format('3rd call: got %s', r);
  assert (select count from burst_counters where scope = 'b:minute' and key = 'k1') = 2, 'a blocked call must not count';
  assert (select window_start from burst_counters where scope = 'b:minute' and key = 'k1') = this_minute, 'a 60 s window starts on the clock minute';
  assert not exists (select 1 from usage_counters where scope = 'b:minute'), 'a windowed counter is not a daily one';

  -- 2. Minute and daily counters in one call, all or nothing both ways.
  select * into r from consume_quotas(array['b:minute', 'b:client', 'b:global'], array['k2', 'k2', 'all'], array[1, 10, 10], array[60, 86400, 86400]);
  assert r.allowed, 'first call under every limit';
  select * into r from consume_quotas(array['b:minute', 'b:client', 'b:global'], array['k2', 'k2', 'all'], array[1, 10, 10], array[60, 86400, 86400]);
  assert not r.allowed and r.blocked_scope = 'b:minute', format('the minute limit should block: %s', r);
  assert (select count from usage_counters where scope = 'b:client' and key = 'k2' and day = today) = 1, 'a request blocked by the minute limit must not use up the daily allowance';
  assert (select count from usage_counters where scope = 'b:global' and key = 'all' and day = today) = 1, 'nor the global budget';
  select * into r from consume_quotas(array['b:minute', 'b:client', 'b:global'], array['k3', 'k3', 'all'], array[5, 10, 1], array[60, 86400, 86400]);
  assert not r.allowed and r.blocked_scope = 'b:global', format('the global budget should block: %s', r);
  assert (select count from burst_counters where scope = 'b:minute' and key = 'k3') = 0, 'a request blocked by the daily budget must not use up the minute allowance';

  -- 3. Last minute's count doesn't carry over.
  insert into burst_counters (scope, key, window_start, count) values ('b:minute', 'k4', this_minute - interval '1 minute', 99);
  select * into r from consume_quotas(array['b:minute'], array['k4'], array[1], array[60]);
  assert r.allowed, 'a new window starts at zero';

  -- 4. Windows older than two hours are pruned by the next call.
  insert into burst_counters (scope, key, window_start, count) values ('b:minute', 'old', now() - interval '3 hours', 5);
  perform consume_quotas(array['b:minute'], array['k5'], array[5], array[60]);
  assert not exists (select 1 from burst_counters where key = 'old'), 'windows older than two hours must be pruned';

  -- 5. Without windows every counter is daily: the call from before this migration.
  select * into r from consume_quotas(array['b:legacy'], array['k6'], array[1]);
  assert r.allowed, '3-argument call';
  select * into r from consume_quotas(array['b:legacy'], array['k6'], array[1], null);
  assert not r.allowed and r.blocked_scope = 'b:legacy', format('NULL windows count per day: %s', r);
  assert (select count from usage_counters where scope = 'b:legacy' and key = 'k6' and day = today) = 1, 'the 3-argument call counts in usage_counters';

  -- 6. Bad windows are errors, not a silent daily or unlimited counter.
  begin
    perform consume_quotas(array['a'], array['k'], array[1], array[7200]);
    raise exception 'a 7200 s window was accepted';
  exception when raise_exception then
    if sqlerrm not like 'consume_quotas: a window%' then raise; end if;
  end;
  begin
    perform consume_quotas(array['a', 'b'], array['k', 'k'], array[1, 1], array[60]);
    raise exception 'mismatched windows were accepted';
  exception when raise_exception then
    if sqlerrm not like 'consume_quotas: scopes%' then raise; end if;
  end;

  raise notice 'consume_quotas windows: all assertions passed';
end $$;

-- 7. Server-only: anon can neither call the 4-argument function nor read the counters.
set local role anon;
do $$
begin
  begin
    perform consume_quotas(array['x'], array['y'], array[1], array[60]);
    raise exception 'anon was able to execute consume_quotas';
  exception when insufficient_privilege then
    if sqlerrm not like '%consume_quotas%' then raise; end if;
  end;
  begin
    perform count(*) from burst_counters;
    raise exception 'anon was able to read burst_counters';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'burst quota access control: all assertions passed';
end $$;
reset role;

-- 8. The server's role (service_role, what the app's Supabase client uses) can
-- run the 4-argument call end to end: the function is SECURITY INVOKER, so it
-- needs its own rights on both counter tables.
set local role service_role;
do $$
declare
  r record;
begin
  select * into r from consume_quotas(array['s:minute', 's:client'], array['svc', 'svc'], array[1, 1], array[60, 86400]);
  assert r.allowed, format('service_role call: %s', r);
  select * into r from consume_quotas(array['s:minute', 's:client'], array['svc', 'svc'], array[1, 1], array[60, 86400]);
  assert not r.allowed and r.blocked_scope = 's:client', format('service_role second call: %s', r);
  raise notice 'burst quota as service_role: all assertions passed';
end $$;
reset role;

rollback;
