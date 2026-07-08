import type { ChunkRecord } from '#shared/types'

// Typed wrapper around the `hybrid_search` SQL RPC (see
// supabase/migrations/20260708153100_hybrid_search.sql). Auto-imported by Nitro.
//
// Phase 4/6 call this after embedding the query. The query embedding is passed
// as a raw number[] — supabase-js serializes it to the JSON array pgvector's
// input parser accepts; do NOT pre-stringify a scalar vector argument.

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

/** A row returned by hybrid_search, mirroring the `chunks` table. */
export interface ChunkRow extends Omit<ChunkRecord, 'embedding'> {
  createdAt: string
}

export async function hybridSearch(params: HybridSearchParams): Promise<ChunkRow[]> {
  const supabase = serverSupabase()

  const { data, error } = await supabase.rpc('hybrid_search', {
    query_text: params.queryText,
    query_embedding: params.queryEmbedding,
    match_count: params.matchCount ?? 10,
    full_text_weight: params.fullTextWeight ?? 1,
    semantic_weight: params.semanticWeight ?? 1,
    rrf_k: params.rrfK ?? 50,
    filter_document_id: params.documentId ?? null,
  })

  if (error) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `hybrid_search failed: ${error.message}`,
    })
  }

  return (data ?? []) as ChunkRow[]
}
