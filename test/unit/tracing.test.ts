import { setLangfuseTracerProvider } from '@langfuse/tracing'
import { APICallError } from '@ai-sdk/provider'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCatalogCache } from '../../server/rag/catalog'
import type { TaskModel } from '../../server/rag/model'
import { retrieveSources } from '../../server/rag/retrieve'

// Phase 10: the Langfuse observations retrieval emits, captured in memory.

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })

beforeAll(() => {
  provider.register() // also the AsyncLocalStorage context manager, for nesting across awaits
  setLangfuseTracerProvider(provider)
})
afterAll(async () => {
  setLangfuseTracerProvider(null)
  await provider.shutdown()
  trace.disable()
  context.disable()
})
beforeEach(() => {
  exporter.reset()
  clearCatalogCache()
})

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}
const model = (doGenerate: () => Promise<unknown>): TaskModel => ({ model: new MockLanguageModelV4({ doGenerate: doGenerate as never }), id: 'mock/model', providerOptions: {} })
const answering = (json: unknown) => model(async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }))
const rateLimited = model(async () => {
  throw new APICallError({ message: 'rate limited', url: 'https://x', requestBodyValues: {}, statusCode: 429 })
})

function fakeSupabase() {
  const rpc = async (_fn: string, args: { query_text: string }) => ({
    data: ['a', 'b', 'c'].map(id => ({ id: `${args.query_text}-${id}`, document_id: 'd1', page_number: 1, content: id, highlight: null, created_at: '', score: 1 })),
    error: null,
  })
  const table = (rows: unknown[]) => {
    const query = { select: () => query, order: () => query, eq: () => query, in: () => query, then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }) }
    return query
  }
  const from = (name: string) => name === 'documents' ? table([{ id: 'd1', filename: 'csf.pdf' }]) : table([])
  return { rpc, from } as unknown as SupabaseClient
}
const embed = async (texts: string[]) => texts.map(() => [1])

const attr = (span: ReadableSpan, key: string) => span.attributes[`langfuse.observation.${key}`]
const named = (name: string) => exporter.getFinishedSpans().find(s => s.name === name)!
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId

describe('retrieval tracing', () => {
  it('nests rewrite and rerank under a retriever observation', async () => {
    const result = await retrieveSources(fakeSupabase(), embed, 'What are the tiers?', {
      expander: answering({ queries: ['CSF tiers'] }),
      reranker: answering({ ranking: [2, 1] }),
    })
    expect(result.rewrites).toEqual(['CSF tiers'])

    const retrieve = named('retrieve')
    expect(attr(retrieve, 'type')).toBe('retriever')
    expect(String(attr(retrieve, 'input'))).toContain('What are the tiers?')
    for (const step of ['rewrite', 'rerank']) {
      expect(attr(named(step), 'type')).toBe('chain')
      expect(parentOf(named(step))).toBe(retrieve.spanContext().spanId)
    }
    expect(String(attr(named('rewrite'), 'output'))).toContain('CSF tiers')
  })

  it('marks a failed rerank as a warning and keeps the fused order', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await retrieveSources(fakeSupabase(), embed, 'q', { reranker: rateLimited })
    expect(result.reranked).toBe(false)
    expect(attr(named('rerank'), 'level')).toBe('WARNING')
    expect(String(attr(named('rerank'), 'status_message'))).toContain('fused order kept')
    warn.mockRestore()
  })
})
