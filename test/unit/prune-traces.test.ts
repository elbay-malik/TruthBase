import { afterEach, describe, expect, it, vi } from 'vitest'

// GET /api/cron/prune-traces with Nitro's auto-imports and fetch stubbed.
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('getHeader', (event: { headers: Record<string, string> }, name: string) => event.headers[name])
vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))

const { default: handler } = await import('../../server/api/cron/prune-traces.get') as unknown as { default: (event: unknown) => Promise<unknown> }
const { pruneOldTraces } = await import('../../server/utils/trace-retention')
const call = (authorization?: string) => handler({ headers: authorization === undefined ? {} : { authorization } })

const auth = { baseUrl: 'https://lf.test', publicKey: 'pk', secretKey: 'sk' }
const NOW = Date.parse('2026-11-30T07:00:00Z')

type Page = { data: { traceId: string | null, startTime: string }[], meta?: { cursor?: string } }
interface Call { url: URL, method: string, ids?: string[], authorization: string }

function stubLangfuse(pages: Page[], options: { listStatus?: number, deleteStatus?: number } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url)
    const method = init.method ?? 'GET'
    calls.push({
      url: parsed,
      method,
      authorization: (init.headers as Record<string, string>).authorization!,
      ids: init.body ? JSON.parse(init.body as string).traceIds : undefined,
    })
    if (method === 'DELETE') return new Response('{}', { status: options.deleteStatus ?? 200 })
    if (options.listStatus) return new Response('{}', { status: options.listStatus })
    const index = Number(parsed.searchParams.get('cursor') ?? 0)
    return new Response(JSON.stringify(pages[index] ?? { data: [] }))
  }))
  return calls
}
const deletes = (calls: Call[]) => calls.filter(c => c.method === 'DELETE')

describe('pruneOldTraces', () => {
  it('only asks for records past 27 days, using Basic auth', async () => {
    const calls = stubLangfuse([{ data: [] }])
    expect(await pruneOldTraces(auth, NOW)).toEqual({ deleted: 0, partial: false })
    const params = calls[0]!.url.searchParams
    expect(params.get('toStartTime')).toBe('2026-11-03T07:00:00.000Z')
    expect(params.get('fromStartTime')).toBe('2026-10-30T07:00:00.000Z')
    expect(calls[0]!.authorization).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`)
    expect(deletes(calls)).toEqual([])
  })

  it('follows the cursor and deletes each trace once, oldest first', async () => {
    const calls = stubLangfuse([
      { data: [{ traceId: 'new', startTime: '2026-11-02T00:00:00Z' }, { traceId: 'old', startTime: '2026-11-01T02:00:00Z' }], meta: { cursor: '1' } },
      { data: [{ traceId: 'old', startTime: '2026-11-01T01:00:00Z' }, { traceId: null, startTime: '2026-11-01T00:00:00Z' }] },
    ])
    expect(await pruneOldTraces(auth, NOW)).toEqual({ deleted: 2, partial: false })
    expect(deletes(calls).map(c => c.ids)).toEqual([['old', 'new']])
    expect(deletes(calls)[0]!.url.pathname).toBe('/api/public/traces')
  })

  it('sends at most 50 ids per request', async () => {
    const data = Array.from({ length: 120 }, (_, i) => ({ traceId: `t${i}`, startTime: '2026-11-01T00:00:00Z' }))
    const calls = stubLangfuse([{ data }])
    expect(await pruneOldTraces(auth, NOW)).toEqual({ deleted: 120, partial: false })
    expect(deletes(calls).map(c => c.ids!.length)).toEqual([50, 50, 20])
  })

  it('stays under the daily delete limit and reports the remainder', async () => {
    const data = Array.from({ length: 1100 }, (_, i) => ({ traceId: `t${i}`, startTime: '2026-11-01T00:00:00Z' }))
    const calls = stubLangfuse([{ data }])
    expect(await pruneOldTraces(auth, NOW)).toEqual({ deleted: 1000, partial: true })
    expect(deletes(calls)).toHaveLength(20)
  })

  it('reports a run stopped by the page cap as partial', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ data: [{ traceId: `t${i}`, startTime: '2026-11-01T00:00:00Z' }], meta: { cursor: String(i + 1) } }))
    const calls = stubLangfuse(pages)
    expect(await pruneOldTraces(auth, NOW)).toEqual({ deleted: 10, partial: true })
    expect(calls.filter(c => c.method === 'GET')).toHaveLength(10)
  })

  it('throws when listing or deleting fails', async () => {
    stubLangfuse([], { listStatus: 429 })
    await expect(pruneOldTraces(auth, NOW)).rejects.toThrow('429')
    stubLangfuse([{ data: [{ traceId: 't', startTime: '2026-11-01T00:00:00Z' }] }], { deleteStatus: 500 })
    await expect(pruneOldTraces(auth, NOW)).rejects.toThrow('500')
  })
})

describe('GET /api/cron/prune-traces', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is closed without CRON_SECRET and refuses a wrong token, calling nothing', async () => {
    const calls = stubLangfuse([{ data: [] }])
    vi.stubEnv('CRON_SECRET', '')
    await expect(call('Bearer ')).rejects.toMatchObject({ statusCode: 503 })
    vi.stubEnv('CRON_SECRET', 's3cret')
    await expect(call('Bearer nope')).rejects.toMatchObject({ statusCode: 401 })
    expect(calls).toEqual([])
  })

  it('skips without Langfuse keys', async () => {
    const calls = stubLangfuse([{ data: [] }])
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '')
    vi.stubEnv('LANGFUSE_SECRET_KEY', '')
    expect(await call('Bearer s3cret')).toEqual({ status: 'skipped' })
    expect(calls).toEqual([])
  })

  it('returns the counts, and fails the run (502) without echoing the cause', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk')
    stubLangfuse([{ data: [] }])
    expect(await call('Bearer s3cret')).toEqual({ status: 'ok', deleted: 0, partial: false })

    stubLangfuse([], { listStatus: 500 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(call('Bearer s3cret')).rejects.toMatchObject({ statusCode: 502, message: 'Trace clean-up failed.' })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('500'))
    error.mockRestore()
  })
})
