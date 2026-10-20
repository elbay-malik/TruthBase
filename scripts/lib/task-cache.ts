// Task-model calls for the eval scripts (reranking, query rewriting), cached
// on disk and paced to Groq's free-tier limits: 8K tokens/min and 200K
// tokens/day per model (ADR-0007). Cached results cost nothing on re-runs and
// are shared between scripts.
//
// Cache: .cache/<namespace>/<hash of model id + provider options + the exact
// prompt>.json, so any change to the inputs or the prompt text is a new call.
// Each entry also records a hash of the system instructions; a different hash
// is a miss. Entries without one predate it and are accepted (they were made
// with the current rerank instructions).

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { APICallError } from 'ai'
import type { TaskModel } from '../../server/rag/model'

const CACHE_ROOT = join(resolve(import.meta.dirname, '../..'), '.cache')

/** Longest rate-limit wait worth sitting through; beyond it (a spent daily quota) the run stops. */
const MAX_WAIT_MS = 5 * 60_000

export interface Usage { inputTokens?: number, outputTokens?: number }

export type Cached<T> = T & {
  /** Latency of the call that produced it. */
  ms: number
  cached: boolean
}

/**
 * @param namespace Cache subdirectory under .cache/ (e.g. "rerank", "expand").
 * @param tpm Pace uncached calls to this many tokens per minute (0 = no pacing).
 */
export async function taskCache(namespace: string, tm: TaskModel, tpm: number) {
  const dir = join(CACHE_ROOT, namespace)
  await mkdir(dir, { recursive: true })
  let nextCallAt = 0

  return async function cached<T extends Usage>(instructions: string, prompt: string, call: () => Promise<T>): Promise<Cached<T>> {
    const key = createHash('sha256').update(`${tm.id}\n${JSON.stringify(tm.providerOptions)}\n${prompt}`).digest('hex').slice(0, 24)
    const file = join(dir, `${key}.json`)
    const instructionsHash = createHash('sha256').update(instructions).digest('hex').slice(0, 16)
    if (await access(file).then(() => true, () => false)) {
      const entry = JSON.parse(await readFile(file, 'utf8'))
      if (entry.instructionsHash === undefined || entry.instructionsHash === instructionsHash) return { ...entry, cached: true }
    }

    for (let attempt = 1; ; attempt++) {
      await new Promise(r => setTimeout(r, Math.max(0, nextCallAt - Date.now())))
      const start = performance.now()
      try {
        const result = await call()
        const ms = performance.now() - start
        const tokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0)
        if (tpm > 0) nextCallAt = Date.now() + (tokens / tpm) * 60_000
        await writeFile(file, JSON.stringify({ ...result, ms, instructionsHash }))
        return { ...result, ms, cached: false }
      }
      catch (error) {
        const wait = retryAfterMs(error) ?? 15_000 * attempt
        if (wait > MAX_WAIT_MS) {
          // An expected stop, not a crash: no stack trace or request dump.
          console.error(`\n${tm.id}: rate limit needs a ${Math.ceil(wait / 60_000)} min wait, so its daily token quota is spent.`
            + `\nIt refills gradually over 24 h; re-run later and the cached results are reused.`)
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
