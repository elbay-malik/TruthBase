-- ============================================================================
-- Phase 2 — keep-alive target for the free-tier anti-pause ping.
-- Free projects pause after ~7 days without user DB activity. The scheduled
-- workflow (.github/workflows/keep-alive.yml) reads this table with the ANON
-- key twice a week to register activity. RLS exposes read-only, one dummy row.
-- ============================================================================

create table if not exists public.keep_alive (
  id        bigint generated always as identity primary key,
  pinged_at timestamptz not null default now()
);

-- Exactly one row so the heartbeat SELECT always returns something.
insert into public.keep_alive default values;

-- Lock down, then allow anonymous READ only (no writes, nothing sensitive).
alter table public.keep_alive enable row level security;

create policy "anon can read keep_alive"
  on public.keep_alive
  for select
  to anon
  using (true);
