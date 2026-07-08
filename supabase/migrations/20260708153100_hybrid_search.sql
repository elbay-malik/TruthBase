-- ============================================================================
-- Phase 2 — hybrid_search RPC: RRF fusion of the keyword + semantic arms
-- Adapted from the official Supabase hybrid-search function to the `chunks`
-- table and cosine distance, with an optional single-document filter.
--
-- RRF score per row = Σ arm  weight / (rrf_k + rank_in_arm)
-- rrf_k defaults to 50 (Cormack et al. use 60; practical range 50–60). It is a
-- parameter, so tuning against the golden set needs no schema change (Phase 6).
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
returns setof chunks
language sql
set search_path = public, extensions
as $$
with full_text as (
  select
    id,
    row_number() over (
      order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
    ) as rank_ix
  from chunks
  where fts @@ websearch_to_tsquery(query_text)
    and (filter_document_id is null or document_id = filter_document_id)
  order by rank_ix
  limit least(match_count, 30) * 2
),
semantic as (
  select
    id,
    row_number() over (
      order by embedding <=> query_embedding  -- cosine distance, ascending = closest
    ) as rank_ix
  from chunks
  where embedding is not null
    and (filter_document_id is null or document_id = filter_document_id)
  order by rank_ix
  limit least(match_count, 30) * 2
)
select chunks.*
from full_text
full outer join semantic on full_text.id = semantic.id
join chunks on chunks.id = coalesce(full_text.id, semantic.id)
order by
  coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
  coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
  desc
limit least(match_count, 30);
$$;
