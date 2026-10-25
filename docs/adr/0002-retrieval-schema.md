# ADR-0002: Retrieval schema, embedding dimensions, and RRF fusion

- **Status:** Accepted
- **Date:** 2026-07-08

## Context

Phase 2 needs a Postgres schema on the Supabase free tier that supports both
dense (semantic) and keyword search plus per-chunk highlight metadata, fused
into a single ranked result — all within 500 MB of storage and without any
paid vector service. Verified against the official Supabase hybrid-search and
pgvector guides (July 2026).

## Decision

- **Two tables:** `documents` (parent) and `chunks` (child, `on delete cascade`).
  `chunks` carries `content`, a generated `fts tsvector`, `embedding vector(768)`,
  and a `highlight jsonb` column for the citation overlay data.
- **Embeddings at 768 dims**, Gemini `gemini-embedding-001` Matryoshka-truncated,
  **L2-normalized at insert** (`shared/utils/vector.ts`).
- **Two indexes:** GIN on `fts`; HNSW `vector_cosine_ops` on `embedding`
  (`m=16`, `ef_construction=64`, the pgvector defaults). Plus a plain index on
  the `document_id` FK.
- **`hybrid_search` SQL RPC** fuses the arms with Reciprocal Rank Fusion:
  `score = Σ weight / (rrf_k + rank)`, `rrf_k` default 50, per-arm weights
  default 1, over-fetching `least(match_count, 30) * 2` candidates per arm.
  Exposes an optional `filter_document_id`.
  Superseded for parameters by [ADR-0006](./0006-hybrid-search.md) (v2: k 60,
  keyword weight 0.5, 40 candidates per arm).

## Rationale

- **768 dims** trades a little retrieval quality for fitting the free storage
  budget; re-embedding later is cheap, so the choice is reversible.
- **HNSW over IVFFlat** — no training step, the pgvector 2026 default; 768 dims
  is well within HNSW's 2000-dim indexable ceiling.
- **Cosine over inner product** — although we L2-normalize (making the two
  rank-equivalent), cosine stays correct even if a vector slips through
  un-normalized, and it matches the Phase 1 brief. The faster IP variant is
  documented inline for later.
- **Native `tsvector` + RRF** — `pg_search`/BM25 is still unavailable on hosted
  Supabase; RRF in SQL is the documented, free, pragmatic approach.
- **`rrf_k` as a parameter** — Phase 6 tuning against the golden set needs no
  schema change.

## Rejected alternatives

- **External vector DB (Pinecone/Weaviate)** — unnecessary at this scale, not free.
- **IVFFlat** — needs a training step and a populated table; HNSW is simpler.
- **`pg_search`/BM25 (ParadeDB)** — not on hosted Supabase free tier.
- **Storing full 3072-dim vectors** — would blow the 500 MB budget quickly.

## Consequences

- Ingestion (Phase 3) must L2-normalize before insert, or cosine ranking degrades.
- Query embeddings are on the request path: `/api/chat` and `/api/search` call
  `geminiEmbedder` with `INTERACTIVE_EMBED_LIMITS` (1 retry, 8 s), while
  ingestion and scripts keep 5 retries. `/api/search` answers 504 on a timeout.
- The `hybrid_search` RPC returns the chunk columns callers need plus the
  fused RRF `score` (not the embedding or tsvector, which would bloat every
  response); `toSearchHit()` maps the snake_case rows to `SearchHit`
  (`server/rag/search.ts`).
- `documents` and `chunks` have RLS enabled with no policies, and
  `hybrid_search` is executable by `service_role` only: the anon key cannot
  read or write the corpus. The public demo
  goes through Nitro routes, not direct client queries.
- Highlight data must be captured at ingestion into `highlight jsonb`;
  retrofitting positions later means re-parsing every PDF.
- Free-tier pausing is mitigated by the keep-alive table + scheduled ping, not
  by the schema itself. The ping is a daily Vercel cron since 2026-10-25
  (ADR-0011 §7); it was a GitHub Actions workflow before.
