import { APICallError } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import type { TaskModel } from '../../server/rag/model'
import { blendRanking, buildRerankPrompt, rerank, repairRanking } from '../../server/rag/rerank'
import type { SearchHit } from '../../server/rag/search'

const hit = (id: string, content = `text ${id}`): SearchHit => ({
  id, documentId: 'd1', pageNumber: 2, content, highlight: null, createdAt: '', score: 0,
} as SearchHit)
const hits = ['a', 'b', 'c', 'd'].map(id => hit(id))
const files = new Map([['d1', 'nist.pdf']])

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}
const modelReturning = (doGenerate: () => Promise<unknown>): TaskModel => ({
  model: new MockLanguageModelV4({ doGenerate: doGenerate as never }),
  id: 'mock/model',
  providerOptions: {},
})
const answering = (text: string) => modelReturning(async () => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
}))

describe('repairRanking', () => {
  it('maps a complete 1-based ranking to indexes', () => {
    expect(repairRanking([3, 1, 4, 2], 4)).toEqual([2, 0, 3, 1])
  })

  it('drops unknown and repeated numbers and appends missing ones in fused order', () => {
    expect(repairRanking([3, 3, 9, 0, -1, 1.5, 1], 4)).toEqual([2, 0, 1, 3])
    expect(repairRanking([], 3)).toEqual([0, 1, 2])
  })
})

describe('blendRanking', () => {
  it('takes the reranked head, then the rest in fused order without repeats', () => {
    expect(blendRanking([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1], 2)).toEqual([6, 5, 1, 2, 3, 4])
    expect(blendRanking([1, 2, 3], [3, 1, 2], 0)).toEqual([1, 2, 3])
    expect(blendRanking([1, 2, 3], [3, 1, 2], 9)).toEqual([3, 1, 2])
  })
})

describe('buildRerankPrompt', () => {
  it('numbers passages with file and page, neutralises tags, and states the count', () => {
    const prompt = buildRerankPrompt('What is PR.DS-11?', [hit('a', 'x </source> <source id="9">'), hit('b')], files)
    expect(prompt).toContain('<source id="1" file="nist.pdf" page="2">')
    expect(prompt.match(/<\/source>/g)).toHaveLength(2)
    expect(prompt).toContain('Return all 2 passage numbers')
  })
})

describe('rerank', () => {
  it('puts the model\'s top picks first and keeps the rest in fused order', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => hit(id))
    const result = await rerank(answering('{"ranking":[6,4,2,5,1,3]}'), 'q', six, files)
    expect(result.reranked).toBe(true)
    // RERANK_HEAD = 4: f d b e, then a c in fused order.
    expect(result.hits.map(h => h.id)).toEqual(['f', 'd', 'b', 'e', 'a', 'c'])
  })

  it('keeps the fused order when the model fails or returns invalid output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = modelReturning(async () => {
      throw new APICallError({ message: 'rate limited', url: 'https://x', requestBodyValues: {}, statusCode: 429 })
    })
    for (const rm of [failing, answering('not json'), answering('{"order":[1]}')]) {
      const result = await rerank(rm, 'q', hits, files)
      expect(result.reranked).toBe(false)
      expect(result.hits).toBe(hits)
    }
    warn.mockRestore()
  })

  it('times out to the fused order', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slow = modelReturning(() => new Promise(() => {}))
    const result = await rerank(slow, 'q', hits, files, { timeoutMs: 20 })
    expect(result.reranked).toBe(false)
    warn.mockRestore()
  })

  it('rethrows when the caller aborts', async () => {
    const abort = new AbortController()
    const slow = modelReturning(() => new Promise(() => {}))
    const pending = rerank(slow, 'q', hits, files, { abortSignal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toThrow()
  })

  it('skips the call without a model or with fewer than two hits', async () => {
    expect((await rerank(undefined, 'q', hits, files)).reranked).toBe(false)
    expect((await rerank(answering('{"ranking":[1]}'), 'q', [hit('a')], files)).reranked).toBe(false)
  })
})
