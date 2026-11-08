import { afterEach, describe, expect, it, vi } from 'vitest'

// POST /api/chat's guards, in order, with Nitro's auto-imports stubbed: the
// Turnstile check runs before the body is read and before the quota counts
// the request, so a request without a valid token spends no daily budget.
const calls: string[] = []
let turnstile: () => Promise<void> = async () => {}
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('assertSameSiteJson', () => { calls.push('same-site') })
vi.stubGlobal('assertTurnstile', async (_event: unknown, action: string) => {
  calls.push(`turnstile:${action}`)
  await turnstile()
})
vi.stubGlobal('readValidatedBody', async () => {
  calls.push('body')
  return { question: 'q' }
})
vi.stubGlobal('useRuntimeConfig', () => ({ cloudflareAccountId: '', cloudflareApiToken: '' }))
vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))

const { default: handler } = await import('../../server/api/chat.post') as unknown as { default: (event: unknown) => Promise<unknown> }
const call = () => handler({ node: { res: { on: () => {}, writableFinished: false } } })

describe('POST /api/chat guards', () => {
  afterEach(() => {
    calls.length = 0
    turnstile = async () => {}
  })

  it('checks Turnstile after the same-site check and before reading the body', async () => {
    // No Cloudflare values: the route stops with a 503 right after the body.
    await expect(call()).rejects.toMatchObject({ statusCode: 503 })
    expect(calls).toEqual(['same-site', 'turnstile:chat', 'body'])
  })

  it('stops at a failed check, before the body and the quota', async () => {
    turnstile = async () => { throw Object.assign(new Error('The browser check did not pass.'), { statusCode: 403 }) }
    await expect(call()).rejects.toMatchObject({ statusCode: 403 })
    expect(calls).toEqual(['same-site', 'turnstile:chat'])
  })
})
