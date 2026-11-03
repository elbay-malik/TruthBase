import { createHash, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

// Auth for the Vercel cron routes. Vercel sends `Authorization: Bearer
// $CRON_SECRET` when the project has a CRON_SECRET env var. Read from
// process.env, not runtimeConfig: the name is Vercel's, not a NUXT_* override.
// Fails closed: without the secret the route is 503, so it is never an
// unauthenticated trigger.

/** Constant-time comparison; hashing first makes the lengths equal. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

export function requireCronSecret(event: H3Event) {
  const secret = process.env.CRON_SECRET
  if (!secret) throw createError({ statusCode: 503, message: 'Cron is not configured.' })
  if (!sameSecret(getHeader(event, 'authorization') ?? '', `Bearer ${secret}`)) {
    throw createError({ statusCode: 401, message: 'Unauthorized.' })
  }
}
