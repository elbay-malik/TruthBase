import { isIP } from 'node:net'
import type { H3Event } from 'h3'
import { TURNSTILE_HEADER, TURNSTILE_MAX_TOKEN_LENGTH } from '#shared/turnstile'
import { onVercel, trustedIpHeader } from './platform'
import { clientIp } from './quota'

// Turnstile check for the routes that spend model quota (ADR-0010, 2026-11-08
// note). It runs before the quota, so a request without a valid token spends
// none of the daily budget. Each token is single-use: Siteverify rejects a
// replay, so every question needs its own.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const SITEVERIFY_TIMEOUT_MS = 10_000

export type TurnstileSettings = {
  /** NUXT_TURNSTILE_SECRET_KEY. Empty: the check is off, unless `required`. */
  secret: string
  /** NUXT_TURNSTILE_HOSTNAMES: the page hostnames a token may come from, comma-separated. */
  hostnames: string
  /** True on Vercel deployments, where a missing secret must close the route rather than open it. */
  required: boolean
  /** True on Vercel Production, which must never run on Cloudflare's test keys. */
  production: boolean
}

export type TurnstileResult = 'ok' | 'off' | 'rejected' | 'unavailable' | 'misconfigured'

type SiteverifyAnswer = {
  'success'?: boolean
  'action'?: string
  'hostname'?: string
  'error-codes'?: string[]
  'metadata'?: { result_with_testing_key?: boolean }
}

/** Parses NUXT_TURNSTILE_HOSTNAMES into a set of lower-case hostnames. */
export function turnstileHostnames(value: unknown): Set<string> {
  return new Set(String(value ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean))
}

/**
 * Redeems `token` at Siteverify. 'ok' only for a successful answer with the
 * expected action from an allowed hostname; 'unavailable' when Siteverify
 * can't be reached or answers badly. Both failures close the route.
 */
export async function verifyTurnstile(
  token: string | undefined,
  action: string,
  settings: TurnstileSettings,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const secret = settings.secret.trim()
  if (!secret) return settings.required ? 'misconfigured' : 'off'
  const hostnames = turnstileHostnames(settings.hostnames)
  if (hostnames.size === 0) return 'misconfigured'
  if (!token || token.length > TURNSTILE_MAX_TOKEN_LENGTH) return 'rejected'

  const body = new URLSearchParams({ secret, response: token })
  if (remoteIp && isIP(remoteIp)) body.set('remoteip', remoteIp)
  let answer: SiteverifyAnswer
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`siteverify answered ${response.status}`)
    answer = await response.json() as SiteverifyAnswer
  }
  catch (error) {
    console.error('[turnstile] siteverify failed:', String(error).slice(0, 200))
    return 'unavailable'
  }
  // A wrong or revoked secret is the deployment's fault, not the visitor's.
  if (answer['error-codes']?.some(code => code === 'invalid-input-secret' || code === 'missing-input-secret')) {
    console.error('[turnstile] siteverify rejected the secret key: check NUXT_TURNSTILE_SECRET_KEY')
    return 'misconfigured'
  }
  // A fault on Cloudflare's side, worth retrying: not the visitor's.
  if (answer['error-codes']?.includes('internal-error')) {
    console.error('[turnstile] siteverify answered internal-error')
    return 'unavailable'
  }
  // Cloudflare's test secret (local runs, .env.example) answers without an
  // action. It must never guard Production.
  const testing = answer.metadata?.result_with_testing_key === true
  if (testing && settings.production) {
    console.error('[turnstile] NUXT_TURNSTILE_SECRET_KEY is a test key on Production')
    return 'misconfigured'
  }
  const actionOk = answer.action === action || (testing && !answer.action)
  if (answer.success !== true || !actionOk || !hostnames.has(String(answer.hostname ?? '').toLowerCase())) {
    return 'rejected'
  }
  return 'ok'
}

/** The route's settings from runtimeConfig and the platform. */
export function turnstileSettings(): TurnstileSettings {
  const config = useRuntimeConfig()
  return {
    secret: String(config.turnstileSecretKey ?? ''),
    hostnames: String(config.turnstileHostnames ?? ''),
    // Previews share the database, its daily budget and the model keys with
    // Production, so a deployment without the secret must not run unchecked.
    required: onVercel(),
    production: process.env.VERCEL_ENV === 'production',
  }
}

/** Throws unless the request carries a valid Turnstile token for `action` (or the check is off). */
export async function assertTurnstile(event: H3Event, action: string): Promise<void> {
  const settings = turnstileSettings()
  const ip = clientIp(event, trustedIpHeader(useRuntimeConfig().trustedIpHeader))
  const result = await verifyTurnstile(getRequestHeader(event, TURNSTILE_HEADER), action, settings, ip)
  switch (result) {
    case 'ok':
    case 'off':
      return
    case 'rejected':
      throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: 'The browser check did not pass. Reload the page and try again.' })
    case 'unavailable':
      throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'The browser check is unavailable right now. Please try again in a minute.' })
    case 'misconfigured':
      throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'The browser check is not configured.' })
  }
}
