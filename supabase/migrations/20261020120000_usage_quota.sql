-- ============================================================================
-- Phase 11 — daily usage quotas for the public demo (ADR-0010).
--
-- One row per (scope, key, UTC day): scope is the guarded resource, e.g.
-- 'chat:client' or 'chat:global'; key is a keyed hash of the client IP (never the
-- IP itself) or 'all' for the global budget.
--
-- consume_quotas() takes several (scope, key, limit) counters and increments
-- all of them or none: a request blocked by the global budget doesn't use up
-- its IP's allowance, and vice versa. The counter rows are locked in a fixed
-- order (scope, key), so concurrent requests can't overshoot or deadlock.
-- Rows older than two days are pruned on the way.
--
-- Server-only, like hybrid_search: RLS on with no policies, execute granted
-- to service_role only.
-- ============================================================================

create table usage_counters (
  scope text not null,
  key   text not null,
  day   date not null,
  count int  not null default 0 check (count >= 0),
  primary key (scope, key, day)
);
create index usage_counters_day on usage_counters (day);

alter table usage_counters enable row level security;

create function consume_quotas (p_scopes text[], p_keys text[], p_limits int[])
returns table (allowed boolean, blocked_scope text, used int)
language plpgsql
volatile
set search_path = public
as $$
declare
  today date := (now() at time zone 'utc')::date;
  q record;
  current int;
begin
  if cardinality(p_scopes) is distinct from cardinality(p_keys) or cardinality(p_scopes) is distinct from cardinality(p_limits) then
    raise exception 'consume_quotas: scopes, keys and limits differ in length';
  end if;

  -- Old days are never read again; an index range delete.
  delete from usage_counters where day < today - 2;

  -- Make sure every counter row exists, then lock them in a fixed order.
  insert into usage_counters (scope, key, day)
  select s, k, today from unnest(p_scopes, p_keys) as t(s, k)
  on conflict do nothing;

  for q in
    select s as scope, k as key, l as lim
    from unnest(p_scopes, p_keys, p_limits) as t(s, k, l)
    order by s, k
  loop
    select c.count into current from usage_counters c
    where c.scope = q.scope and c.key = q.key and c.day = today
    for update;
    if current >= q.lim then
      return query select false, q.scope, current;
      return;
    end if;
  end loop;

  update usage_counters c set count = c.count + 1
  from unnest(p_scopes, p_keys) as t(s, k)
  where c.scope = t.s and c.key = t.k and c.day = today;

  return query select true, null::text, null::int;
end;
$$;

revoke all on table usage_counters from public, anon, authenticated;
revoke execute on function consume_quotas(text[], text[], int[]) from public, anon, authenticated;
grant execute on function consume_quotas(text[], text[], int[]) to service_role;
