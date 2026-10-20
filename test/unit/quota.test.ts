import type { SupabaseClient } from '@supabase/supabase-js'
import type { H3Event } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// server/utils/quota.ts uses Nitro's auto-imported h3 helpers; stub them with
// minimal fakes (h3 isn't resolvable from the unit project).
type FakeEvent = { headers: Record<string, string>, set: Record<string, unknown>, node: { req: { socket: { remoteAddress?: string } } } }
const fakeEvent = (headers: Record<string, string> = {}, remoteAddress = '10.0.0.1'): FakeEvent =>
  ({ headers, set: {}, node: { req: { socket: { remoteAddress } } } })

beforeAll(() => {
  vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.headers[name])
  vi.stubGlobal('setResponseHeader', (event: FakeEvent, name: string, value: unknown) => {
    event.set[name] = value
  })
  vi.stubGlobal('createError', (input: { statusCode: number, message: string, data?: unknown }) => Object.assign(new Error(input.message), input))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const quota = await import('../../server/utils/quota')
const asEvent = (e: FakeEvent) => e as unknown as H3Event

// warnOnce state is module-wide: each warn-once test uses its own key, and no
// earlier test may trigger it.
describe('clientIp', () => {
  it('uses the socket address unless a trusted header is configured', () => {
    const event = fakeEvent({ 'x-forwarded-for': '6.6.6.6' })
    expect(quota.clientIp(asEvent(event), '')).toBe('10.0.0.1')
    expect(quota.clientIp(asEvent(fakeEvent({ 'cf-connecting-ip': '1.2.3.4' })), 'CF-Connecting-IP')).toBe('1.2.3.4')
  })

  it('takes the address the trusted proxy appended to x-forwarded-for', () => {
    expect(quota.clientIp(asEvent(fakeEvent({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' })), 'x-forwarded-for')).toBe('1.2.3.4')
  })

  it('falls back to the socket when the trusted header is missing, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(quota.clientIp(asEvent(fakeEvent()), 'cf-connecting-ip')).toBe('10.0.0.1')
    quota.clientIp(asEvent(fakeEvent()), 'cf-connecting-ip')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('cf-connecting-ip is missing')
  })

  it('warns once in production when an unset header leaves a private socket address', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NODE_ENV', 'production')
    quota.clientIp(asEvent(fakeEvent({}, '203.0.113.7')), '')
    expect(warn).not.toHaveBeenCalled()
    // Carrier-grade NAT (100.64.0.0/10) counts as private.
    quota.clientIp(asEvent(fakeEvent({}, '100.64.0.9')), '')
    expect(warn).toHaveBeenCalledTimes(1)
    quota.clientIp(asEvent(fakeEvent({}, '::ffff:172.16.0.2')), '')
    quota.clientIp(asEvent(fakeEvent({}, '10.0.0.1')), '')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('NUXT_TRUSTED_IP_HEADER is unset')
  })

  it('normalises the address it returns', () => {
    expect(quota.clientIp(asEvent(fakeEvent({}, '::ffff:1.2.3.4')), '')).toBe('1.2.3.4')
    expect(quota.clientIp(asEvent(fakeEvent({ 'x-real-ip': '2001:db8:1:2::abcd' })), 'x-real-ip')).toBe('2001:db8:1:2::/64')
  })
})

describe('normalizeIp', () => {
  it('maps IPv4-mapped IPv6 to the IPv4 address', () => {
    expect(quota.normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(quota.normalizeIp('::FFFF:1.2.3.4')).toBe('1.2.3.4')
    expect(quota.normalizeIp('1.2.3.4')).toBe('1.2.3.4')
  })

  it('reduces IPv6 to its /64, whatever the notation', () => {
    const prefix = '2001:db8:0:1::/64'
    expect(quota.normalizeIp('2001:db8:0:1::1')).toBe(prefix)
    expect(quota.normalizeIp('2001:0db8:0000:0001:ffff:ffff:ffff:ffff')).toBe(prefix)
    expect(quota.normalizeIp('[2001:DB8:0:1:0:0:0:2]')).toBe(prefix)
    expect(quota.normalizeIp('2001:db8::1:0:0:0')).toBe('2001:db8:0:0::/64')
    expect(quota.normalizeIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(quota.normalizeIp('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64')
    expect(quota.normalizeIp('::1')).toBe('0:0:0:0::/64')
  })

  it('leaves anything else as it is', () => {
    expect(quota.normalizeIp('unknown')).toBe('unknown')
  })
})

describe('quotaLimit', () => {
  it('accepts whole numbers, also as strings', () => {
    expect(quota.quotaLimit(80, 'X')).toBe(80)
    expect(quota.quotaLimit('80', 'X')).toBe(80)
    expect(quota.quotaLimit(0, 'X')).toBe(0)
  })

  it('closes the route on anything else, with one warning per setting', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const value of ['80k', '80/day', 80.5, 2 ** 31, '', ' ', null, undefined, true]) {
      expect(quota.quotaLimit(value, 'NUXT_QUOTA_TEST')).toBe(0)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('NUXT_QUOTA_TEST="80k" is not a whole number')
  })
})

describe('clientKey', () => {
  it('is stable per IP and secret, and does not contain the IP', () => {
    const key = quota.clientKey('secret', '1.2.3.4')
    expect(key).toBe(quota.clientKey('secret', '1.2.3.4'))
    expect(key).not.toBe(quota.clientKey('secret', '1.2.3.5'))
    expect(key).not.toBe(quota.clientKey('other', '1.2.3.4'))
    expect(key).not.toContain('1.2.3.4')
  })
})

describe('secondsUntilUtcMidnight', () => {
  it('counts to the next 00:00 UTC', () => {
    expect(quota.secondsUntilUtcMidnight(new Date('2026-10-20T23:59:00Z'))).toBe(60)
    expect(quota.secondsUntilUtcMidnight(new Date('2026-10-20T00:00:00Z'))).toBe(86_400)
  })
})

describe('enforceDailyQuota', () => {
  const limits = { perClient: 30, global: 80 }
  const options = { trustedIpHeader: '', secret: 's' }
  const supabaseReturning = (data: unknown, error: unknown = null) => {
    const rpc = vi.fn(async () => ({ data, error }))
    return { rpc, supabase: { rpc } as unknown as SupabaseClient }
  }

  it('consumes the client and global counters in one call', async () => {
    const { rpc, supabase } = supabaseReturning([{ allowed: true, blocked_scope: null }])
    await quota.enforceDailyQuota(asEvent(fakeEvent()), supabase, 'chat', limits, options)
    expect(rpc).toHaveBeenCalledWith('consume_quotas', {
      p_scopes: ['chat:client', 'chat:global'],
      p_keys: [quota.clientKey('s', '10.0.0.1'), 'all'],
      p_limits: [30, 80],
    })
  })

  it('throws a 429 with Retry-After and the blocked quota', async () => {
    const event = fakeEvent()
    const { supabase } = supabaseReturning([{ allowed: false, blocked_scope: 'chat:client' }])
    const error = await quota.enforceDailyQuota(asEvent(event), supabase, 'chat', limits, options).catch(e => e)
    expect(error).toMatchObject({ statusCode: 429, data: { quota: 'client', resource: 'chat' } })
    expect(error.message).toContain('limit of 30 questions')
    expect(event.set['Retry-After']).toBeGreaterThan(0)

    const global = await quota.enforceDailyQuota(asEvent(fakeEvent()), supabaseReturning([{ allowed: false, blocked_scope: 'chat:global' }]).supabase, 'chat', limits, options).catch(e => e)
    expect(global).toMatchObject({ statusCode: 429, data: { quota: 'global' } })
  })

  it('lets the request through when the counter store fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { supabase } = supabaseReturning(null, { message: 'connection refused' })
    await expect(quota.enforceDailyQuota(asEvent(fakeEvent()), supabase, 'search', limits, options)).resolves.toBeUndefined()
  })
})
