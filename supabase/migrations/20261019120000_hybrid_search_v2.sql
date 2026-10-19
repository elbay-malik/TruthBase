-- ============================================================================
-- Phase 6 — hybrid_search v2: tuned against the golden set (docs/adr/0006).
--
-- Changes from v1 (20261016203928_hybrid_search.sql):
-- 1. Keyword arm matches ANY query term. v1's websearch_to_tsquery ANDs every
--    term, so a natural-language question rarely matched a chunk: keyword-only
--    recall@10 was 27%, and hybrid never beat dense-only. The query is now the
--    OR of the question's own lexemes, produced by the same to_tsvector parser
--    as the indexed `fts` column, so "PR.DS-11", "logging,monitoring" or
--    "self-rag" tokenize exactly as in the documents; ranked by ts_rank_cd.
-- 2. Defaults from the tuning grid (scripts/tune-retrieval.ts, 5-fold CV):
--    full_text_weight 0.5, semantic_weight 1, rrf_k 60, candidate_count 40
--    rows per arm (v1: 2 × match_count, i.e. 16 for the chat's top-8).
-- 3. Deterministic order: score ties break by semantic rank, then id; rows
--    with score 0 are dropped (a zero-weight arm adds no filler rows).
--
-- The semantic arm is an exact cosine scan, as in v1: a SQL function's body is
-- planned generically, and the planner picks Seq Scan + top-N sort over the
-- HNSW index even at 50k rows (~0.1 s, measured in the Phase 6 review). Exact
-- is also exhaustive, so a document filter can never come back short. An
-- index path is a Phase 11/14 decision if the corpus grows (ADR-0006).
--
-- RRF score per row = Σ arm  weight / (rrf_k + rank_in_arm), as in v1.
-- Verified by supabase/tests/hybrid_search.sql.
-- ============================================================================

-- v1's signature has no candidate_count, so this is a new overload: drop v1
-- (and v2, so the migration can be re-run) rather than create-or-replace.
drop function if exists hybrid_search(text, extensions.vector, int, float, float, int, uuid);
drop function if exists hybrid_search(text, extensions.vector, int, float, float, int, uuid, int);

create function hybrid_search (
  query_text         text,
  query_embedding    extensions.vector(768),
  match_count        int,
  full_text_weight   float default 0.5,
  semantic_weight    float default 1,
  rrf_k              int   default 60,
  filter_document_id uuid  default null,
  candidate_count    int   default 40
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
with query as (
  -- "What does PR.DS-11 require?" → '-11' | 'pr.ds' | 'requir'. Lexemes come
  -- straight from to_tsvector (no re-parsing), quoted for the tsquery cast;
  -- 'english' must match the regconfig of the generated `fts` column.
  select coalesce(
    string_agg('''' || replace(replace(lexeme, '\', '\\'), '''', '''''') || '''', ' | '),
    ''
  )::tsquery as tsq
  from unnest(tsvector_to_array(to_tsvector('english', query_text))) as lexeme
),
full_text as (
  select
    c.id,
    row_number() over (order by ts_rank_cd(c.fts, query.tsq) desc, c.id) as rank_ix
  from chunks c, query
  where c.fts @@ query.tsq
    and (filter_document_id is null or c.document_id = filter_document_id)
  order by rank_ix
  limit least(candidate_count, 100)
),
semantic as (
  select
    c.id,
    row_number() over (order by c.embedding <=> query_embedding, c.id) as rank_ix  -- cosine distance
  from chunks c
  where c.embedding is not null
    and (filter_document_id is null or c.document_id = filter_document_id)
  order by rank_ix
  limit least(candidate_count, 100)
),
fused as (
  select
    coalesce(full_text.id, semantic.id) as id,
    coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight as score,
    semantic.rank_ix as semantic_rank
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
where fused.score > 0  -- a zero-weight arm contributes nothing, not filler rows
order by fused.score desc, fused.semantic_rank nulls last, c.id
limit least(match_count, 30);
$$;

-- Server-only, as v1: the Nitro routes call this with the service_role key.
revoke execute on function hybrid_search(text, extensions.vector, int, float, float, int, uuid, int)
  from public, anon, authenticated;
grant execute on function hybrid_search(text, extensions.vector, int, float, float, int, uuid, int)
  to service_role;
