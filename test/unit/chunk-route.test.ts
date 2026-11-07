import { afterAll, describe, expect, it, vi } from 'vitest'

// GET /api/chunks/:id with Nitro's auto-imports stubbed, as in file-route.test.ts.
const ID = '1fabb474-16e5-4ef2-ae0c-3d883bf98d29'
let result: { data: unknown, error: { message: string } | null } = { data: null, error: null }
const query = {
  select: () => query,
  eq: () => query,
  maybeSingle: async () => result,
}

type Options = { name: string, getKey: (event: unknown) => string, maxAge: number, swr: boolean }
let options: Options | undefined
vi.stubGlobal('defineCachedEventHandler', (handler: unknown, opts: Options) => {
  options = opts
  return handler
})
const createError = (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input)
// As h3 does: a validator that throws becomes a 400.
vi.stubGlobal('getValidatedRouterParams', async (event: { params: unknown }, parse: (value: unknown) => unknown) => {
  try {
    return parse(event.params)
  }
  catch {
    throw createError({ statusCode: 400, message: 'Validation Error' })
  }
})
vi.stubGlobal('getRouterParam', (event: { params: { id?: string } }) => event.params.id)
const serverSupabase = vi.fn(() => ({ from: () => query }))
vi.stubGlobal('serverSupabase', serverSupabase)
vi.stubGlobal('createError', createError)
afterAll(() => {
  vi.unstubAllGlobals()
})

const { default: handler } = await import('../../server/api/chunks/[id].get') as unknown as {
  default: (event: { params: { id: string } }) => Promise<Record<string, unknown>>
}

describe('GET /api/chunks/:id', () => {
  it('is cached for a day per id, whatever the query string', () => {
    expect(options).toMatchObject({ name: 'chunks', maxAge: 86_400, swr: true })
    expect(options!.getKey({ params: { id: ID }, path: `/api/chunks/${ID}?x=1` })).toBe(ID)
  })

  it('returns the chunk as a source', async () => {
    result = { data: { id: ID, document_id: 'd', page_number: 3, content: 'text', highlight: null, documents: { filename: 'a.pdf' } }, error: null }
    await expect(handler({ params: { id: ID } })).resolves.toEqual({ index: 1, chunkId: ID, documentId: 'd', filename: 'a.pdf', pageNumber: 3, content: 'text', highlight: null })
  })

  it('throws on an unknown id or a failed lookup, which are never cached', async () => {
    result = { data: null, error: null }
    await expect(handler({ params: { id: ID } })).rejects.toMatchObject({ statusCode: 404 })
    result = { data: null, error: { message: 'secret detail' } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = await handler({ params: { id: ID } }).catch(e => e)
    spy.mockRestore()
    expect(error).toMatchObject({ statusCode: 502 })
    expect(error.message).not.toContain('secret detail')
  })

  it('rejects a malformed id before the database', async () => {
    serverSupabase.mockClear()
    await expect(handler({ params: { id: 'nope' } })).rejects.toMatchObject({ statusCode: 400 })
    expect(serverSupabase).not.toHaveBeenCalled()
  })

  it('accepts only the lower-case spelling of an id, so each chunk has one cache key', async () => {
    serverSupabase.mockClear()
    for (const id of [ID.toUpperCase(), ID.replace('fabb', 'FAbb')]) {
      await expect(handler({ params: { id } }), id).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(serverSupabase).not.toHaveBeenCalled()
  })
})
