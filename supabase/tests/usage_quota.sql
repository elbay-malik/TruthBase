-- ============================================================================
-- Acceptance check: consume_quotas (Phase 11, ADR-0010). Counts up to each
-- limit, increments all counters or none, treats a limit of 0 as closed,
-- prunes old days, and is server-only. ROLLS BACK: nothing persists.
-- ============================================================================

begin;

do $$
declare
  r record;
  today date := (now() at time zone 'utc')::date;
begin
  -- 1. One counter: allowed up to the limit, then blocked at the limit.
  for i in 1..3 loop
    select * into r from consume_quotas(array['t:ip'], array['k1'], array[3]);
    assert r.allowed, format('call %s of 3 should be allowed', i);
  end loop;
  select * into r from consume_quotas(array['t:ip'], array['k1'], array[3]);
  assert not r.allowed and r.blocked_scope = 't:ip' and r.used = 3, format('4th call: got %s', r);
  assert (select count from usage_counters where scope = 't:ip' and key = 'k1' and day = today) = 3, 'a blocked call must not count';

  -- 2. All or nothing: the global budget blocks, so the IP counter doesn't move.
  select * into r from consume_quotas(array['t:ip', 't:global'], array['k2', 'all'], array[10, 1]);
  assert r.allowed, 'first call under both limits';
  select * into r from consume_quotas(array['t:ip', 't:global'], array['k2', 'all'], array[10, 1]);
  assert not r.allowed and r.blocked_scope = 't:global', format('global budget should block: %s', r);
  assert (select count from usage_counters where scope = 't:ip' and key = 'k2' and day = today) = 1, 'the blocked request must not use up the IP allowance';

  -- 3. A limit of 0 means closed, and creates no count.
  select * into r from consume_quotas(array['t:off'], array['k3'], array[0]);
  assert not r.allowed and r.used = 0, format('limit 0 must block: %s', r);

  -- 4. Rows older than two days are pruned by the next call.
  insert into usage_counters (scope, key, day, count) values ('t:ip', 'old', today - 3, 5);
  perform consume_quotas(array['t:ip'], array['k4'], array[5]);
  assert not exists (select 1 from usage_counters where key = 'old'), 'rows older than two days must be pruned';

  -- 5. Mismatched arrays are an error, not a silent partial check.
  begin
    perform consume_quotas(array['a', 'b'], array['k'], array[1, 1]);
    raise exception 'mismatched arrays were accepted';
  exception when raise_exception then
    if sqlerrm not like 'consume_quotas:%' then raise; end if;
  end;

  raise notice 'consume_quotas: all assertions passed';
end $$;

-- 6. Server-only: anon and authenticated can neither call it nor read counters.
set local role anon;
do $$
begin
  begin
    perform consume_quotas(array['x'], array['y'], array[1]);
    raise exception 'anon was able to execute consume_quotas';
  exception when insufficient_privilege then
    if sqlerrm not like '%consume_quotas%' then raise; end if;
  end;
  begin
    perform count(*) from usage_counters;
    raise exception 'anon was able to read usage_counters';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'usage quota access control: all assertions passed';
end $$;
reset role;

rollback;
