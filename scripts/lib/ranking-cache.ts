// Rerank calls for the eval scripts, cached on disk and paced to Groq's
// free-tier limits (ADR-0007). Shared by eval:rerank and eval:answers, so the
// answers eval reuses rankings eval:rerank already paid for: both spend the
// reranker model's 200K tokens/day.
//
// Cache key: model id + provider options + the exact prompt, so any change to
// the candidates, their order or the prompt text is a new call.

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { APICallError } from 'ai'
import { buildRerankPrompt, rankPassages, type Ranking, type RerankModel } from '../../server/rag/rerank'
import type { SearchHit } from '../../server/rag/search'

const CACHE_DIR = join(resolve(import.meta.dirname, '../..'), '.cache/rerank')

/** Longest rate-limit wait worth sitting through; beyond it (a spent daily quota) the run stops. */
const MAX_WAIT_MS = 5 * 60_000

export interface CachedRanking extends Ranking {
  /** Latency of the call that produced it. */
  ms: number
  cached: boolean
}

/**
 * @param tpm Pace uncached calls to this many tokens per minute (0 = no pacing).
 */
export async function rankingCache(rm: RerankModel, filenameById: Map<string, string>, tpm: number) {
  await mkdir(CACHE_DIR, { recursive: true })
  let nextCallAt = 0

  return async function ranking(question: string, hits: SearchHit[]): Promise<CachedRanking> {
    const key = createHash('sha256')
      .update(`${rm.id}\n${JSON.stringify(rm.providerOptions)}\n${buildRerankPrompt(question, hits, filenameById)}`)
      .digest('hex').slice(0, 24)
    const file = join(CACHE_DIR, `${key}.json`)
    if (await access(file).then(() => true, () => false)) {
      return { ...JSON.parse(await readFile(file, 'utf8')), cached: true }
    }

    for (let attempt = 1; ; attempt++) {
      await new Promise(r => setTimeout(r, Math.max(0, nextCallAt - Date.now())))
      const start = performance.now()
      try {
        const result = await rankPassages(rm, question, hits, filenameById)
        const ms = performance.now() - start
        const tokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0)
        if (tpm > 0) nextCallAt = Date.now() + (tokens / tpm) * 60_000
        await writeFile(file, JSON.stringify({ ...result, ms }))
        return { ...result, ms, cached: false }
      }
      catch (error) {
        const wait = retryAfterMs(error) ?? 15_000 * attempt
        if (wait > MAX_WAIT_MS) {
          // An expected stop, not a crash: no stack trace or request dump.
          console.error(`\n${rm.id}: rate limit needs a ${Math.ceil(wait / 60_000)} min wait, so its daily token quota is spent.`
            + `\nIt refills gradually over 24 h; re-run later and the cached rankings are reused.`)
          process.exit(2)
        }
        if (attempt >= 6) throw error
        console.log(`  retry ${attempt}/5 in ${Math.ceil(wait / 1000)}s: ${String(error).slice(0, 140)}`)
        nextCallAt = Date.now() + wait
      }
    }
  }
}

/** The Retry-After of a 429, in ms. */
function retryAfterMs(error: unknown): number | undefined {
  if (!APICallError.isInstance(error) || error.statusCode !== 429) return undefined
  const seconds = Number(error.responseHeaders?.['retry-after'])
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}
