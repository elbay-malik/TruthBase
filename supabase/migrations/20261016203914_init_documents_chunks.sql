-- ============================================================================
-- Phase 2 — core schema: documents + chunks with dense + keyword search
-- Verified against supabase.com/docs (Hybrid search, Semantic search) and the
-- pgvector README (July 2026). See docs/adr/0002-retrieval-schema.md.
--
-- Embeddings: 768-dim Gemini, L2-normalized at insert (docs/TECH_NOTES.md §2),
-- indexed with HNSW cosine to match the Phase 1 brief and stay robust to any
-- un-normalized vector.
-- ============================================================================

-- pgvector lives in the `extensions` schema on Supabase; the type is
-- referenced as extensions.vector(N).
create extension if not exists vector with schema extensions;

-- ── documents (parent) ──────────────────────────────────────────────────────
create table documents (
  id           uuid primary key default gen_random_uuid(), -- core PG (no pgcrypto needed on Supabase)
  filename     text not null,
  storage_path text,
  page_count   int,
  created_at   timestamptz not null default now()
);

-- ── chunks (child) ──────────────────────────────────────────────────────────
create table chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents (id) on delete cascade,
  page_number int,
  content     text not null,
  -- Generated STORED tsvector. to_tsvector('english', content) is IMMUTABLE
  -- only because the regconfig is a string literal — required for GENERATED.
  fts         tsvector generated always as (to_tsvector('english', content)) stored,
  -- Nullable so a chunk can be inserted before its embedding is computed.
  embedding   extensions.vector(768),
  -- { pageNumber, boundingRect, rects[], pageWidth/Height, char offsets }
  -- (shared/types/index.ts ChunkHighlight).
  highlight   jsonb,
  created_at  timestamptz not null default now()
);

-- ── row level security ──────────────────────────────────────────────────────
-- Tables in `public` are exposed through PostgREST to anyone holding the anon
-- key. RLS with no policies denies anon/authenticated entirely; the server
-- uses the service_role key, which bypasses RLS. Read policies for the public
-- demo workspace arrive with Phase 11 if the client ever queries directly.
alter table documents enable row level security;
alter table chunks enable row level security;

-- ── indexes ─────────────────────────────────────────────────────────────────
-- Keyword arm: GIN over the generated tsvector.
create index chunks_fts_idx on chunks using gin (fts);

-- Semantic arm: HNSW cosine. 768 dims is well within pgvector's 2000-dim
-- indexable ceiling. m=16 / ef_construction=64 are the pgvector defaults,
-- stated explicitly. Query-time recall knob: SET hnsw.ef_search (default 40).
create index chunks_embedding_idx
  on chunks using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Postgres does not auto-index FKs; keep cascade deletes and joins fast.
create index chunks_document_id_idx on chunks (document_id);

-- ----------------------------------------------------------------------------
-- INNER-PRODUCT ALTERNATIVE (documented, not applied): because we L2-normalize
-- embeddings, inner product is rank-equivalent to cosine and marginally faster.
-- To switch, replace the HNSW index with vector_ip_ops and use <#> in the RPC:
--   create index chunks_embedding_idx
--     on chunks using hnsw (embedding extensions.vector_ip_ops);
-- We keep cosine as the safe default (correct even if a vector is not unit-length).
-- ----------------------------------------------------------------------------
