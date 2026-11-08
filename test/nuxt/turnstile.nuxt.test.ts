import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TURNSTILE_FAILED_ERROR, TURNSTILE_TIMEOUT_ERROR, useTurnstile } from '~/composables/useTurnstile'

// app/composables/useTurnstile.ts against a fake window.turnstile: one fresh
// token per request, the widget reset after each, and no Turnstile at all
// without a site key.
type Options = Record<string, unknown> & {
  'callback': (token: string) => void
  'error-callback': () => boolean
}

function fakeTurnstile() {
  const api = {
    options: undefined as Options | undefined,
    render: vi.fn((_element: HTMLElement, options: Options) => {
      api.options = options
      return 'w1'
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  }
  window.turnstile = api as unknown as Window['turnstile']
  return api
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const config = () => useRuntimeConfig().public as { turnstileSiteKey: string }

describe('useTurnstile', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    config().turnstileSiteKey = ''
    delete window.turnstile
  })

  it('does nothing without a site key: no widget, no header', async () => {
    const api = fakeTurnstile()
    const turnstile = useTurnstile(ref(document.createElement('div')))
    expect(turnstile.enabled).toBe(false)
    expect(turnstile.prepare()).toBeUndefined()
    await turnstile.fetch('/api/chat', { method: 'POST' })
    expect(api.render).not.toHaveBeenCalled()
    expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).has('x-turnstile-token')).toBe(false)
  })

  it('renders an invisible widget for the chat action and sends one token per request', async () => {
    config().turnstileSiteKey = 'site-key'
    const api = fakeTurnstile()
    const turnstile = useTurnstile(ref(document.createElement('div')))
    await turnstile.prepare()
    expect(api.options).toMatchObject({ 'sitekey': 'site-key', 'action': 'chat', 'appearance': 'interaction-only', 'response-field': false })

    api.options!.callback('token-1')
    await turnstile.fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' } })
    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-turnstile-token')).toBe('token-1')
    expect(headers.get('content-type')).toBe('application/json')
    await tick()
    expect(api.reset).toHaveBeenCalledWith('w1')

    // The next request waits for the token the reset produces; the old one is never reused.
    const second = turnstile.fetch('/api/chat', { method: 'POST' })
    await tick()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    api.options!.callback('token-2')
    await second
    expect(new Headers(fetchSpy.mock.calls[1]![1]?.headers).get('x-turnstile-token')).toBe('token-2')
  })

  it('waits through the widget retries, and fails the request after repeated errors', async () => {
    config().turnstileSiteKey = 'site-key'
    const api = fakeTurnstile()
    const turnstile = useTurnstile(ref(document.createElement('div')))
    // One error, then Turnstile's retry succeeds: the request goes through.
    const first = turnstile.fetch('/api/chat', { method: 'POST' })
    await tick()
    api.options!['error-callback']()
    api.options!.callback('token-1')
    await first
    expect(fetchSpy).toHaveBeenCalledOnce()

    const second = turnstile.fetch('/api/chat', { method: 'POST' })
    await tick()
    for (let i = 0; i < 3; i++) api.options!['error-callback']()
    await expect(second).rejects.toThrow(TURNSTILE_FAILED_ERROR)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('gives up after the deadline with its own message', async () => {
    config().turnstileSiteKey = 'site-key'
    fakeTurnstile()
    vi.useFakeTimers()
    const turnstile = useTurnstile(ref(document.createElement('div')))
    const request = turnstile.fetch('/api/chat', { method: 'POST' })
    const failed = expect(request).rejects.toThrow(TURNSTILE_TIMEOUT_ERROR)
    await vi.advanceTimersByTimeAsync(60_000)
    await failed
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('drops a parked token close to expiry and waits for a fresh one', async () => {
    config().turnstileSiteKey = 'site-key'
    const api = fakeTurnstile()
    vi.useFakeTimers()
    const turnstile = useTurnstile(ref(document.createElement('div')))
    await turnstile.prepare()
    api.options!.callback('old-token')
    vi.setSystemTime(Date.now() + 250_000)
    const request = turnstile.fetch('/api/chat', { method: 'POST' })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.reset).toHaveBeenCalledWith('w1')
    api.options!.callback('new-token')
    await request
    expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get('x-turnstile-token')).toBe('new-token')
  })

  it('honours Stop while the Turnstile script is still downloading', async () => {
    config().turnstileSiteKey = 'site-key'
    // No window.turnstile, and the script tag is never attached, so it never loads.
    const append = vi.spyOn(document.head, 'append').mockImplementation(() => {})
    try {
      const turnstile = useTurnstile(ref(document.createElement('div')))
      const abort = new AbortController()
      const request = turnstile.fetch('/api/chat', { method: 'POST', signal: abort.signal })
      await tick()
      expect((append.mock.calls[0]?.[0] as HTMLScriptElement).src).toMatch(/^https:\/\/challenges\.cloudflare\.com\/turnstile\//)
      abort.abort()
      await expect(request).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetchSpy).not.toHaveBeenCalled()
    }
    finally {
      append.mockRestore()
    }
  })

  it('stops waiting for a token when the request is aborted', async () => {
    config().turnstileSiteKey = 'site-key'
    fakeTurnstile()
    const turnstile = useTurnstile(ref(document.createElement('div')))
    const abort = new AbortController()
    const request = turnstile.fetch('/api/chat', { method: 'POST', signal: abort.signal })
    await tick()
    abort.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
