import { createHash, timingSafeEqual } from 'node:crypto'

// GET /api/cron/keep-alive: the Supabase anti-pause ping, called once a day by
// a Vercel cron job (nuxt.config.ts nitro.vercel.config.crons, ADR-0011).
// Free projects pause after ~7 days without database activity; reading one
// row of keep_alive (supabase/migrations/20261016203929_keep_alive.sql) counts
// as activity. It replaced the GitHub Actions workflow, which stopped running
// once Actions was blocked by billing (last success 2026-10-19).
//
// Vercel sends `Authorization: Bearer $CRON_SECRET` when the project has a
// CRON_SECRET env var. Read from process.env, not runtimeConfig: the name is
// Vercel's, not a NUXT_* override. Fails closed: without the secret the route
// is 503, so the endpoint is never an unauthenticated database trigger.

/** Constant-time comparison; hashing first makes the lengths equal. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

export default defineEventHandler(async (event) => {
  const secret = process.env.CRON_SECRET
  if (!secret) throw createError({ statusCode: 503, message: 'Keep-alive is not configured.' })
  if (!sameSecret(getHeader(event, 'authorization') ?? '', `Bearer ${secret}`)) {
    throw createError({ statusCode: 401, message: 'Unauthorized.' })
  }

  const { error } = await serverSupabase().from('keep_alive').select('id').limit(1)
  // A failed ping must fail the cron run (Vercel logs non-2xx), never pass
  // silently. The database's message goes to the log only.
  if (error) {
    console.error(`[keep-alive] read failed: ${error.message}`)
    throw createError({ statusCode: 502, message: 'Keep-alive read failed.' })
  }
  return { status: 'ok' as const }
})
