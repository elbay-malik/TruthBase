import { afterEach, describe, expect, it } from 'vitest'
import { onVercel, platformWaitUntil, trustedIpHeader, uploadLimit, VERCEL_CLIENT_IP_HEADER } from '../../server/utils/platform'

// Phase 14 (ADR-0011): what changes when the bundle runs as a Vercel Function.

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context')
const globals = globalThis as { [REQUEST_CONTEXT]?: unknown }
afterEach(() => {
  Reflect.deleteProperty(globals, REQUEST_CONTEXT)
})

describe('onVercel', () => {
  it('is true only with VERCEL=1', () => {
    expect(onVercel({ VERCEL: '1' })).toBe(true)
    expect(onVercel({})).toBe(false)
    expect(onVercel({ VERCEL: '' })).toBe(false)
  })
})

describe('trustedIpHeader', () => {
  it('defaults to x-vercel-forwarded-for on Vercel only', () => {
    expect(VERCEL_CLIENT_IP_HEADER).toBe('x-vercel-forwarded-for')
    expect(trustedIpHeader('', { VERCEL: '1' })).toBe('x-vercel-forwarded-for')
    expect(trustedIpHeader(undefined, { VERCEL: '1' })).toBe('x-vercel-forwarded-for')
    expect(trustedIpHeader('', {})).toBe('')
  })

  it('keeps a configured header, on Vercel too', () => {
    expect(trustedIpHeader('x-real-ip', { VERCEL: '1' })).toBe('x-real-ip')
    expect(trustedIpHeader(' cf-connecting-ip ', {})).toBe('cf-connecting-ip')
  })
})

describe('platformWaitUntil', () => {
  it('is undefined outside Vercel', () => {
    expect(platformWaitUntil()).toBeUndefined()
    globals[REQUEST_CONTEXT] = { get: () => undefined }
    expect(platformWaitUntil()).toBeUndefined()
  })

  it('hands promises to the invocation context', () => {
    const waited: Promise<unknown>[] = []
    const context = {
      promises: waited,
      waitUntil(this: { promises: Promise<unknown>[] }, promise: Promise<unknown>) {
        this.promises.push(promise)
      },
    }
    globals[REQUEST_CONTEXT] = { get: () => context }
    const promise = Promise.resolve()
    platformWaitUntil()!(promise)
    expect(waited).toEqual([promise])
  })
})

describe('uploadLimit', () => {
  const MB = 1024 * 1024
  it('stays under the Vercel Functions 4.5 MB body limit on Vercel', () => {
    const limit = uploadLimit(true, 20 * MB)
    expect(limit.maxRequestBytes).toBeLessThanOrEqual(4.5 * MB)
    expect(limit.message).toContain('4.5 MB')
    expect(limit.message).toContain('CLI')
  })

  it('allows the PDF limit plus multipart framing elsewhere', () => {
    expect(uploadLimit(false, 20 * MB)).toEqual({ maxRequestBytes: 21 * MB, message: 'PDFs are limited to 20 MB.' })
  })
})
