// Task-model calls for the eval scripts (reranking, query rewriting), cached
// on disk and paced to Groq's free-tier limits: 8K tokens/min and 200K
// tokens/day per model (ADR-0007). Cached results cost nothing on re-runs and
// are shared between scripts.
//
// Cache: .cache/<namespace>/<hash of model id + provider options + the exact
// prompt>.json, so any change to the inputs or the prompt text is a new call.
// Each entry also records a hash of the system instructions and the version
// of the post-processing it stores (RESULT_VERSIONS); either differing is a
// miss. Rerank entries from before the hash count as LEGACY_RERANK_HASH, the
// instructions they were made with, so they stop matching once those change.
//
// Pacing is per model id across namespaces: Groq meters each model's 8K
// tokens/min once, whether the call ranks or rewrites.

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { APICallError } from 'ai'
import type { TaskModel } from '../../server/rag/model'

const CACHE_ROOT = join(resolve(import.meta.dirname, '../..'), '.cache')

/** RERANK_INSTRUCTIONS as of e9be9f0, which made the entries without instructionsHash. */
const LEGACY_RERANK_HASH = '9d4a8ddfed62d5c6'

/**
 * Bump a namespace's version when the code between the model's output and the
 * cached result changes (repairRanking for rerank, validateRewrites for expand).
 */
const RESULT_VERSIONS: Record<string, number> = { rerank: 1, expand: 1 }

/** Whether a stored entry was made with these instructions and the namespace's current post-processing. */
export function isCurrentEntry(entry: { instructionsHash?: string, version?: number }, namespace: string, instructionsHash: string): boolean {
  const madeWith = entry.instructionsHash ?? (namespace === 'rerank' ? LEGACY_RERANK_HASH : undefined)
  return madeWith === instructionsHash && (entry.version ?? 1) === (RESULT_VERSIONS[namespace] ?? 1)
}

/** When each model id may next be called, shared by every cache in the process. */
export const nextCallAt = new Map<string, number>()

/** Longest rate-limit wait worth sitting through; beyond it (a spent daily quota) the run stops. */
export const MAX_WAIT_MS = 5 * 60_000

/** Ends the run on a spent daily quota: an expected stop, so no stack trace or request dump. */
export function stopOnSpentQuota(modelId: string, waitMs: number): never {
  console.error(`\n${modelId}: rate limit needs a ${Math.ceil(waitMs / 60_000)} min wait, so its daily token quota is spent.`
    + `\nIt refills gradually over 24 h; re-run later and the cached results are reused.`)
  process.exit(2)
}

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
  const version = RESULT_VERSIONS[namespace] ?? 1

  return async function cached<T extends Usage>(instructions: string, prompt: string, call: () => Promise<T>): Promise<Cached<T>> {
    const key = createHash('sha256').update(`${tm.id}\n${JSON.stringify(tm.providerOptions)}\n${prompt}`).digest('hex').slice(0, 24)
    const file = join(dir, `${key}.json`)
    const instructionsHash = createHash('sha256').update(instructions).digest('hex').slice(0, 16)
    if (await access(file).then(() => true, () => false)) {
      const entry = JSON.parse(await readFile(file, 'utf8'))
      if (isCurrentEntry(entry, namespace, instructionsHash)) return { ...entry, cached: true }
    }

    for (let attempt = 1; ; attempt++) {
      await new Promise(r => setTimeout(r, Math.max(0, (nextCallAt.get(tm.id) ?? 0) - Date.now())))
      const start = performance.now()
      try {
        const result = await call()
        const ms = performance.now() - start
        const tokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0)
        if (tpm > 0) nextCallAt.set(tm.id, Date.now() + (tokens / tpm) * 60_000)
        await writeFile(file, JSON.stringify({ ...result, ms, instructionsHash, version }))
        return { ...result, ms, cached: false }
      }
      catch (error) {
        const wait = retryAfterMs(error) ?? 15_000 * attempt
        if (wait > MAX_WAIT_MS) stopOnSpentQuota(tm.id, wait)
        if (attempt >= 6) throw error
        console.log(`  retry ${attempt}/5 in ${Math.ceil(wait / 1000)}s: ${String(error).slice(0, 140)}`)
        nextCallAt.set(tm.id, Date.now() + wait)
      }
    }
  }
}

/** The Retry-After of a 429, in ms. */
export function retryAfterMs(error: unknown): number | undefined {
  if (!APICallError.isInstance(error) || error.statusCode !== 429) return undefined
  const seconds = Number(error.responseHeaders?.['retry-after'])
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}
