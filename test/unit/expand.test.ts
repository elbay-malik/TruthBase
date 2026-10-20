import type { SupabaseClient } from '@supabase/supabase-js'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { catalogLine, clearCatalogCache, documentCatalog } from '../../server/rag/catalog'
import { buildExpandPrompt, expand, fuseRankings, protectedTokens, validateRewrites } from '../../server/rag/expand'
import type { TaskModel } from '../../server/rag/model'
import { retrieveSources } from '../../server/rag/retrieve'
import type { SearchHit } from '../../server/rag/search'

const hit = (id: string): SearchHit => ({ id, documentId: 'd1', pageNumber: 1, content: id, highlight: null, createdAt: '', score: 0 } as SearchHit)

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}
const modelReturning = (doGenerate: () => Promise<unknown>): TaskModel => ({
  model: new MockLanguageModelV4({ doGenerate: doGenerate as never }),
  id: 'mock/model',
  providerOptions: {},
})
const answering = (queries: string[]) => modelReturning(async () => ({
  content: [{ type: 'text', text: JSON.stringify({ queries }) }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
}))

describe('protectedTokens', () => {
  it('keeps tokens with a digit, without surrounding punctuation', () => {
    expect(protectedTokens('What does PR.DS-11 require in CSF 2.0? Compare "GPT-4", (2023).'))
      .toEqual(['PR.DS-11', '2.0', 'GPT-4', '2023'])
    expect(protectedTokens('What are the tiers?')).toEqual([])
  })
})

describe('validateRewrites', () => {
  it('drops empty, overlong, duplicate and entity-losing rewrites', () => {
    const { queries, dropped } = validateRewrites('How does Self-RAG use GPT-4?', [
      'How does Self-RAG use GPT-4 for critique?',
      '  how does  self-rag use gpt-4?  ', // the question itself, re-spaced
      'How does Self-RAG use GPT-3.5?', // loses GPT-4
      '',
      'x'.repeat(301),
      'How does Self-RAG use GPT-4 for critique?', // repeat
    ])
    expect(queries).toEqual(['How does Self-RAG use GPT-4 for critique?'])
    expect(dropped).toBe(5)
  })

  it('keeps at most three rewrites', () => {
    expect(validateRewrites('q', ['a', 'b', 'c', 'd']).queries).toEqual(['a', 'b', 'c'])
  })
})

describe('buildExpandPrompt', () => {
  it('lists the documents and the question', () => {
    expect(buildExpandPrompt('What are the tiers?', ['csf.pdf: The NIST CSF 2.0'])).toBe('Documents:\n- csf.pdf: The NIST CSF 2.0\n\nQuestion: What are the tiers?')
  })
})

describe('fuseRankings', () => {
  it('sums reciprocal ranks across lists and breaks ties by the earliest list', () => {
    const fused = fuseRankings([[hit('a'), hit('b')], [hit('c'), hit('a')]])
    // a: 1/61 + 1/62, c: 1/61, b: 1/62.
    expect(fused.map(h => h.id)).toEqual(['a', 'c', 'b'])
  })

  it('applies weights', () => {
    const fused = fuseRankings([[hit('a')], [hit('b')]], [0.5, 1])
    expect(fused.map(h => h.id)).toEqual(['b', 'a'])
  })
})

describe('expand', () => {
  it('returns validated rewrites', async () => {
    expect(await expand(answering(['In the CSF, what are the tiers?', '']), 'What are the tiers?', ['csf.pdf'])).toEqual(['In the CSF, what are the tiers?'])
  })

  it('returns no rewrites without a model, on failure or on timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await expand(undefined, 'q', [])).toEqual([])
    expect(await expand(modelReturning(async () => { throw new Error('boom') }), 'q', [])).toEqual([])
    expect(await expand(modelReturning(() => new Promise(() => {})), 'q', [], { timeoutMs: 20 })).toEqual([])
    warn.mockRestore()
  })
})

describe('documentCatalog', () => {
  it('describes each document by its topmost first-page text', async () => {
    clearCatalogCache()
    const rect = (y: number) => ({ rects: [{ x1: 0, x2: 1, y1: y - 10, y2: y }] })
    const rows: Record<string, unknown[]> = {
      documents: [{ id: 'd1', filename: 'raptor.pdf' }, { id: 'd2', filename: 'blank.pdf' }],
      chunks: [
        { document_id: 'd1', content: 'Intro paragraph lower on the page', highlight: rect(200) },
        { document_id: 'd1', content: 'RAPTOR:   Recursive Abstractive Processing', highlight: rect(760) },
      ],
    }
    const from = (name: string) => {
      const query = { select: () => query, order: () => query, eq: () => query, then: (resolve: (v: unknown) => void) => resolve({ data: rows[name], error: null }) }
      return query
    }
    const catalog = await documentCatalog({ from } as unknown as SupabaseClient)
    expect(catalog.map(catalogLine)).toEqual(['raptor.pdf: RAPTOR: Recursive Abstractive Processing', 'blank.pdf'])
    clearCatalogCache()
  })
})

