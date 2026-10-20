import type { SupabaseClient } from '@supabase/supabase-js'
import type { SourceRef } from '../../shared/types/chat'
import type { Embedder } from '../ingest/embed'
import { catalogLine, documentCatalog } from './catalog'
import { expand, fuseRankings } from './expand'
import type { TaskModel } from './model'
import { rerank, RERANK_CANDIDATES } from './rerank'
import { searchChunks, type SearchHit } from './search'

// Retrieval: embed the question (RETRIEVAL_QUERY) and run hybrid RRF search.
// With an expander (Phase 8, ADR-0009), an LLM meanwhile rewrites an ambiguous
// or multi-part question into extra queries, each searched too, and the lists
// are fused with RRF. With a reranker (Phase 7, ADR-0007), an LLM picks the
// top RERANK_HEAD of the fused candidates and the rest follow in fused order.
// Keep the top-k chunks and number them as citable sources.

export const DEFAULT_TOP_K = 8

export interface RetrieveOptions {
  topK?: number
  documentId?: string
  /** RRF arm weights; unset means the SQL's tuned defaults (ADR-0006). */
  fullTextWeight?: number
  semanticWeight?: number
  /** Rewrite ambiguous or multi-part questions into extra queries (ADR-0009). */
  expander?: TaskModel
  /** Rerank the fused top RERANK_CANDIDATES before keeping topK. */
  reranker?: TaskModel
  abortSignal?: AbortSignal
}

export interface Retrieval {
  sources: SourceRef[]
  /** Extra queries the expander added (empty: the question was searched alone). */
  rewrites: string[]
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
  // The RPC caps match_count at 30.
  const matchCount = options.reranker || options.expander ? Math.min(Math.max(topK, RERANK_CANDIDATES), 30) : topK
  const search = (queryText: string, queryEmbedding: number[]) => searchChunks(supabase, {
    queryText,
    queryEmbedding,
    matchCount,
    documentId: options.documentId,
    fullTextWeight: options.fullTextWeight,
    semanticWeight: options.semanticWeight,
  })

  // The rewrite call runs alongside the question's own search; only the
  // rewrites' searches wait for it.
  const [questionHits, rewrites] = await Promise.all([
    embedQuery([question]).then(([embedding]) => search(question, embedding!)),
    options.expander ? rewritesFor(supabase, options.expander, question, options) : Promise.resolve([]),
  ])
  let hits = questionHits
  if (rewrites.length) {
    const embeddings = await embedQuery(rewrites)
    const lists = await Promise.all(rewrites.map((text, i) => search(text, embeddings[i]!)))
    hits = fuseRankings([questionHits, ...lists]).slice(0, matchCount)
  }

  const filenameById = await filenames(supabase, hits)
  const ranked = options.reranker
    ? await rerank(options.reranker, question, hits, filenameById, { abortSignal: options.abortSignal })
    : { hits, reranked: false }
  return { sources: toSources(ranked.hits.slice(0, topK), filenameById), rewrites, reranked: ranked.reranked }
}

/** Rewrites from the expander, which sees only the documents in scope; [] if unavailable. */
async function rewritesFor(supabase: SupabaseClient, expander: TaskModel, question: string, options: RetrieveOptions): Promise<string[]> {
  let catalog
  try {
    catalog = (await documentCatalog(supabase)).filter(d => !options.documentId || d.id === options.documentId)
  }
  catch (error) {
    console.warn(`[expand] document catalog unavailable, retrieving the question alone: ${String(error).slice(0, 200)}`)
    return []
  }
  return expand(expander, question, catalog.map(catalogLine), { abortSignal: options.abortSignal })
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
