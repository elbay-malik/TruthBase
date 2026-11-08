import type { H3Event } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// server/utils/turnstile.ts: Siteverify is a stubbed fetch, and Nitro's
// auto-imported h3 helpers are minimal fakes (as in same-site.test.ts).
type FakeEvent = { headers: Record<string, string>, node: { req: { socket: { remoteAddress: string } } } }
let runtimeConfig: Record<string, unknown> = {}

beforeAll(() => {
  vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.headers[name])
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const { assertTurnstile, turnstileHostnames, verifyTurnstile } = await import('../../server/utils/turnstile')

const SETTINGS = { secret: 'secret', hostnames: 'truthbase.elbaymalik.com, truthbase-brown.vercel.app', required: true, production: true }
const PASS = { 'success': true, 'action': 'chat', 'hostname': 'truthbase.elbaymalik.com', 'error-codes': [] }
const siteverify = (answer: unknown, status = 200) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(answer), { status }))

describe('verifyTurnstile', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a successful answer with the expected action and hostname, sending the secret, token and client IP', async () => {
    const fetchImpl = siteverify(PASS)
    expect(await verifyTurnstile('token', 'chat', SETTINGS, '203.0.113.7', fetchImpl)).toBe('ok')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    const body = new URLSearchParams(String(init?.body))
    expect(Object.fromEntries(body)).toEqual({ secret: 'secret', response: 'token', remoteip: '203.0.113.7' })
  })

  it('leaves out a client key that is not an IP address', async () => {
    const fetchImpl = siteverify(PASS)
    await verifyTurnstile('token', 'chat', SETTINGS, 'internal', fetchImpl)
    expect(new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body)).has('remoteip')).toBe(false)
  })

  it('rejects a missing or oversized token without calling Siteverify', async () => {
    const fetchImpl = siteverify(PASS)
    expect(await verifyTurnstile(undefined, 'chat', SETTINGS, undefined, fetchImpl)).toBe('rejected')
    expect(await verifyTurnstile('', 'chat', SETTINGS, undefined, fetchImpl)).toBe('rejected')
    expect(await verifyTurnstile('x'.repeat(2049), 'chat', SETTINGS, undefined, fetchImpl)).toBe('rejected')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a failed, replayed, wrong-action or wrong-hostname answer', async () => {
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({ 'success': false, 'error-codes': ['timeout-or-duplicate'] }))).toBe('rejected')
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({ ...PASS, action: 'login' }))).toBe('rejected')
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({ ...PASS, hostname: 'evil.example' }))).toBe('rejected')
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({ ...PASS, hostname: 'localhost' }))).toBe('rejected')
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({ action: 'chat', hostname: 'truthbase.elbaymalik.com' }))).toBe('rejected')
  })

  it('accepts the other allowed hostname, in any case', async () => {
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({ ...PASS, hostname: 'TruthBase-Brown.vercel.app' }))).toBe('ok')
  })

  it('fails closed when Siteverify is unreachable or answers badly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, vi.fn(async () => { throw new TypeError('fetch failed') }))).toBe('unavailable')
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({}, 500))).toBe('unavailable')
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, vi.fn(async () => new Response('<html>')))).toBe('unavailable')
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({ 'success': false, 'error-codes': ['internal-error'] }))).toBe('unavailable')
  })

  it('reports a rejected secret as a configuration problem, not the visitor\'s', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await verifyTurnstile('t', 'chat', SETTINGS, undefined, siteverify({ 'success': false, 'error-codes': ['invalid-input-secret'] }))).toBe('misconfigured')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NUXT_TURNSTILE_SECRET_KEY'))
  })

  it('is off without a secret, unless required; required with no hostnames is misconfigured', async () => {
    const fetchImpl = siteverify(PASS)
    expect(await verifyTurnstile(undefined, 'chat', { ...SETTINGS, secret: '', required: false }, undefined, fetchImpl)).toBe('off')
    expect(await verifyTurnstile('t', 'chat', { ...SETTINGS, secret: ' ', required: true }, undefined, fetchImpl)).toBe('misconfigured')
    expect(await verifyTurnstile('t', 'chat', { ...SETTINGS, hostnames: ' , ' }, undefined, fetchImpl)).toBe('misconfigured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts a test-key answer without an action, except where the check is required', async () => {
    const answer = { 'success': true, 'hostname': 'example.com', 'error-codes': [], 'metadata': { result_with_testing_key: true } }
    const local = { secret: '1x0000000000000000000000000000000AA', hostnames: 'example.com', required: false, production: false }
    expect(await verifyTurnstile('t', 'chat', local, undefined, siteverify(answer))).toBe('ok')
    expect(await verifyTurnstile('t', 'chat', local, undefined, siteverify({ ...answer, action: 'login' }))).toBe('rejected')
    // A real key's answer without an action still fails.
    expect(await verifyTurnstile('t', 'chat', local, undefined, siteverify({ ...answer, metadata: {} }))).toBe('rejected')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A Preview may use the test keys; Production may not.
    expect(await verifyTurnstile('t', 'chat', { ...local, required: true }, undefined, siteverify(answer))).toBe('ok')
    expect(await verifyTurnstile('t', 'chat', { ...local, required: true, production: true }, undefined, siteverify(answer))).toBe('misconfigured')
  })

  it('parses the hostname list', () => {
    expect([...turnstileHostnames(' A.example ,b.example,, ')]).toEqual(['a.example', 'b.example'])
    expect(turnstileHostnames(undefined).size).toBe(0)
  })
})

describe('assertTurnstile', () => {
  const event = (headers: Record<string, string> = {}) =>
    ({ headers, node: { req: { socket: { remoteAddress: '198.51.100.4' } } } }) as unknown as H3Event
  const statusOf = async (promise: Promise<void>) => promise.then(() => 'ok', (error: { statusCode: number }) => error.statusCode)

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('lets requests through when no secret is set off Vercel (local runs, CI)', async () => {
    runtimeConfig = { turnstileSecretKey: '', turnstileHostnames: SETTINGS.hostnames, trustedIpHeader: '' }
    vi.stubEnv('VERCEL', '')
    expect(await statusOf(assertTurnstile(event(), 'chat'))).toBe('ok')
  })

  it('closes the route on any Vercel deployment without a secret, previews included', async () => {
    runtimeConfig = { turnstileSecretKey: '', turnstileHostnames: SETTINGS.hostnames, trustedIpHeader: '' }
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(await statusOf(assertTurnstile(event(), 'chat'))).toBe(503)
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(await statusOf(assertTurnstile(event(), 'chat'))).toBe(503)
  })

  it('answers 403 for a request without a token, and 503 when Siteverify is down', async () => {
    vi.stubEnv('VERCEL', '')
    runtimeConfig = { turnstileSecretKey: 'secret', turnstileHostnames: SETTINGS.hostnames, trustedIpHeader: '' }
    expect(await statusOf(assertTurnstile(event(), 'chat'))).toBe(403)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await statusOf(assertTurnstile(event({ 'x-turnstile-token': 't' }), 'chat'))).toBe(503)
  })

  it('passes a valid token, sending the socket address as remoteip', async () => {
    vi.stubEnv('VERCEL', '')
    runtimeConfig = { turnstileSecretKey: 'secret', turnstileHostnames: SETTINGS.hostnames, trustedIpHeader: '' }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(PASS)))
    expect(await statusOf(assertTurnstile(event({ 'x-turnstile-token': 't' }), 'chat'))).toBe('ok')
    expect(new URLSearchParams(String(fetchSpy.mock.calls[0]![1]?.body)).get('remoteip')).toBe('198.51.100.4')
  })
})
