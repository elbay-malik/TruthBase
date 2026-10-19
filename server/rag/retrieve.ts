import type { SupabaseClient } from '@supabase/supabase-js'
import type { SourceRef } from '../../shared/types/chat'
import type { Embedder } from '../ingest/embed'
import { rerank, RERANK_CANDIDATES, type RerankModel } from './rerank'
import { searchChunks, type SearchHit } from './search'

// Retrieval: embed the question (RETRIEVAL_QUERY), hybrid RRF search, rerank
// the fused candidates with an LLM when a reranker is configured (Phase 7,
// ADR-0007: its top RERANK_HEAD, then fused order), keep the top-k chunks, and
// number them as citable sources.

export const DEFAULT_TOP_K = 8

export interface RetrieveOptions {
  topK?: number
  documentId?: string
  /** RRF arm weights; unset means the SQL's tuned defaults (ADR-0006). */
  fullTextWeight?: number
  semanticWeight?: number
  /** Rerank the fused top RERANK_CANDIDATES before keeping topK. */
  reranker?: RerankModel
  abortSignal?: AbortSignal
}

export interface Retrieval {
  sources: SourceRef[]
  /** True when the reranker ordered the sources; false means fused order. */
  reranked: boolean
}

export async function retrieveSources(
  supabase: SupabaseClient,
  embedQuery: Embedder,
  question: string,
  options: RetrieveOptions = {},
): Promise<Retrieval> {
  const topK = options.topK ?? DEFAULT_TOP_K
  const [embedding] = await embedQuery([question])
  const hits = await searchChunks(supabase, {
    queryText: question,
    queryEmbedding: embedding!,
    // The RPC caps match_count at 30.
    matchCount: options.reranker ? Math.min(Math.max(topK, RERANK_CANDIDATES), 30) : topK,
    documentId: options.documentId,
    fullTextWeight: options.fullTextWeight,
    semanticWeight: options.semanticWeight,
  })
  const filenameById = await filenames(supabase, hits)
  const ranked = options.reranker
    ? await rerank(options.reranker, question, hits, filenameById, { abortSignal: options.abortSignal })
    : { hits, reranked: false }
  return { sources: toSources(ranked.hits.slice(0, topK), filenameById), reranked: ranked.reranked }
}

export function toSources(hits: SearchHit[], filenameById: Map<string, string>): SourceRef[] {
  return hits.map((hit, i) => ({
    index: i + 1,
    chunkId: hit.id,
    documentId: hit.documentId,
    filename: filenameById.get(hit.documentId) ?? 'unknown document',
    pageNumber: hit.pageNumber,
    content: hit.content,
    highlight: hit.highlight,
  }))
}

async function filenames(supabase: SupabaseClient, hits: SearchHit[]): Promise<Map<string, string>> {
  const ids = [...new Set(hits.map(h => h.documentId))]
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase.from('documents').select('id, filename').in('id', ids)
  if (error) throw new Error(`document lookup failed: ${error.message}`)
  return new Map(data.map(d => [d.id as string, d.filename as string]))
}
