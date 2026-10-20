import { createHmac } from 'node:crypto'
import { isIPv6 } from 'node:net'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { H3Event } from 'h3'

// Phase 11: daily quotas for the public demo (ADR-0010), on top of
// nuxt-security's per-minute rate limiter. Each request that spends model
// quota first consumes one unit of its client's daily allowance and of the
// demo's global daily budget, atomically (consume_quotas in
// supabase/migrations/20261020120000_usage_quota.sql). Over either limit it
// gets a 429 with Retry-After until midnight UTC, before any model call.
//
// The counters live in Postgres, so they hold across server restarts and
// instances, on any deploy target. Client IPs (one per IPv4 address or IPv6
// /64) are stored only as an HMAC keyed with the service key. If the counter
// store fails, the request goes through (fail open): the per-minute limiter
// still applies, and a Supabase outage breaks retrieval anyway.

export type QuotaResource = 'chat' | 'search'

export interface DailyLimits {
  perClient: number
  global: number
}

/**
 * Request header carrying clientIp() for nuxt-security's per-minute limiter
 * (security.rateLimiter.ipHeader in nuxt.config.ts). server/plugins/client-ip.ts
 * overwrites it on every request, so a client-sent value is never used.
 */
export const CLIENT_IP_HEADER = 'x-truthbase-client-ip'

const warned = new Set<string>()
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}

const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd]|fe[89ab])/i

/**
 * The client's IP, normalised by normalizeIp(). Behind a proxy, set
 * NUXT_TRUSTED_IP_HEADER to the header that proxy sets (cf-connecting-ip,
 * fly-client-ip, x-real-ip, or x-forwarded-for); otherwise the socket address
 * is used and request headers are ignored, since a client can send any of
 * them. The origin must then be reachable only through that proxy.
 */
export function clientIp(event: H3Event, trustedHeader: string): string {
  if (trustedHeader) {
    const value = getRequestHeader(event, trustedHeader.toLowerCase())
    // x-forwarded-for: the trusted proxy appends the address it saw last.
    const ip = value?.split(',').at(-1)?.trim()
    if (ip) return normalizeIp(ip)
    warnOnce('header', `[quota] ${trustedHeader} is missing on a request: using the socket address (is the origin reachable without the proxy?)`)
  }
  const socket = event.node.req.socket?.remoteAddress ?? 'unknown'
  if (!trustedHeader && process.env.NODE_ENV === 'production' && (socket === 'unknown' || PRIVATE_IP.test(socket.replace(/^::ffff:/i, '')))) {
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

/** Seconds until the counters reset (00:00 UTC). */
export function secondsUntilUtcMidnight(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000))
}

export function quotaMessage(resource: QuotaResource, blocked: 'client' | 'global', limit: number): string {
  const what = resource === 'chat' ? 'questions' : 'searches'
  return blocked === 'client'
    ? `You've reached today's demo limit of ${limit} ${what}. It resets at midnight UTC.`
    : `The demo has used today's ${what} budget on its free AI quotas. It resets at midnight UTC.`
}

/**
 * Consumes one unit of today's per-client and global quota for `resource`,
 * or throws a 429. A limit below 1 closes the resource.
 */
export async function enforceDailyQuota(event: H3Event, supabase: SupabaseClient, resource: QuotaResource, limits: DailyLimits, options: { trustedIpHeader: string, secret: string }): Promise<void> {
  const key = clientKey(options.secret, clientIp(event, options.trustedIpHeader))
  const { data, error } = await supabase.rpc('consume_quotas', {
    p_scopes: [`${resource}:client`, `${resource}:global`],
    p_keys: [key, 'all'],
    p_limits: [limits.perClient, limits.global],
  })
  const row = (data as { allowed: boolean, blocked_scope: string | null }[] | null)?.[0]
  if (error || !row) {
    console.warn(`[quota] ${resource}: counter store unavailable, allowing the request: ${error?.message ?? 'no result'}`)
    return
  }
  if (row.allowed) return

  const blocked = row.blocked_scope === `${resource}:client` ? 'client' : 'global'
  const retryAfter = secondsUntilUtcMidnight()
  setResponseHeader(event, 'Retry-After', retryAfter)
  throw createError({
    statusCode: 429,
    statusMessage: 'Too Many Requests',
    message: quotaMessage(resource, blocked, blocked === 'client' ? limits.perClient : limits.global),
    // Lets the UI tell a daily cap from the per-minute limiter.
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
export function dailyQuotaConfig(resource: QuotaResource) {
  const config = useRuntimeConfig()
  const q = config.quota
  if (!q.enabled) return undefined
  return {
    limits: resource === 'chat'
      ? { perClient: quotaLimit(q.chatPerClient, 'NUXT_QUOTA_CHAT_PER_CLIENT'), global: quotaLimit(q.chatGlobal, 'NUXT_QUOTA_CHAT_GLOBAL') }
      : { perClient: quotaLimit(q.searchPerClient, 'NUXT_QUOTA_SEARCH_PER_CLIENT'), global: quotaLimit(q.searchGlobal, 'NUXT_QUOTA_SEARCH_GLOBAL') },
    options: { trustedIpHeader: String(config.trustedIpHeader ?? ''), secret: config.supabaseServiceKey },
  }
}
