# Supabase (Phase 2 — database layer)

SQL migrations for the retrieval schema: `documents` + `chunks`, the dense
(pgvector/HNSW) and keyword (`tsvector`/GIN) arms, and the `hybrid_search` RRF
function. Rationale is in [../docs/adr/0002-retrieval-schema.md](../docs/adr/0002-retrieval-schema.md).

## Migrations

Applied in filename (timestamp) order:

| File | What it does |
|---|---|
| `migrations/20260708153000_init_documents_chunks.sql` | `vector` extension, `documents` + `chunks` tables, GIN + HNSW(cosine) + FK indexes |
| `migrations/20260708153100_hybrid_search.sql` | `hybrid_search(...)` RPC — RRF fusion of the two arms, optional single-document filter |
| `migrations/20260708153200_keep_alive.sql` | `keep_alive` table + RLS read policy for the anti-pause ping |

## How to apply

**Now (no CLI needed):** create a Supabase project, open the **SQL Editor**, and
run each migration file in order. That's enough to satisfy the Phase 2
acceptance criterion (the RPC returns fused results for a seeded row set).

**Later (CLI):** once you `supabase link` this repo to the hosted project,
`supabase db push` applies the not-yet-run migrations in timestamp order.

> ⚠️ Pick one mode per environment. Once you start using `supabase db push`, do
> **not** also make ad-hoc schema edits in the SQL/Table editor — that bypasses
> the migration history and makes the next `db push` fail. Manual SQL-editor
> mode is fine only while you have not yet linked/pushed.

## Configuration

The server reads these via `runtimeConfig` (server-only; see
[../.env.example](../.env.example)):

- `NUXT_SUPABASE_URL` — `https://<project-ref>.supabase.co`
- `NUXT_SUPABASE_SERVICE_KEY` — the **service_role** key (server only; never shipped to the client)

For the keep-alive GitHub Action, add repo secrets `SUPABASE_URL` and
`SUPABASE_ANON_KEY` (the **anon** key — RLS-gated, not the service key).

## Design notes

- **768-dim embeddings, L2-normalized at insert** (`shared/utils/vector.ts`,
  [TECH_NOTES §2](../docs/TECH_NOTES.md)) — fits the 500 MB free budget.
- **HNSW cosine** (`vector_cosine_ops`, `<=>`) is the applied default; an
  inner-product variant is documented inline in the init migration.
- **RRF `k` = 50** is a function parameter, so Phase 6 tuning needs no schema
  change. Over-fetch is `least(match_count, 30) * 2` per arm before fusing.
