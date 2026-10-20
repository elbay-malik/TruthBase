import { createHmac } from 'node:crypto'
import { isIP, isIPv6 } from 'node:net'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { H3Event } from 'h3'
import { trustedIpHeader } from './platform'

// Phase 11: daily quotas for the public demo (ADR-0010); Phase 14: the
// per-minute limits on the same counters (ADR-0011). Each request that spends
// model quota first consumes one unit of its client's per-minute and daily
// allowance and of the demo's global daily budget, atomically (consume_quotas
// in supabase/migrations/20261021120000_burst_quota.sql). Over a limit it gets
// a 429 with Retry-After, before any model call: until the next minute, or
// until midnight UTC for a daily cap.
//
// The counters live in Postgres, so they hold across server restarts and
// serverless instances. nuxt-security's in-memory limiter applies the same
// per-minute numbers first, per instance, without a database round trip.
// Client IPs (one per IPv4 address or IPv6 /64) are stored only as an HMAC
// keyed with the service key. If the counter store fails, the request goes
// through (fail open): the in-memory limiter still applies, and a Supabase
// outage breaks retrieval anyway.

export type QuotaResource = 'chat' | 'search'

export interface QuotaLimits {
  /** Per client and clock minute. */
  perMinute: number
  /** Per client and UTC day. */
  perClient: number
  /** The whole demo, per UTC day. */
  global: number
}

/** The per-minute window, in seconds (consume_quotas' p_windows). */
export const MINUTE_WINDOW = 60
const DAY_WINDOW = 86_400

/**
 * Request header carrying clientIp() for nuxt-security's per-minute limiter
 * (security.rateLimiter.ipHeader in nuxt.config.ts). server/plugins/client-ip.ts
 * overwrites it on every request, so a client-sent value is never used.
 */
export const CLIENT_IP_HEADER = 'x-truthbase-client-ip'

/**
 * clientIp() for the server's own local fetches, which have no socket; the
 * per-minute limiter skips it (security.rateLimiter.whiteList).
 */
export const INTERNAL_CLIENT = 'internal'

const warned = new Set<string>()
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}

const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd]|fe[89ab])/i

/**
 * The client's IP, normalised by normalizeIp(). Behind a proxy, set
 * NUXT_TRUSTED_IP_HEADER to the header that proxy sets (x-vercel-forwarded-for,
 * cf-connecting-ip, fly-client-ip, x-real-ip, or x-forwarded-for; on Vercel
 * x-vercel-forwarded-for is the default, see trustedIpHeader()); otherwise the
 * socket address is used and request headers are ignored, since a client can
 * send any of them. The origin must then be reachable only through that proxy.
 */
export function clientIp(event: H3Event, trustedHeader: string): string {
  if (trustedHeader) {
    const value = getRequestHeader(event, trustedHeader.toLowerCase())
    // x-forwarded-for: the trusted proxy appends the address it saw last.
    const ip = value?.split(',').at(-1)?.trim()
    // Only an IP address counts: anything else (e.g. INTERNAL_CLIENT, which
    // the per-minute limiter skips) must not reach the limiter keys.
    if (ip && isIP(ip.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, ''))) return normalizeIp(ip)
    if (ip) warnOnce('invalid', `[quota] ${trustedHeader} is not an IP address on a request: using the socket address`)
  }
  const socket = event.node.req.socket?.remoteAddress
  // No socket: Nitro's local fetch, a server-side render calling its own API
  // without the visitor's headers (Nuxt Icon's /api/_nuxt_icon). Not a
  // visitor, so not a proxy problem either.
  if (!socket) return INTERNAL_CLIENT
  if (trustedHeader) {
    warnOnce('header', `[quota] ${trustedHeader} is missing on a request: using the socket address (is the origin reachable without the proxy?)`)
  }
  else if (process.env.NODE_ENV === 'production' && PRIVATE_IP.test(socket.replace(/^::ffff:/i, ''))) {
    warnOnce('proxy', '[quota] NUXT_TRUSTED_IP_HEADER is unset and the client address is private: behind a proxy, all visitors share one allowance')
  }
  return normalizeIp(socket)
}

/**
 * One client per IPv4 address or IPv6 /64 (a single host usually controls a
 * whole /64); IPv4-mapped IPv6 counts as the IPv4 address.
 */
export function normalizeIp(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped) return mapped[1]!
  if (!isIPv6(address)) return address
  const [head = '', tail] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  // An embedded IPv4 tail (64:ff9b::1.2.3.4) is two groups wide.
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0)
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - width(left) - width(right)).fill('0'), ...right]
  return `${groups.slice(0, 4).map(g => Number.parseInt(g, 16).toString(16)).join(':')}::/64`
}

/** A stable, non-reversible counter key for an IP. */
export function clientKey(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(ip).digest('base64url').slice(0, 22)
}

