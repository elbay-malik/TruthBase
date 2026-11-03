import { requireCronSecret } from '../../utils/cron-auth'

// GET /api/cron/keep-alive: the Supabase anti-pause ping, called once a day by
// a Vercel cron job (nuxt.config.ts nitro.vercel.config.crons, ADR-0011).
// Free projects pause after ~7 days without database activity; reading one
// row of keep_alive (supabase/migrations/20261016203929_keep_alive.sql) counts
// as activity. It replaced the GitHub Actions workflow, which stopped running
// once Actions was blocked by billing (last success 2026-10-19).
// Authenticated by requireCronSecret: without CRON_SECRET the route is 503.

export default defineEventHandler(async (event) => {
  requireCronSecret(event)

  const { error } = await serverSupabase().from('keep_alive').select('id').limit(1)
  // A failed ping must fail the cron run (Vercel logs non-2xx), never pass
  // silently. The database's message goes to the log only.
  if (error) {
    console.error(`[keep-alive] read failed: ${error.message}`)
    throw createError({ statusCode: 502, message: 'Keep-alive read failed.' })
  }
  return { status: 'ok' as const }
})
