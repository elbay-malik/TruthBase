import { startActiveObservation, updateActiveObservation } from '@langfuse/tracing'
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
// are fused with RRF; a failed rewrite search leaves the question's own hits.
// With a reranker (Phase 7, ADR-0007), an LLM picks the top RERANK_HEAD of the
// fused top RERANK_CANDIDATES and the rest follow in fused order. Keep the
// top-k chunks and number them as citable sources.
//
// Traced as a Langfuse `retriever` observation with `rewrite` and `rerank`
// steps (Phase 10); no-ops when tracing is off (server/plugins/tracing.ts).

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
  /** Time budget per LLM step; unset keeps each step's default (3 s rewrite, 4 s rerank). Evals raise it. */
  stepTimeoutMs?: number
  abortSignal?: AbortSignal
}

export interface Retrieval {
  sources: SourceRef[]
  /** Extra queries the expander added (empty: the question was searched alone). */
  rewrites: string[]
  /** True when the reranker ordered the sources; false means fused order. */
  reranked: boolean
}

export function retrieveSources(
  supabase: SupabaseClient,
  embedQuery: Embedder,
  question: string,
  options: RetrieveOptions = {},
): Promise<Retrieval> {
  return startActiveObservation('retrieve', async (observation) => {
    observation.update({ input: { question, documentId: options.documentId, topK: options.topK ?? DEFAULT_TOP_K } })
    const result = await retrieve(supabase, embedQuery, question, options)
    observation.update({
      output: result.sources.map(s => ({ index: s.index, chunkId: s.chunkId, filename: s.filename, page: s.pageNumber })),
      metadata: { rewrites: result.rewrites, reranked: result.reranked, expander: options.expander?.id ?? 'off', reranker: options.reranker?.id ?? 'off' },
    })
    return result
  }, { asType: 'retriever' })
}

async function retrieve(
  supabase: SupabaseClient,
  embedQuery: Embedder,
  question: string,
  options: RetrieveOptions,
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
  let searchedRewrites = rewrites
  if (rewrites.length) {
    try {
      const embeddings = await embedQuery(rewrites)
      const lists = await Promise.all(rewrites.map((text, i) => search(text, embeddings[i]!)))
      hits = fuseRankings([questionHits, ...lists]).slice(0, matchCount)
    }
    catch (error) {
      // Expansion is optional (ADR-0009): fall back to the question's own hits.
      if (options.abortSignal?.aborted) throw error
      console.warn(`[expand] rewrite search failed, retrieving the question alone: ${String(error).slice(0, 200)}`)
      updateActiveObservation({ level: 'WARNING', statusMessage: `rewrite search failed, question searched alone: ${String(error).slice(0, 200)}` })
      searchedRewrites = []
    }
  }

  const filenameById = await filenames(supabase, hits)
  const reranker = options.reranker
  const ranked = reranker
    ? await startActiveObservation('rerank', async (observation) => {
        const candidates = hits.slice(0, RERANK_CANDIDATES)
        observation.update({ input: { candidates: candidates.map(h => h.id) } })
        const result = await rerank(reranker, question, candidates, filenameById, { abortSignal: options.abortSignal, timeoutMs: options.stepTimeoutMs })
        observation.update({ output: { reranked: result.reranked, order: result.hits.slice(0, topK).map(h => h.id) } })
        return { hits: [...result.hits, ...hits.slice(RERANK_CANDIDATES)], reranked: result.reranked }
      }, { asType: 'chain' })
    : { hits, reranked: false }
  return { sources: toSources(ranked.hits.slice(0, topK), filenameById), rewrites: searchedRewrites, reranked: ranked.reranked }
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
  return startActiveObservation('rewrite', async (observation) => {
    const queries = await expand(expander, question, catalog.map(catalogLine), { abortSignal: options.abortSignal, timeoutMs: options.stepTimeoutMs })
    observation.update({ output: queries })
    return queries
  }, { asType: 'chain' })
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