/** Seconds until the current window of `seconds` (aligned to the epoch, like consume_quotas) ends. */
export function secondsUntilWindowEnd(seconds: number, now = new Date()): number {
  const ms = seconds * 1000
  return Math.max(1, Math.ceil((ms - (now.getTime() % ms)) / 1000))
}

/** Seconds until the daily counters reset (00:00 UTC). */
export function secondsUntilUtcMidnight(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000))
}

export function quotaMessage(resource: QuotaResource, blocked: 'minute' | 'client' | 'global', limit: number): string {
  const what = resource === 'chat' ? 'questions' : 'searches'
  if (blocked === 'minute') return `Too many ${what} in a short time (${limit} a minute). Wait a minute, then try again.`
  return blocked === 'client'
    ? `You've reached today's demo limit of ${limit} ${what}. It resets at midnight UTC.`
    : `The demo has used today's ${what} budget on its free AI quotas. It resets at midnight UTC.`
}

/**
 * Consumes one unit of this minute's per-client limit and of today's
 * per-client and global quota for `resource`, all or none, or throws a 429.
 * A limit below 1 closes the resource.
 */
export async function enforceQuota(event: H3Event, supabase: SupabaseClient, resource: QuotaResource, limits: QuotaLimits, options: { trustedIpHeader: string, secret: string }): Promise<void> {
  const key = clientKey(options.secret, clientIp(event, options.trustedIpHeader))
  const { data, error } = await supabase.rpc('consume_quotas', {
    p_scopes: [`${resource}:minute`, `${resource}:client`, `${resource}:global`],
    p_keys: [key, key, 'all'],
    p_limits: [limits.perMinute, limits.perClient, limits.global],
    p_windows: [MINUTE_WINDOW, DAY_WINDOW, DAY_WINDOW],
  })
  const row = (data as { allowed: boolean, blocked_scope: string | null }[] | null)?.[0]
  if (error || !row) {
    console.warn(`[quota] ${resource}: counter store unavailable, allowing the request: ${error?.message ?? 'no result'}`)
    return
  }
  if (row.allowed) return

  if (row.blocked_scope === `${resource}:minute`) {
    // Same as nuxt-security's per-minute 429; no data.quota, so the UI shows
    // "wait a minute" and keeps its Retry button (ADR-0010).
    const retryAfter = secondsUntilWindowEnd(MINUTE_WINDOW)
    setResponseHeader(event, 'Retry-After', retryAfter)
    throw createError({
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      message: quotaMessage(resource, 'minute', limits.perMinute),
      data: { limit: 'minute', resource, retryAfter },
    })
  }

  const blocked = row.blocked_scope === `${resource}:client` ? 'client' : 'global'
  const retryAfter = secondsUntilUtcMidnight()
  setResponseHeader(event, 'Retry-After', retryAfter)
  throw createError({
    statusCode: 429,
    statusMessage: 'Too Many Requests',
    message: quotaMessage(resource, blocked, blocked === 'client' ? limits.perClient : limits.global),
    // Lets the UI tell a daily cap from the per-minute limits.
    data: { quota: blocked, resource, retryAfter },
  })
}

/**
 * A NUXT_QUOTA_* value as a whole number. Anything else closes the route with
 * a warning rather than reaching consume_quotas as NULL (no limit at all).
 */
export function quotaLimit(value: unknown, name: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (Number.isInteger(n) && Math.abs(n) < 2 ** 31) return n // fits consume_quotas' int[]
  warnOnce(name, `[quota] ${name}=${JSON.stringify(value)} is not a whole number: the route stays closed until it is fixed`)
  return 0
}

/** The quota settings from runtimeConfig, or undefined when quotas are off. */
export function quotaConfig(resource: QuotaResource): { limits: QuotaLimits, options: { trustedIpHeader: string, secret: string } } | undefined {
  const config = useRuntimeConfig()
  const q = config.quota
  if (!q.enabled) return undefined
  return {
    limits: resource === 'chat'
      ? { perMinute: quotaLimit(q.chatPerMinute, 'NUXT_QUOTA_CHAT_PER_MINUTE'), perClient: quotaLimit(q.chatPerClient, 'NUXT_QUOTA_CHAT_PER_CLIENT'), global: quotaLimit(q.chatGlobal, 'NUXT_QUOTA_CHAT_GLOBAL') }
      : { perMinute: quotaLimit(q.searchPerMinute, 'NUXT_QUOTA_SEARCH_PER_MINUTE'), perClient: quotaLimit(q.searchPerClient, 'NUXT_QUOTA_SEARCH_PER_CLIENT'), global: quotaLimit(q.searchGlobal, 'NUXT_QUOTA_SEARCH_GLOBAL') },
    options: { trustedIpHeader: trustedIpHeader(config.trustedIpHeader), secret: config.supabaseServiceKey },
  }
}