describe('documentCatalog cache', () => {
  const counting = (lead: boolean) => {
    const from = vi.fn((name: string) => {
      const rows = name === 'documents'
        ? [{ id: 'd1', filename: 'new.pdf' }]
        : lead ? [{ document_id: 'd1', content: 'Title', highlight: null }] : []
      const query = { select: () => query, order: () => query, eq: () => query, then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }) }
      return query
    })
    return { from, supabase: { from } as unknown as SupabaseClient }
  }

  it('keeps a document without a lead (chunks still being stored) only briefly', async () => {
    clearCatalogCache()
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const blank = counting(false)
    await documentCatalog(blank.supabase)
    await documentCatalog(blank.supabase)
    expect(blank.from).toHaveBeenCalledTimes(2) // one refresh: documents + chunks
    now.mockReturnValue(31_000)
    await documentCatalog(blank.supabase)
    expect(blank.from).toHaveBeenCalledTimes(4)

    clearCatalogCache()
    const full = counting(true)
    await documentCatalog(full.supabase)
    now.mockReturnValue(31_000 + 5 * 60_000)
    await documentCatalog(full.supabase)
    expect(full.from).toHaveBeenCalledTimes(2)
    now.mockRestore()
    clearCatalogCache()
  })
})

describe('retrieveSources with an expander', () => {
  /** Fake Supabase: hybrid_search answers per query text; documents and first-page chunks for the catalog. */
  function fakeSupabase(results: Record<string, string[]>) {
    const rpc = vi.fn(async (_fn: string, args: { query_text: string }) => ({
      data: (results[args.query_text] ?? []).map(id => ({ id, document_id: 'd1', page_number: 1, content: id, highlight: null, created_at: '', score: 1 })),
      error: null,
    }))
    const table = (rows: unknown[]) => {
      const query = { select: () => query, order: () => query, eq: () => query, in: () => query, then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }) }
      return query
    }
    const from = (name: string) => name === 'documents'
      ? table([{ id: 'd1', filename: 'csf.pdf' }])
      : table([{ document_id: 'd1', content: 'The NIST CSF 2.0', highlight: null }])
    return { rpc, supabase: { rpc, from } as unknown as SupabaseClient }
  }
  const embed = async (texts: string[]) => texts.map(() => [1])

  it('searches each rewrite and fuses the lists with the question\'s', async () => {
    const { rpc, supabase } = fakeSupabase({ 'What are the tiers?': ['a', 'b'], 'CSF tiers': ['c', 'a'] })
    const result = await retrieveSources(supabase, embed, 'What are the tiers?', { expander: answering(['CSF tiers']) })
    expect(result.rewrites).toEqual(['CSF tiers'])
    expect(result.sources.map(s => s.chunkId)).toEqual(['a', 'c', 'b'])
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('falls back to the question\'s own hits when a rewrite search fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { supabase } = fakeSupabase({ 'What are the tiers?': ['a', 'b'], 'CSF tiers': ['c'] })
    let calls = 0
    const flaky = async (texts: string[]) => {
      if (++calls > 1) throw new Error('embedding quota exhausted')
      return texts.map(() => [1])
    }
    const result = await retrieveSources(supabase, flaky, 'What are the tiers?', { expander: answering(['CSF tiers']) })
    expect(result.rewrites).toEqual([])
    expect(result.sources.map(s => s.chunkId)).toEqual(['a', 'b'])
    warn.mockRestore()
  })

  it('rethrows a rewrite failure when the caller aborted', async () => {
    const { supabase } = fakeSupabase({ 'What are the tiers?': ['a'], 'CSF tiers': ['c'] })
    const abort = new AbortController()
    let calls = 0
    const embedThenAbort = async (texts: string[]) => {
      if (++calls > 1) {
        abort.abort()
        throw new Error('aborted')
      }
      return texts.map(() => [1])
    }
    await expect(retrieveSources(supabase, embedThenAbort, 'What are the tiers?', { expander: answering(['CSF tiers']), abortSignal: abort.signal })).rejects.toThrow('aborted')
  })

  it('searches the question alone when the expander returns nothing', async () => {
    const { rpc, supabase } = fakeSupabase({ 'What is PR.DS-11?': ['a'] })
    const result = await retrieveSources(supabase, embed, 'What is PR.DS-11?', { expander: answering([]) })
    expect(result.rewrites).toEqual([])
    expect(result.sources.map(s => s.chunkId)).toEqual(['a'])
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
