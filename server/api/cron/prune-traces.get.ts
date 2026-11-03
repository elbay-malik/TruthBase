import { requireCronSecret } from '../../utils/cron-auth'
import { pruneOldTraces } from '../../utils/trace-retention'

// GET /api/cron/prune-traces: the daily Langfuse clean-up, called by a Vercel
// cron job (nuxt.config.ts nitro.vercel.config.crons, privacy page). A failed
// run is a 502 in the Vercel logs, and two in a row are survivable; see
// server/utils/trace-retention.ts for why that matters.
export default defineEventHandler(async (event) => {
  requireCronSecret(event)

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  // Same switch as server/plugins/tracing.ts: without keys nothing is recorded.
  if (!publicKey || !secretKey) return { status: 'skipped' as const }

  try {
    const result = await pruneOldTraces({
      baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
      publicKey,
      secretKey,
    })
    if (result.partial) console.warn(`[prune-traces] hit a cap after ${result.deleted} traces`)
    return { status: 'ok' as const, ...result }
  }
  catch (error) {
    console.error(`[prune-traces] failed: ${error instanceof Error ? error.message : String(error)}`)
    throw createError({ statusCode: 502, message: 'Trace clean-up failed.' })
  }
})
