import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChunkHighlight } from '#shared/types'

// Typed wrapper around the `hybrid_search_bge_m3` SQL RPC
// (supabase/migrations/20261104120000_bge_m3_column.sql). Framework-free so
// the chat route, the search route and the golden-set eval run the same code.
//
// Tuning parameters left undefined are not sent, so the SQL defaults (tuned in
// Phase 6, docs/adr/0006) are the single source of truth.
//
// The query embedding is passed as a raw number[]: supabase-js serializes it to
// the JSON array pgvector's input parser accepts — do NOT pre-stringify it.

export interface HybridSearchParams {
  queryText: string
  /** 1024-dim, L2-normalized query embedding (see l2Normalize / TECH_NOTES §21). */
  queryEmbedding: number[]
  matchCount?: number
  /** RRF weight of the keyword arm (SQL default 0.5). */
  fullTextWeight?: number
  /** RRF weight of the semantic arm (SQL default 1). */
  semanticWeight?: number
  /** RRF k (SQL default 60). */
  rrfK?: number
  /** Candidates taken from each arm before fusion (SQL default 40, max 100). */
  candidateCount?: number
  documentId?: string
}

/** A row exactly as `hybrid_search_bge_m3` returns it (Postgres snake_case). */
export interface HybridSearchRow {
  id: string
  document_id: string
  page_number: number | null
  content: string
  highlight: ChunkHighlight | null
  created_at: string
  score: number
}

/** A fused search hit in app (camelCase) shape. */
export interface SearchHit {
  id: string
  documentId: string
  pageNumber: number | null
  content: string
  /** Null until ingestion (Phase 3) has captured positions for the chunk. */
  highlight: ChunkHighlight | null
  createdAt: string
  /** RRF score: Σ weight / (rrfK + rank) over the keyword and semantic arms. */
  score: number
}

export function toSearchHit(row: HybridSearchRow): SearchHit {
  return {
    id: row.id,
    documentId: row.document_id,
    pageNumber: row.page_number,
    content: row.content,
    highlight: row.highlight,
    createdAt: row.created_at,
    score: row.score,
  }
}

export class SearchError extends Error {}

export async function searchChunks(supabase: SupabaseClient, params: HybridSearchParams): Promise<SearchHit[]> {
  const tuning = {
    full_text_weight: params.fullTextWeight,
    semantic_weight: params.semanticWeight,
    rrf_k: params.rrfK,
    candidate_count: params.candidateCount,
  }
  const { data, error } = await supabase.rpc('hybrid_search_bge_m3', {
    query_text: params.queryText,
    query_embedding: params.queryEmbedding,
    match_count: params.matchCount ?? 10,
    filter_document_id: params.documentId ?? null,
    // Omitted keys fall back to the SQL defaults.
    ...Object.fromEntries(Object.entries(tuning).filter(([, value]) => value !== undefined)),
  })
  if (error) throw new SearchError(`hybrid_search_bge_m3 failed: ${error.message}`)
  return ((data ?? []) as HybridSearchRow[]).map(toSearchHit)
}
