// A language model whose generate calls are cached on disk and paced to
// Groq's free-tier limits, for evals that run the production pipeline
// unchanged (scripts/promptfoo). Interrupted runs resume for free: identical
// calls (same model, messages including the system instructions, response
// format and options) return the stored result.
//
// Cache: .cache/models/<namespace>/<hash>.json.

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LanguageModelV4, LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import { wrapLanguageModel } from 'ai'
import { ROOT } from './golden'
import { MAX_WAIT_MS, retryAfterMs, stopOnSpentQuota } from './task-cache'

export interface ModelCallStats { calls: number, cached: number }

/**
 * @param tpm Pace uncached calls to this many tokens per minute (0 = no pacing).
 */
export async function cachedLanguageModel(model: LanguageModelV4, namespace: string, tpm: number, stats?: ModelCallStats): Promise<LanguageModelV4> {
  const dir = join(ROOT, '.cache/models', namespace)
  await mkdir(dir, { recursive: true })
  let nextCallAt = 0
  const id = `${model.provider}/${model.modelId}`

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: async ({ doGenerate, params }) => {
        const { prompt, responseFormat, temperature, maxOutputTokens, providerOptions } = params
        const key = createHash('sha256')
          .update(JSON.stringify({ id, prompt, responseFormat, temperature, maxOutputTokens, providerOptions }))
          .digest('hex').slice(0, 24)
        const file = join(dir, `${key}.json`)
        if (stats) stats.calls++
        if (await access(file).then(() => true, () => false)) {
          if (stats) stats.cached++
          const stored = JSON.parse(await readFile(file, 'utf8')) as LanguageModelV4GenerateResult
          if (stored.response?.timestamp) stored.response.timestamp = new Date(stored.response.timestamp)
          return stored
        }
        for (let attempt = 1; ; attempt++) {
          await new Promise(r => setTimeout(r, Math.max(0, nextCallAt - Date.now())))
          try {
            const result = await doGenerate()
            const tokens = (result.usage.inputTokens.total ?? 0) + (result.usage.outputTokens.total ?? 0)
            if (tpm > 0) nextCallAt = Date.now() + (tokens / tpm) * 60_000
            // The request echo can hold the API key in headers; keep only what replays.
            const { request: _request, ...replayable } = result
            await writeFile(file, JSON.stringify(replayable))
            return result
          }
          catch (error) {
            const wait = retryAfterMs(error) ?? 15_000 * attempt
            if (wait > MAX_WAIT_MS) stopOnSpentQuota(id, wait)
            if (attempt >= 6) throw error
            console.log(`  ${id} retry ${attempt}/5 in ${Math.ceil(wait / 1000)}s: ${String(error).slice(0, 140)}`)
            nextCallAt = Date.now() + wait
          }
        }
      },
    },
  })
}
