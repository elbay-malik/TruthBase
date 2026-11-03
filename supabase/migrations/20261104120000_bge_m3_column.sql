-- ============================================================================
-- Leaving Gemini: a column and search function for Cloudflare's bge-m3 vectors.
--
-- Additive, so production keeps using `embedding` and hybrid_search until the
-- app switches over. The vectors have different dimensions and come from a
-- different model, so a new column lets both run side by side.
--
-- The function is hybrid_search v2 (20261019120000_hybrid_search_v2.sql) with
-- only the column and vector size changed. It has no HNSW index for the same
-- reason v2 scans exactly: the planner doesn't use one inside this function.
-- ============================================================================

alter table chunks add column embedding_bge_m3 extensions.vector(1024);

create function hybrid_search_bge_m3 (
  query_text         text,
  query_embedding    extensions.vector(1024),
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
    row_number() over (order by c.embedding_bge_m3 <=> query_embedding, c.id) as rank_ix  -- cosine distance
  from chunks c
  where c.embedding_bge_m3 is not null
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

-- Server-only, like hybrid_search.
revoke execute on function hybrid_search_bge_m3(text, extensions.vector, int, float, float, int, uuid, int)
  from public, anon, authenticated;
grant execute on function hybrid_search_bge_m3(text, extensions.vector, int, float, float, int, uuid, int)
  to service_role;
