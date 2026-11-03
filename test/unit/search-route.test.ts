import { APICallError } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'

// POST /api/search failure mapping, with Nitro's auto-imports stubbed.
const retrieveSources = vi.fn()
vi.mock('../../server/rag/retrieve', () => ({ retrieveSources }))
let runtimeConfig: Record<string, string> = {}
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('assertSameSiteJson', () => {})
vi.stubGlobal('readValidatedBody', async () => ({ query: 'q' }))
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
vi.stubGlobal('serverSupabase', () => ({}))
vi.stubGlobal('quotaConfig', () => undefined)
vi.stubGlobal('enforceQuota', async () => {})
vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))

const { default: handler } = await import('../../server/api/search.post') as unknown as { default: (event: unknown) => Promise<unknown> }
const call = () => handler({ node: { res: { on: () => {}, writableFinished: false } } })

const apiError = (statusCode: number) => new APICallError({ message: 'provider said something', url: 'u', requestBodyValues: {}, statusCode })

describe('POST /api/search failures', () => {
  afterEach(() => {
    retrieveSources.mockReset()
    vi.restoreAllMocks()
  })

  it('is 503 without the Cloudflare values, before touching retrieval', async () => {
    runtimeConfig = { cloudflareAccountId: 'acct', cloudflareApiToken: '' }
    await expect(call()).rejects.toMatchObject({ statusCode: 503 })
    expect(retrieveSources).not.toHaveBeenCalled()
  })

  it('maps provider limits to 503 and other failures to 502, keeping causes in the log', async () => {
    runtimeConfig = { cloudflareAccountId: 'acct', cloudflareApiToken: 'token' }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    retrieveSources.mockRejectedValueOnce(apiError(429))
    await expect(call()).rejects.toMatchObject({ statusCode: 503, message: 'Search is busy, try again later.' })
    retrieveSources.mockRejectedValueOnce(new Error('document lookup failed: relation "x" does not exist'))
    await expect(call()).rejects.toMatchObject({ statusCode: 502, message: 'Search failed.' })
    expect(log).toHaveBeenCalledWith('[search] retrieval failed:', expect.stringContaining('does not exist'))
  })

  it('still reports a timeout as 504', async () => {
    runtimeConfig = { cloudflareAccountId: 'acct', cloudflareApiToken: 'token' }
    retrieveSources.mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'TimeoutError' }))
    await expect(call()).rejects.toMatchObject({ statusCode: 504 })
  })
})
