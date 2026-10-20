import { createHmac } from 'node:crypto'
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
// instances, on any deploy target. Client IPs are stored only as an HMAC
// keyed with the service key. If the counter store fails, the request goes
// through (fail open): the per-minute limiter still applies, and a Supabase
// outage breaks retrieval anyway.

export type QuotaResource = 'chat' | 'search'

export interface DailyLimits {
  perClient: number
  global: number
}

/**
 * The client's IP. Behind a proxy, set NUXT_TRUSTED_IP_HEADER to the header
 * that proxy sets (cf-connecting-ip, fly-client-ip, x-real-ip, or
 * x-forwarded-for); otherwise the socket address is used and request headers
 * are ignored, since a client can send any of them.
 */
export function clientIp(event: H3Event, trustedHeader: string): string {
  if (trustedHeader) {
    const value = getRequestHeader(event, trustedHeader.toLowerCase())
    // x-forwarded-for: the trusted proxy appends the address it saw last.
    const ip = value?.split(',').at(-1)?.trim()
    if (ip) return ip
  }
  return event.node.req.socket?.remoteAddress ?? 'unknown'
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

/** The quota settings from runtimeConfig, or undefined when quotas are off. */
export function dailyQuotaConfig(resource: QuotaResource) {
  const config = useRuntimeConfig()
  const q = config.quota
  if (!q.enabled) return undefined
  return {
    limits: resource === 'chat'
      ? { perClient: Number(q.chatPerClient), global: Number(q.chatGlobal) }
      : { perClient: Number(q.searchPerClient), global: Number(q.searchGlobal) },
    options: { trustedIpHeader: String(config.trustedIpHeader ?? ''), secret: config.supabaseServiceKey },
  }
}
