-- ============================================================================
-- Phase 14 — per-minute (burst) limits in Postgres, next to the daily caps
-- (ADR-0010, ADR-0011).
--
-- On Vercel every function instance has its own memory, so nuxt-security's
-- in-memory per-IP limiter (10 chats / 30 searches a minute) only holds per
-- instance and resets on every cold start. The limits that protect LLM quota
-- move here, shared by all instances; the in-memory limiter stays as a cheap
-- first line.
--
-- consume_quotas() gains an optional p_windows int[]: each counter's window
-- in seconds. 86400 (or NULL / no array) is the UTC day, counted in
-- usage_counters exactly as before; 1..3600 is a fixed window aligned to the
-- epoch (60 = each clock minute), counted in burst_counters. Everything else
-- is unchanged: all counters are incremented or none, the rows are locked in
-- one fixed order (daily first, then windowed; each by scope, key), and old
-- rows are pruned on the way. A 3-argument call still works (all daily), so
-- the code that predates this migration keeps running against it.
--
-- Server-only like the rest: RLS on with no policies, execute granted to
-- service_role only.
-- ============================================================================

create table burst_counters (
  scope        text        not null,
  key          text        not null,
  window_start timestamptz not null,
  count        int         not null default 0 check (count >= 0),
  primary key (scope, key, window_start)
);
create index burst_counters_window_start on burst_counters (window_start);

alter table burst_counters enable row level security;

-- Replaced, not overloaded: two candidates would make PostgREST's resolution
-- of a 3-argument call ambiguous.
drop function consume_quotas (text[], text[], int[]);

create function consume_quotas (p_scopes text[], p_keys text[], p_limits int[], p_windows int[] default null)
returns table (allowed boolean, blocked_scope text, used int)
language plpgsql
volatile
set search_path = public
as $$
declare
  ts timestamptz := now();
  today date := (ts at time zone 'utc')::date;
  windows int[] := coalesce(p_windows, array_fill(86400, array[coalesce(cardinality(p_scopes), 0)]));
  q record;
  current int;
begin
  if cardinality(p_scopes) is distinct from cardinality(p_keys)
     or cardinality(p_scopes) is distinct from cardinality(p_limits)
     or cardinality(p_scopes) is distinct from cardinality(windows) then
    raise exception 'consume_quotas: scopes, keys, limits and windows differ in length';
  end if;
  if exists (select 1 from unnest(windows) as w where w is null or (w <> 86400 and w not between 1 and 3600)) then
    raise exception 'consume_quotas: a window is 86400 (the UTC day) or 1..3600 seconds';
  end if;

  -- Old days and windows are never read again; index range deletes.
  delete from usage_counters where day < today - 2;
  delete from burst_counters where window_start < ts - interval '2 hours';

  -- Make sure every counter row exists, then lock them in a fixed order.
  insert into usage_counters (scope, key, day)
  select s, k, today from unnest(p_scopes, p_keys, windows) as t(s, k, w)
  where w = 86400
  on conflict do nothing;

  insert into burst_counters (scope, key, window_start)
  select s, k, to_timestamp(floor(extract(epoch from ts) / w) * w)
  from unnest(p_scopes, p_keys, windows) as t(s, k, w)
  where w <> 86400
  on conflict do nothing;

  for q in
    select s as scope, k as key, l as lim, w as win
    from unnest(p_scopes, p_keys, p_limits, windows) as t(s, k, l, w)
    order by w <> 86400, s, k, w
  loop
    if q.win = 86400 then
      select c.count into current from usage_counters c
      where c.scope = q.scope and c.key = q.key and c.day = today
      for update;
    else
      select c.count into current from burst_counters c
      where c.scope = q.scope and c.key = q.key
        and c.window_start = to_timestamp(floor(extract(epoch from ts) / q.win) * q.win)
      for update;
    end if;
    if current >= q.lim then
      return query select false, q.scope, current;
      return;
    end if;
  end loop;

  update usage_counters c set count = c.count + 1
  from unnest(p_scopes, p_keys, windows) as t(s, k, w)
  where t.w = 86400 and c.scope = t.s and c.key = t.k and c.day = today;

  update burst_counters c set count = c.count + 1
  from unnest(p_scopes, p_keys, windows) as t(s, k, w)
  where t.w <> 86400 and c.scope = t.s and c.key = t.k
    and c.window_start = to_timestamp(floor(extract(epoch from ts) / t.w) * t.w);

  return query select true, null::text, null::int;
end;
$$;

revoke all on table burst_counters from public, anon, authenticated;
revoke execute on function consume_quotas(text[], text[], int[], int[]) from public, anon, authenticated;
grant execute on function consume_quotas(text[], text[], int[], int[]) to service_role;
