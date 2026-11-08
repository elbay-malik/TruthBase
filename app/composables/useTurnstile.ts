import type { Ref } from 'vue'
import { TURNSTILE_CHAT_ACTION, TURNSTILE_HEADER } from '#shared/turnstile'

// Cloudflare Turnstile for /api/chat (server/utils/turnstile.ts). The widget
// renders invisibly ("interaction-only") into `container` and shows itself
// only when Cloudflare wants a click. Each token is single-use, so every
// request takes the current one and resets the widget for the next. Without a
// site key (local runs, tests, previews) nothing loads and no header is sent.

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string | null | undefined
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** Long enough for a visitor to answer an interactive challenge. */
const TOKEN_WAIT_MS = 60_000
/** A stalled script download is given up, so the next question tries again. */
const SCRIPT_LOAD_MS = 30_000
/** Tokens are valid for 300 s; an older one is dropped for a fresh one. */
const TOKEN_MAX_AGE_MS = 240_000
/** Turnstile retries a failed check by itself; a request gives up after this many failures. */
const MAX_ERRORS = 3

export const TURNSTILE_LOAD_ERROR = 'The browser check could not load. Check your network, then try again.'
export const TURNSTILE_FAILED_ERROR = 'The browser check did not pass. Reload the page and try again.'
export const TURNSTILE_TIMEOUT_ERROR = 'The browser check did not finish. If a checkbox shows below the question box, tick it, then ask again.'

let script: Promise<TurnstileApi> | undefined

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  script ??= new Promise<TurnstileApi>((resolve, reject) => {
    const element = document.createElement('script')
    element.src = SCRIPT_URL
    element.async = true
    const fail = () => {
      clearTimeout(timer)
      element.remove()
      reject(new Error(TURNSTILE_LOAD_ERROR))
    }
    const timer = setTimeout(fail, SCRIPT_LOAD_MS)
    element.onload = () => {
      clearTimeout(timer)
      if (window.turnstile) resolve(window.turnstile)
      else fail()
    }
    element.onerror = fail
    document.head.append(element)
  })
  // A failed download is retried on the next question.
  script.catch(() => { script = undefined })
  return script
}

type Waiter = { resolve: (token: string) => void, reject: (error: Error) => void }

export function useTurnstile(container: Ref<HTMLElement | undefined>) {
  const siteKey = String(useRuntimeConfig().public.turnstileSiteKey ?? '')
  const enabled = import.meta.client && !!siteKey

  let widget: Promise<string> | undefined
  /** A token not yet sent, if Turnstile delivered one before it was asked for. */
  let ready: { token: string, at: number } | undefined
  let waiters: Waiter[] = []
  /** Failures since the last token. */
  let errors = 0

  function settle(run: (waiter: Waiter) => void) {
    const pending = waiters
    waiters = []
    pending.forEach(run)
  }

  /** Loads and renders the widget, so a token is ready by the time a question is sent. */
  function prepare(): Promise<string> | undefined {
    if (!enabled) return undefined
    widget ??= loadScript().then((api) => {
      const element = container.value
      if (!element) throw new Error(TURNSTILE_LOAD_ERROR)
      const id = api.render(element, {
        'sitekey': siteKey,
        'action': TURNSTILE_CHAT_ACTION,
        'appearance': 'interaction-only',
        'refresh-expired': 'auto',
        'response-field': false,
        'callback': (token: string) => {
          errors = 0
          if (waiters.length) settle(waiter => waiter.resolve(token))
          else ready = { token, at: Date.now() }
        },
        'expired-callback': () => { ready = undefined },
        'error-callback': () => {
          ready = undefined
          if (++errors >= MAX_ERRORS) settle(waiter => waiter.reject(new Error(TURNSTILE_FAILED_ERROR)))
          // Not handled here: Turnstile retries by itself.
          return false
        },
      })
      if (!id) throw new Error(TURNSTILE_LOAD_ERROR)
      return id
    })
    widget.catch(() => { widget = undefined })
    return widget
  }

  /** The parked token, unless it is close to expiring (then the widget fetches a new one). */
  function takeReady(id: string): string | undefined {
    const parked = ready
    ready = undefined
    if (parked && Date.now() - parked.at < TOKEN_MAX_AGE_MS) return parked.token
    if (parked) window.turnstile?.reset(id)
    return undefined
  }

  /**
   * A fresh token for one request, or undefined when Turnstile is off. Stop
   * (`signal`) and the deadline apply from the start, script download included.
   */
  async function token(signal?: AbortSignal | null): Promise<string | undefined> {
    if (!enabled) return undefined
    let cancelled = false
    let waiter: Waiter | undefined
    let cleanup = () => {}
    const guard = new Promise<never>((_, reject) => {
      const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      const timer = setTimeout(() => reject(new Error(TURNSTILE_TIMEOUT_ERROR)), TOKEN_WAIT_MS)
      cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
    const wait = (async () => {
      const id = await prepare()!
      const parked = takeReady(id)
      if (parked || cancelled) return parked ?? ''
      return new Promise<string>((resolve, reject) => {
        waiter = { resolve, reject }
        waiters.push(waiter)
      })
    })()
    let delivered = false
    try {
      const value = await Promise.race([guard, wait])
      delivered = true
      return value
    }
    finally {
      cancelled = true
      cleanup()
      if (waiter) waiters = waiters.filter(w => w !== waiter)
      // Gave up (Stop, deadline) while the widget was still loading: a token it
      // hands over later isn't lost, but parked for the next request.
      if (!delivered) void wait.then((late) => { if (late && !ready) ready = { token: late, at: Date.now() } }, () => {})
    }
  }

  /** After a request has used its token: start on the next one. */
  function used() {
    void widget?.then(id => window.turnstile?.reset(id)).catch(() => {})
  }

  /**
   * `fetch` for the chat transport: adds this request's token as a header and
   * resets the widget once the server has answered.
   */
  async function fetchWithToken(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const value = await token(init?.signal)
    if (!value) return fetch(input, init)
    const headers = new Headers(init?.headers)
    headers.set(TURNSTILE_HEADER, value)
    try {
      return await fetch(input, { ...init, headers })
    }
    finally {
      used()
    }
  }

  onScopeDispose(() => {
    settle(waiter => waiter.reject(new DOMException('Aborted', 'AbortError')))
    void widget?.then(id => window.turnstile?.remove(id)).catch(() => {})
  })

  return { enabled, prepare, token, fetch: fetchWithToken }
}
