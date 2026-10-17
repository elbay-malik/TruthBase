import type { SupabaseClient } from '@supabase/supabase-js'
import type { SourceRef } from '../../shared/types/chat'
import type { Embedder } from '../ingest/embed'
import { searchChunks, type SearchHit } from './search'

// Phase 4 retrieval: embed the question (RETRIEVAL_QUERY), hybrid RRF search,
// keep the top-k chunks, and number them as citable sources.

export const DEFAULT_TOP_K = 8

export interface RetrieveOptions {
  topK?: number
  documentId?: string
  /** RRF arm weights; Phase 6 tunes these against the golden set. */
  fullTextWeight?: number
  semanticWeight?: number
}

export async function retrieveSources(
  supabase: SupabaseClient,
  embedQuery: Embedder,
  question: string,
  options: RetrieveOptions = {},
): Promise<SourceRef[]> {
  const [embedding] = await embedQuery([question])
  const hits = await searchChunks(supabase, {
    queryText: question,
    queryEmbedding: embedding!,
    matchCount: options.topK ?? DEFAULT_TOP_K,
    documentId: options.documentId,
    fullTextWeight: options.fullTextWeight,
    semanticWeight: options.semanticWeight,
  })
  return toSources(hits, await filenames(supabase, hits))
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
