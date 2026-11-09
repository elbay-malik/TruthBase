// promptfoo provider: the production answer pipeline (ADR-0008). Retrieval is
// server/rag/retrieve.ts unchanged (hosted hybrid_search_bge_m3, multi-query
// rewriting, reranking), then a grounded answer as POST /api/chat generates it
// (non-streamed). Every model call goes through a disk cache
// (scripts/lib/cached-model.ts), so a run stopped by a spent daily quota
// resumes for free and re-runs cost nothing.
//
// Models follow the app's runtime config: NUXT_EXPAND_MODEL and
// NUXT_RERANK_MODEL (task models; "off" disables), the answer model chain
// is Groq's alone: a rate limit is paced and retried, or stops the run. The
// Cloudflare fallback stays out, because its free Neurons are the live demo's.

import { createClient } from '@supabase/supabase-js'
import { generateText } from 'ai'
import { cloudflareEmbedder } from '../../server/ingest/embed'
import { DEFAULT_EXPAND_MODEL } from '../../server/rag/expand'
import { chatModel, configuredTaskModel, type TaskModel } from '../../server/rag/model'
import { buildPrompt, contextLine, GROUNDING_INSTRUCTIONS, isRefusal, parseCitations } from '../../server/rag/prompt'
import { DEFAULT_RERANK_MODEL } from '../../server/rag/rerank'
import { retrieveSources } from '../../server/rag/retrieve'
import { NO_ANSWER } from '../../shared/types/chat'
import { cachedLanguageModel, type ModelCallStats } from '../lib/cached-model'

/** The parts of promptfoo's ProviderResponse this provider fills. */
interface ProviderResponse {
  output?: string
  error?: string
  tokenUsage?: { total?: number, prompt?: number, completion?: number }
  metadata?: Record<string, unknown>
}

// promptfoo loads .env from the working directory itself; CI sets real env vars.
const env = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set (in .env locally, as a secret in CI)`) })()

/** Tokens/min for uncached calls: under Groq's 8K per model (paced per model, across tasks). */
const TPM = 7500
const stats: ModelCallStats = { calls: 0, cached: 0 }

async function cachedTaskModel(tm: TaskModel | undefined, namespace: string): Promise<TaskModel | undefined> {
  return tm && { ...tm, model: await cachedLanguageModel(tm.model, namespace, TPM, stats) }
}

const pipeline = (async () => {
  const keys = { groqApiKey: process.env.NUXT_GROQ_API_KEY, geminiApiKey: process.env.NUXT_GEMINI_API_KEY }
  const answer = chatModel(keys, 'groq')
  return {
    supabase: createClient(env('NUXT_SUPABASE_URL'), env('NUXT_SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } }),
    embed: cloudflareEmbedder({ cloudflareAccountId: env('NUXT_CLOUDFLARE_ACCOUNT_ID'), cloudflareApiToken: env('NUXT_CLOUDFLARE_API_TOKEN') }),
    expander: await cachedTaskModel(configuredTaskModel(keys, process.env.NUXT_EXPAND_MODEL ?? DEFAULT_EXPAND_MODEL), 'expand'),
    reranker: await cachedTaskModel(configuredTaskModel(keys, process.env.NUXT_RERANK_MODEL ?? DEFAULT_RERANK_MODEL), 'rerank'),
    answer: { ...answer, model: await cachedLanguageModel(answer.model, 'answer', TPM, stats) },
  }
})()

export default class TruthBaseProvider {
  id(): string {
    return 'truthbase'
  }

  async callApi(prompt: string, context?: { vars?: Record<string, unknown> }): Promise<ProviderResponse> {
    const question = String(context?.vars?.question ?? prompt)
    const p = await pipeline
    const { sources, rewrites, reranked } = await retrieveSources(p.supabase, p.embed, question, {
      expander: p.expander,
      reranker: p.reranker,
      // Pacing and rate-limit waits happen inside the step; don't let the
      // production budget turn them into silent fallbacks.
      stepTimeoutMs: 15 * 60_000,
    })

    let text = NO_ANSWER
    let tokenUsage: ProviderResponse['tokenUsage']
    let answeredBy = 'none (no sources)'
    if (sources.length) {
      const result = await generateText({
        model: p.answer.model,
        instructions: GROUNDING_INSTRUCTIONS,
        prompt: buildPrompt(question, sources),
        temperature: 0,
        maxOutputTokens: 700,
        maxRetries: 0, // the cached model paces and retries
        providerOptions: p.answer.providerOptions,
      })
      text = result.text.trim()
      answeredBy = result.response.modelId
      tokenUsage = { prompt: result.usage.inputTokens, completion: result.usage.outputTokens, total: result.usage.totalTokens }
    }

    return {
      output: text,
      tokenUsage,
      metadata: {
        refused: isRefusal(text, sources.length),
        cited: parseCitations(text, sources.length),
        // The judge grades against what the answer model saw, context included.
        sources: sources.map(s => ({ index: s.index, filename: s.filename, pageNumber: s.pageNumber, content: s.content, ...(s.context ? { context: s.context } : {}) })),
        // For model-graded assertions: one numbered passage per source.
        contexts: sources.map(s => `[${s.index}] ${s.filename} p.${s.pageNumber ?? '?'}: ${contextLine(s.context, text => text)}${s.content}`),
        expander: p.expander?.id ?? 'off',
        reranker: p.reranker?.id ?? 'off',
        rewrites,
        reranked,
        answeredBy,
        modelCalls: { ...stats },
      },
    }
  }
}
