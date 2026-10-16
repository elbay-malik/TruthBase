-- ============================================================================
-- Phase 2 — hybrid_search RPC: RRF fusion of the keyword + semantic arms
-- Adapted from the official Supabase hybrid-search function to the `chunks`
-- table and cosine distance, with an optional single-document filter.
--
-- RRF score per row = Σ arm  weight / (rrf_k + rank_in_arm)
-- rrf_k defaults to 50 (Cormack et al. use 60; practical range 50–60). It is a
-- parameter, so tuning against the golden set needs no schema change (Phase 6).
--
-- Returns the chunk columns callers need plus the fused `score` — not the
-- 768-float embedding or the tsvector, which would bloat every response.
-- Verified by supabase/tests/hybrid_search.sql.
-- ============================================================================

create or replace function hybrid_search (
  query_text         text,
  query_embedding    extensions.vector(768),
  match_count        int,
  full_text_weight   float default 1,
  semantic_weight    float default 1,
  rrf_k              int   default 50,
  filter_document_id uuid  default null
)
returns table (
  id          uuid,
  document_id uuid,
  page_number int,
  content     text,
  highlight   jsonb,
  created_at  timestamptz,
  score       float
)
language sql
stable
set search_path = public, extensions
as $$
with full_text as (
  select
    c.id,
    -- 'english' must match the regconfig of the generated `fts` column;
    -- relying on default_text_search_config would silently break stemming.
    row_number() over (
      order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc
    ) as rank_ix
  from chunks c
  where c.fts @@ websearch_to_tsquery('english', query_text)
    and (filter_document_id is null or c.document_id = filter_document_id)
  order by rank_ix
  limit least(match_count, 30) * 2
),
semantic as (
  select
    c.id,
    row_number() over (
      order by c.embedding <=> query_embedding  -- cosine distance, ascending = closest
    ) as rank_ix
  from chunks c
  where c.embedding is not null
    and (filter_document_id is null or c.document_id = filter_document_id)
  order by rank_ix
  limit least(match_count, 30) * 2
),
fused as (
  select
    coalesce(full_text.id, semantic.id) as id,
    coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight as score
  from full_text
  full outer join semantic on full_text.id = semantic.id
)
select
  c.id,
  c.document_id,
  c.page_number,
  c.content,
  c.highlight,
  c.created_at,
  fused.score
from fused
join chunks c on c.id = fused.id
order by fused.score desc
limit least(match_count, 30);
$$;

-- Server-only: the Nitro routes call this with the service_role key. Supabase
-- grants EXECUTE on new public functions to anon/authenticated by default.
revoke execute on function hybrid_search(text, extensions.vector, int, float, float, int, uuid)
  from public, anon, authenticated;
grant execute on function hybrid_search(text, extensions.vector, int, float, float, int, uuid)
  to service_role;
