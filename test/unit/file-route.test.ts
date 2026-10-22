import { afterAll, describe, expect, it, vi } from 'vitest'
import { staticPdfUrl } from '../../server/utils/static-pdfs'

// GET /api/documents/:id/file with Nitro's auto-imports stubbed (h3 isn't
// resolvable from the unit project). The stubs go in before the import:
// defineEventHandler runs when the route module loads.
const CORPUS_ID = '1fabb474-16e5-4ef2-ae0c-3d883bf98d29'
const UPLOAD_ID = '00000000-0000-4000-a000-000000000001'
const rows: Record<string, { filename: string, storage_path: string }> = {
  [CORPUS_ID]: { filename: 'nist-csf-2.0.pdf', storage_path: `${CORPUS_ID}.pdf` },
  [UPLOAD_ID]: { filename: 'uploaded.pdf', storage_path: `${UPLOAD_ID}.pdf` },
}
const signed: string[] = []
const headers: Record<string, string>[] = []
const supabase = {
  from: () => {
    let id = ''
    const query = {
      select: () => query,
      eq: (_column: string, value: string) => {
        id = value
        return query
      },
      maybeSingle: async () => ({ data: rows[id] ?? null, error: null }),
    }
    return query
  },
  storage: {
    from: () => ({
      createSignedUrl: async (path: string) => {
        signed.push(path)
        return { data: { signedUrl: `https://storage.example/sign/${path}?token=t` }, error: null }
      },
    }),
  },
}

vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('getValidatedRouterParams', async (event: { params: unknown }, parse: (value: unknown) => unknown) => parse(event.params))
vi.stubGlobal('serverSupabase', () => supabase)
vi.stubGlobal('setResponseHeader', (event: { headers: Record<string, string> }, name: string, value: string) => {
  event.headers[name] = value
})
vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
vi.stubGlobal('staticPdfUrl', staticPdfUrl)
afterAll(() => {
  vi.unstubAllGlobals()
})

const { default: handler } = await import('../../server/api/documents/[id]/file.get') as unknown as {
  default: (event: { params: { id: string }, headers: Record<string, string> }) => Promise<{ url: string, expiresAt?: string }>
}
const get = (id: string) => {
  const event = { params: { id }, headers: {} }
  headers.push(event.headers)
  return handler(event)
}

describe('GET /api/documents/:id/file', () => {
  it('opens a corpus PDF from /pdfs, without signing a Storage URL', async () => {
    expect(await get(CORPUS_ID)).toEqual({ url: '/pdfs/nist-csf-2.0.pdf' })
    expect(signed).toEqual([])
    expect(headers.at(-1)).toEqual({ 'Cache-Control': 'no-store' })
  })

  it('signs a short-lived Storage URL for any other document', async () => {
    const { url, expiresAt } = await get(UPLOAD_ID)
    expect(url).toBe(`https://storage.example/sign/${UPLOAD_ID}.pdf?token=t`)
    expect(signed).toEqual([`${UPLOAD_ID}.pdf`])
    expect(Date.parse(expiresAt!)).toBeGreaterThan(Date.now())
    expect(headers.at(-1)).toEqual({ 'Cache-Control': 'no-store' })
  })

  it('answers 404 for an unknown document', async () => {
    await expect(get('00000000-0000-4000-a000-0000000000ff')).rejects.toMatchObject({ statusCode: 404 })
  })
})
