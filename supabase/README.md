# Supabase (Phase 2 — database layer)

SQL migrations for the retrieval schema: `documents` + `chunks`, the dense
(pgvector/HNSW) and keyword (`tsvector`/GIN) arms, and the `hybrid_search` RRF
function, plus the daily usage quotas. Rationale is in
[../docs/adr/0002-retrieval-schema.md](../docs/adr/0002-retrieval-schema.md); the
current `hybrid_search` (v2) parameters are in
[ADR-0006](../docs/adr/0006-hybrid-search.md), which supersedes ADR-0002's RRF
defaults.

## Migrations

Applied in filename (timestamp) order:

| File | What it does |
|---|---|
| `migrations/20261016203914_init_documents_chunks.sql` | `vector` extension, `documents` + `chunks` tables (RLS on, no policies), GIN + HNSW(cosine) + FK indexes |
| `migrations/20261016203928_hybrid_search.sql` | `hybrid_search(...)` RPC — RRF fusion of the two arms, optional single-document filter, returns the fused `score`; executable by `service_role` only |
| `migrations/20261016203929_keep_alive.sql` | `keep_alive` table + RLS read policy for the anti-pause ping |
| `migrations/20261016205210_documents_bucket.sql` | Private `documents` Storage bucket (PDF only, 20 MB limit) for ingested PDFs; served through short-lived signed URLs (Phase 3) |
| `migrations/20261019120000_hybrid_search_v2.sql` | Phase 6 `hybrid_search` v2: OR'ed keyword terms, tuned defaults (keyword weight 0.5, k 60, 40 candidates per arm), exact-scan semantic arm, deterministic ties ([ADR-0006](../docs/adr/0006-hybrid-search.md)) |
| `migrations/20261020120000_usage_quota.sql` | Phase 11 `usage_counters` table + `consume_quotas(...)` RPC: daily per-client and global caps, all-or-nothing increments; `service_role` only ([ADR-0010](../docs/adr/0010-abuse-protection.md)). Without it the quota check fails open with a warning per request |

## How to apply

**Now (no CLI needed):** create a Supabase project, open the **SQL Editor**, and
run each migration file in order.

**Hosted project** (`ezgfuoaukozwylgkdtft`): the first four migrations were applied
on 2026-10-16 with the Supabase MCP server's `apply_migration` (the first three
in Phase 2, `documents_bucket` in Phase 3), so they are in its migration
history and the CLI sees them as already applied. The later ones may not be;
check with `supabase migration list` after linking.

**Later (CLI):** once you `supabase link` this repo to the hosted project,
`supabase db push` applies the not-yet-run migrations in timestamp order.

> ⚠️ Pick one mode per environment. Once you start using `supabase db push`, do
> **not** also make ad-hoc schema edits in the SQL/Table editor — that bypasses
> the migration history and makes the next `db push` fail. Manual SQL-editor
> mode is fine only while you have not yet linked/pushed.

## Verify (Phase 2 acceptance)

[`tests/hybrid_search.sql`](./tests/hybrid_search.sql) seeds a 5-row corpus whose
keyword and semantic rankings are known by construction, asserts the fused
order, the exact RRF scores (v2 defaults and explicit parameters), both
weights, the document filter, English stemming, OR matching of query terms
(including punctuation-joined words and a hyphenated control ID),
`candidate_count`, no zero-score rows, and access control (anon: no rows via
RLS, no RPC execute, keep_alive readable), prints the fused ranking, and
**rolls back**. [`tests/usage_quota.sql`](./tests/usage_quota.sql) checks
`consume_quotas` (counts up to each limit, all or nothing, a limit of 0 is
closed, old days pruned, server-only) and also rolls back. Run them on an empty
database:

- **Hosted:** paste `hybrid_search.sql` into the SQL Editor and run. Expect three `NOTICE …
  passed` lines and labels `1, 2, 3, 4` with scores
  `0.024458, 0.024070, 0.016129, 0.015625` (v2 defaults: k 60, keyword weight
  0.5; v1 printed `0.038839, 0.038476, 0.019231, 0.018519`).
- **CI:** the `db` job in [`ci.yml`](../.github/workflows/ci.yml) applies the
  migrations to `supabase/postgres` (the image Supabase hosts) and runs it on
  every push, then runs `usage_quota.sql`.
- **Locally (OrbStack/Docker):**

  ```bash
  docker run -d --name tb-pg -e POSTGRES_PASSWORD=postgres supabase/postgres:17.11.0.004
  for f in supabase/migrations/*.sql; do docker exec -i tb-pg psql -U postgres -h localhost -v ON_ERROR_STOP=1 -q < "$f"; done
  docker exec -i tb-pg psql -U postgres -h localhost -v ON_ERROR_STOP=1 < supabase/tests/hybrid_search.sql
  docker exec -i tb-pg psql -U postgres -h localhost -v ON_ERROR_STOP=1 < supabase/tests/usage_quota.sql
  ```

## Configuration

The server reads these via `runtimeConfig` (server-only; see
[../.env.example](../.env.example)):

- `NUXT_SUPABASE_URL` — `https://<project-ref>.supabase.co`
- `NUXT_SUPABASE_SERVICE_KEY` — the **service_role** key (server only; never shipped to the client)

For the keep-alive GitHub Action, add repo secrets `SUPABASE_URL` and
`SUPABASE_ANON_KEY` (the **anon** key — RLS-gated, not the service key). In a
public repo GitHub disables scheduled workflows after 60 days without repository
activity; the workflow re-enables itself on each run, but watch for GitHub's
warning email and re-enable it by hand if it stops.

## Design notes

- **768-dim embeddings, L2-normalized at insert** (`shared/utils/vector.ts`,
  [TECH_NOTES §2](../docs/TECH_NOTES.md)) — fits the 500 MB free budget.
- **HNSW cosine** (`vector_cosine_ops`, `<=>`) is the applied default; an
  inner-product variant is documented inline in the init migration.
- **RRF defaults (v2, Phase 6):** `k` = 60, keyword weight 0.5, semantic
  weight 1, `candidate_count` = 40 rows per arm (capped at 100), independent of
  `match_count` (capped at 30). All are function parameters, so re-tuning is a
  `create or replace`, not an app deploy ([ADR-0006](../docs/adr/0006-hybrid-search.md)).
  v1 used k 50, weights 1/1, and `least(match_count, 30) * 2` per arm.
- **The semantic arm is an exact scan.** The SQL function's generic plan never
  picks the HNSW index; exact is exhaustive and fine at this size (ADR-0006).
