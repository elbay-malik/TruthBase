// Deletes old Langfuse traces, which hold visitors' questions and answers.
//
// Langfuse Hobby never deletes on its own, and its 30-day window also hides
// older records from the API, so a trace that passes 30 days can no longer be
// found to delete. Hence 27 days: a daily run can fail twice and still reach
// everything. The privacy page promises "within 30 days".
//
// Hobby's limits, per organization: 50 trace deletions a day, 30 requests a
// minute on reads, and Langfuse advises at most 30-50 ids per delete.

const DAY_MS = 24 * 60 * 60 * 1000
export const RETENTION_DAYS = 27
const SCAN_FROM_DAYS = 31
const PAGE_SIZE = 1000
const MAX_PAGES = 10
const DELETE_BATCH = 50
const MAX_DELETES_PER_RUN = 20
const RUN_TIMEOUT_MS = 120_000

export interface LangfuseAuth {
  baseUrl: string
  publicKey: string
  secretKey: string
}

export interface PruneResult {
  /** Trace ids sent for deletion. Langfuse removes them within about 15 minutes. */
  deleted: number
  /** True if this run hit a cap, leaving old traces for the next one. */
  partial: boolean
}

interface ObservationPage {
  data: { traceId?: string | null, startTime: string }[]
  meta?: { cursor?: string | null }
}

export async function pruneOldTraces(auth: LangfuseAuth, now = Date.now()): Promise<PruneResult> {
  const headers = {
    'authorization': `Basic ${Buffer.from(`${auth.publicKey}:${auth.secretKey}`).toString('base64')}`,
    'content-type': 'application/json',
  }
  const signal = AbortSignal.timeout(RUN_TIMEOUT_MS)
  const fromStartTime = new Date(now - SCAN_FROM_DAYS * DAY_MS).toISOString()
  const toStartTime = new Date(now - RETENTION_DAYS * DAY_MS).toISOString()

  // The API lists observations, newest first. Keep each trace's oldest time.
  const traces = new Map<string, string>()
  let cursor: string | null | undefined
  let pages = 0
  do {
    const query = new URLSearchParams({ fromStartTime, toStartTime, limit: String(PAGE_SIZE), fields: 'core' })
    if (cursor) query.set('cursor', cursor)
    const response = await fetch(`${auth.baseUrl}/api/public/v2/observations?${query}`, { headers, signal })
    if (!response.ok) throw new Error(`listing observations returned ${response.status}`)
    const page = await response.json() as ObservationPage
    for (const { traceId, startTime } of page.data) {
      if (!traceId) continue
      const seen = traces.get(traceId)
      if (!seen || startTime < seen) traces.set(traceId, startTime)
    }
    cursor = page.meta?.cursor
    pages++
  } while (cursor && pages < MAX_PAGES)

  // Oldest first: those are closest to falling out of the API's window.
  const ids = [...traces].sort((a, b) => a[1].localeCompare(b[1])).map(([id]) => id)
  const batches = Math.min(Math.ceil(ids.length / DELETE_BATCH), MAX_DELETES_PER_RUN)
  let deleted = 0
  for (let i = 0; i < batches; i++) {
    const traceIds = ids.slice(i * DELETE_BATCH, (i + 1) * DELETE_BATCH)
    const response = await fetch(`${auth.baseUrl}/api/public/traces`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ traceIds }),
      signal,
    })
    if (!response.ok) throw new Error(`deleting traces returned ${response.status}`)
    deleted += traceIds.length
  }
  return { deleted, partial: Boolean(cursor) || deleted < ids.length }
}
