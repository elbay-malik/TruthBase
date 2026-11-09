import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { toSources } from '../../server/rag/retrieve'
import { searchChunks, SearchError, toSearchHit } from '../../server/rag/search'

describe('toSearchHit', () => {
  it('maps a hybrid_search row from snake_case to the app shape', () => {
    const hit = toSearchHit({
      id: 'c1',
      document_id: 'd1',
      page_number: 28,
      content: 'RC.RP-03: The integrity of backups …',
      highlight: null,
      created_at: '2026-10-16T19:00:00Z',
      score: 1 / 51 + 1 / 52,
    })

    expect(hit).toEqual({
      id: 'c1',
      documentId: 'd1',
      pageNumber: 28,
      content: 'RC.RP-03: The integrity of backups …',
      context: '',
      highlight: null,
      createdAt: '2026-10-16T19:00:00Z',
      score: 1 / 51 + 1 / 52,
    })
  })
})

describe('toSearchHit context', () => {
  const row = { id: 'c1', document_id: 'd1', page_number: 8, content: '30.0 48.0', highlight: null, created_at: '', score: 1 }
  it('keeps the context of a continuation chunk', () => {
    expect(toSearchHit({ ...row, context: 'PopQA TQA Pub' }).context).toBe('PopQA TQA Pub')
  })
  it('reads a missing or null context (function not yet migrated) as empty', () => {
    expect(toSearchHit(row).context).toBe('')
    expect(toSearchHit({ ...row, context: null }).context).toBe('')
  })
  it('is copied into the numbered sources', () => {
    const sources = toSources([toSearchHit({ ...row, context: 'PopQA TQA Pub' }), toSearchHit({ ...row, id: 'c2' })], new Map([['d1', 'self-rag.pdf']]))
    expect(sources.map(s => [s.index, s.filename, s.context])).toEqual([[1, 'self-rag.pdf', 'PopQA TQA Pub'], [2, 'self-rag.pdf', '']])
  })
})

describe('searchChunks', () => {
  const client = (result: { data: unknown, error: unknown }) => {
    const rpc = vi.fn(async () => result)
    return { rpc, supabase: { rpc } as unknown as SupabaseClient }
  }

  it('leaves unset tuning parameters to the SQL defaults', async () => {
    const { rpc, supabase } = client({ data: [], error: null })
    await searchChunks(supabase, { queryText: 'q', queryEmbedding: [1], matchCount: 8 })
    expect(rpc).toHaveBeenCalledWith('hybrid_search_bge_m3', { query_text: 'q', query_embedding: [1], match_count: 8, filter_document_id: null })
  })

  it('passes explicit tuning parameters through, including zero weights', async () => {
    const { rpc, supabase } = client({ data: [], error: null })
    await searchChunks(supabase, { queryText: 'q', queryEmbedding: [1], fullTextWeight: 0, semanticWeight: 1, rrfK: 10, candidateCount: 20, documentId: 'd' })
    expect(rpc).toHaveBeenCalledWith('hybrid_search_bge_m3', {
      query_text: 'q', query_embedding: [1], match_count: 10, filter_document_id: 'd',
      full_text_weight: 0, semantic_weight: 1, rrf_k: 10, candidate_count: 20,
    })
  })

  it('maps rows in the fused order the RPC returns, and no data to no hits', async () => {
    const row = (id: string, score: number) => ({ id, document_id: 'd1', page_number: null, content: id, highlight: null, created_at: '', score })
    const ranked = client({ data: [row('b', 0.03), row('a', 0.02)], error: null })
    expect((await searchChunks(ranked.supabase, { queryText: 'q', queryEmbedding: [1] })).map(h => [h.id, h.score])).toEqual([['b', 0.03], ['a', 0.02]])
    const empty = client({ data: null, error: null })
    expect(await searchChunks(empty.supabase, { queryText: 'q', queryEmbedding: [1] })).toEqual([])
  })

  it('wraps RPC errors in SearchError', async () => {
    const { supabase } = client({ data: null, error: { message: 'boom' } })
    await expect(searchChunks(supabase, { queryText: 'q', queryEmbedding: [1] })).rejects.toBeInstanceOf(SearchError)
  })
})
