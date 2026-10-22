import type { H3Event } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// server/utils/same-site.ts uses Nitro's auto-imported h3 helpers; stub them
// with minimal fakes (h3 isn't resolvable from the unit project).
type FakeEvent = { headers: Record<string, string> }

beforeAll(() => {
  vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.headers[name])
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const { assertSameSiteJson } = await import('../../server/utils/same-site')
const check = (headers: Record<string, string>) => {
  try {
    assertSameSiteJson({ headers } as unknown as H3Event)
    return 'ok'
  }
  catch (error) {
    return (error as { statusCode: number }).statusCode
  }
}

describe('assertSameSiteJson', () => {
  it('accepts JSON from the page itself, and from clients outside a browser', () => {
    expect(check({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })).toBe('ok')
    expect(check({ 'content-type': 'application/json; charset=utf-8' })).toBe('ok')
    expect(check({ 'sec-fetch-site': 'none', 'content-type': 'application/json' })).toBe('ok')
  })

  it('turns away browser requests from other sites, sibling subdomains included', () => {
    expect(check({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })).toBe(403)
    expect(check({ 'sec-fetch-site': 'same-site', 'content-type': 'application/json' })).toBe(403)
  })

  it('refuses the bodies a form or a no-cors fetch can send without a preflight', () => {
    expect(check({ 'content-type': 'application/x-www-form-urlencoded' })).toBe(415)
    expect(check({ 'content-type': 'text/plain;charset=UTF-8' })).toBe(415)
    expect(check({ 'content-type': 'multipart/form-data; boundary=x' })).toBe(415)
    expect(check({})).toBe(415)
  })
})
