import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudflareEmbedder, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embeddingsConfigured } from '../../server/ingest/embed'
import { documentTitle, embeddingText } from '../../server/ingest/title'

const keys = { cloudflareAccountId: 'acct', cloudflareApiToken: 'token' }

function stubEmbeddings(vectors: number[][], status = 200) {
  const calls: { url: string, body: { model: string, input: string[] }, authorization: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), authorization: new Headers(init.headers).get('authorization') })
    return new Response(JSON.stringify(status === 200
      ? { object: 'list', data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })), model: EMBEDDING_MODEL }
      : { error: { message: 'capacity' } }), { status, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

describe('cloudflareEmbedder', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('calls bge-m3 on the account and returns unit vectors in order', async () => {
    const calls = stubEmbeddings([[3, 4, ...new Array(EMBEDDING_DIMENSIONS - 2).fill(0)], [0, 2, ...new Array(EMBEDDING_DIMENSIONS - 2).fill(0)]])
    const vectors = await cloudflareEmbedder(keys)(['a', 'b'])
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/embeddings')
    expect(calls[0]!.authorization).toBe('Bearer token')
    expect(calls[0]!.body).toMatchObject({ model: '@cf/baai/bge-m3', input: ['a', 'b'] })
    expect(vectors[0]!.slice(0, 2)).toEqual([0.6, 0.8])
    expect(vectors[1]!.slice(0, 2)).toEqual([0, 1])
  })

  it('refuses vectors of another size: they would fail or rank wrongly in the column', async () => {
    stubEmbeddings([[1, 0, 0]])
    await expect(cloudflareEmbedder(keys)(['a'])).rejects.toThrow('expected 1024-dim')
  })

  it('needs both values', () => {
    expect(embeddingsConfigured(keys)).toBe(true)
    expect(embeddingsConfigured({ cloudflareAccountId: 'acct', cloudflareApiToken: '' })).toBe(false)
    expect(() => cloudflareEmbedder({})).toThrow('not configured')
  })

  it('gives up after its retries when the provider keeps failing', async () => {
    const calls = stubEmbeddings([], 503)
    await expect(cloudflareEmbedder(keys, undefined, { maxRetries: 0 })(['a'])).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
})

describe('cloudflareEmbedder timeouts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports a budget spent during a retry wait as a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'busy' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    })))
    await expect(cloudflareEmbedder(keys, undefined, { maxRetries: 1, timeoutMs: 50 })(['a'])).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

describe('embeddingText', () => {
  // The hosted vectors embed exactly these strings: changing one means re-embedding its document.
  it.each([
    ['nist-csf-2.0.pdf', 'The NIST Cybersecurity Framework (CSF) 2.0'],
    ['self-rag.pdf', 'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection'],
    ['nist-ai-rmf-1.0.pdf', 'Artificial Intelligence Risk Management Framework (AI RMF 1.0)'],
    ['raptor.pdf', 'RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval'],
  ])('%s keeps its measured title', (filename, title) => {
    expect(embeddingText(filename, 'body')).toBe(`${title}\n\nbody`)
  })

  it('falls back to the filename for any other PDF', () => {
    expect(documentTitle('annual-report.PDF')).toBe('annual-report')
  })
})
