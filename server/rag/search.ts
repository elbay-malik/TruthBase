import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChunkHighlight } from '#shared/types'

// Typed wrapper around the `hybrid_search` SQL RPC
// (supabase/migrations/20261016203928_hybrid_search.sql). Framework-free so the
// chat route, the search route and the golden-set eval run the same code.
//
// The query embedding is passed as a raw number[]: supabase-js serializes it to
// the JSON array pgvector's input parser accepts — do NOT pre-stringify it.

export interface HybridSearchParams {
  queryText: string
  /** 768-dim, L2-normalized query embedding (see l2Normalize / TECH_NOTES §2). */
  queryEmbedding: number[]
  matchCount?: number
  fullTextWeight?: number
  semanticWeight?: number
  rrfK?: number
  documentId?: string
}

/** A row exactly as `hybrid_search` returns it (Postgres snake_case). */
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
  const { data, error } = await supabase.rpc('hybrid_search', {
    query_text: params.queryText,
    query_embedding: params.queryEmbedding,
    match_count: params.matchCount ?? 10,
    full_text_weight: params.fullTextWeight ?? 1,
    semantic_weight: params.semanticWeight ?? 1,
    rrf_k: params.rrfK ?? 50,
    filter_document_id: params.documentId ?? null,
  })
  if (error) throw new SearchError(`hybrid_search failed: ${error.message}`)
  return ((data ?? []) as HybridSearchRow[]).map(toSearchHit)
}
