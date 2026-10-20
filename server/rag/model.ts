import { createGoogle } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { APICallError, RetryError } from 'ai'

// Generation model selection (ADR-0001, amended in ADR-0005): Groq
// gpt-oss-120b, with Gemini Flash-Lite as the fallback. llama-3.3-70b-versatile
// (the plan's choice) is no longer served by Groq and gemini-2.5-flash-lite is
// closed to new users (TECH_NOTES §9).
//
// Groq's free tier is 8K tokens/min (~3 answers/min across all users), so when
// both keys are set, a Groq request that is rejected before streaming starts
// (429 rate limit, 5xx, unreachable, or no stream within 10 s) goes straight
// to Gemini. The AI SDK's own retry loop (`maxRetries`) wraps this whole
// chain, so each SDK attempt tries both.

export const GROQ_MODEL = 'openai/gpt-oss-120b'
export const GEMINI_MODEL = 'gemini-3.5-flash-lite'

export interface ModelKeys {
  groqApiKey?: string
  geminiApiKey?: string
}

type SharedProviderOptions = NonNullable<Parameters<typeof import('ai').streamText>[0]['providerOptions']>

export interface ChatModel {
  model: LanguageModelV4
  /** "provider/model" (or "primary → fallback"), for logs, traces and eval reports. */
  id: string
  /** Pass to streamText/generateText; each provider reads only its own namespace. */
  providerOptions: SharedProviderOptions
}

// gpt-oss is a reasoning model: keep reasoning short (latency, free-tier token
// quota) and out of the answer stream.
const GROQ_OPTIONS = { groq: { reasoningEffort: 'low', reasoningFormat: 'hidden' } } as const

/**
 * @param prefer Force one provider (the eval compares them); by default Groq
 *   with Gemini as fallback when both keys are configured.
 */
export function chatModel(keys: ModelKeys, prefer?: 'groq' | 'gemini'): ChatModel {
  const groq = keys.groqApiKey && prefer !== 'gemini' ? createGroq({ apiKey: keys.groqApiKey })(GROQ_MODEL) : undefined
  const gemini = keys.geminiApiKey && prefer !== 'groq' ? createGoogle({ apiKey: keys.geminiApiKey })(GEMINI_MODEL) : undefined

  if (groq && gemini) {
    return {
      model: withFallback(groq, gemini),
      id: `groq/${GROQ_MODEL} → google/${GEMINI_MODEL}`,
      providerOptions: GROQ_OPTIONS,
    }
  }
  if (groq) return { model: groq, id: `groq/${GROQ_MODEL}`, providerOptions: GROQ_OPTIONS }
  if (gemini) return { model: gemini, id: `google/${GEMINI_MODEL}`, providerOptions: {} }
  throw new Error(prefer
    ? `The ${prefer} model is not configured (set its API key).`
    : 'No generation model configured (set NUXT_GROQ_API_KEY or NUXT_GEMINI_API_KEY).')
}

/**
 * Rate limits and provider outages, as opposed to bad requests: 429, 5xx, and
 * connection failures (DNS, refused, reset), which reach us as an
 * APICallError without a status code. Looks through the AI SDK's RetryError,
 * which wraps the last attempt's error once `maxRetries` is exhausted.
 */
export function isFallbackError(error: unknown): boolean {
  if (RetryError.isInstance(error)) return isFallbackError(error.lastError)
  if (!APICallError.isInstance(error)) return false
  return error.statusCode === undefined || error.statusCode === 429 || error.statusCode >= 500
}

/** How long the primary may take to start streaming before the fallback gets the request. */
export const PRIMARY_STREAM_TIMEOUT_MS = 10_000

/**
 * A model that calls `primary` and, if the request is rejected before any
 * output (429 / 5xx / unreachable) or a stream doesn't start within
 * `streamTimeoutMs`, calls `fallback` with the same options. Once streaming
 * has started there is no switch: the stream's own error handling applies.
 */
export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4, streamTimeoutMs = PRIMARY_STREAM_TIMEOUT_MS): LanguageModelV4 {
  const attempt = async <T>(options: LanguageModelV4CallOptions, call: (model: LanguageModelV4, options: LanguageModelV4CallOptions) => PromiseLike<T>, timeoutMs?: number): Promise<T> => {
    // Only the wait for the response is budgeted: the timer stops once the
    // call returns, so a long stream after that is never cut.
    const budget = new AbortController()
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => budget.abort(new DOMException(`no response within ${timeoutMs} ms`, 'TimeoutError')), timeoutMs)
    const abortSignal = AbortSignal.any([budget.signal, options.abortSignal].filter(s => s !== undefined))
    try {
      return await call(primary, { ...options, abortSignal })
    }
    catch (error) {
      if (options.abortSignal?.aborted || !(budget.signal.aborted || isFallbackError(error))) throw error
      const reason = budget.signal.aborted ? 'timed out' : (error as APICallError).statusCode ?? 'unreachable'
      console.warn(`[model] ${primary.provider}/${primary.modelId} unavailable (${reason}); falling back to ${fallback.provider}/${fallback.modelId}`)
      return await call(fallback, options)
    }
    finally {
      clearTimeout(timer)
    }
  }
  return {
    specificationVersion: 'v4',
    provider: primary.provider,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    doGenerate: (options: LanguageModelV4CallOptions) => attempt(options, (m, o) => m.doGenerate(o)),
    doStream: (options: LanguageModelV4CallOptions) => attempt(options, (m, o) => m.doStream(o), streamTimeoutMs),
  }
}

// ── Task models: small structured calls around retrieval ─────────────────
// Reranking (ADR-0007) and query rewriting (ADR-0009). Groq's free tier meters
// each model separately (8K tokens/min, 200K tokens/day), so a task on a
// different model than the answer's (gpt-oss-120b) draws on its own quota.

export type TaskModelChoice = 'groq-20b' | 'groq-120b' | 'groq-qwen' | 'gemini'

const TASK_MODEL_CHOICES: readonly string[] = ['groq-20b', 'groq-120b', 'groq-qwen', 'gemini'] satisfies TaskModelChoice[]

export interface TaskModel {
  model: LanguageModelV4
  /** "provider/model", for logs and eval reports. */
  id: string
  providerOptions: SharedProviderOptions
}

const GROQ_TASK_MODELS = {
  'groq-20b': 'openai/gpt-oss-20b',
  'groq-120b': GROQ_MODEL,
  'groq-qwen': 'qwen/qwen3.8-27b',
} as const

/** The model for a task choice, or undefined when its API key is missing. */
export function taskModel(keys: ModelKeys, choice: TaskModelChoice): TaskModel | undefined {
  if (choice === 'gemini') {
    if (!keys.geminiApiKey) return undefined
    return { model: createGoogle({ apiKey: keys.geminiApiKey })(GEMINI_MODEL), id: `google/${GEMINI_MODEL}`, providerOptions: {} }
  }
  if (!keys.groqApiKey) return undefined
  const id = GROQ_TASK_MODELS[choice]
  return {
    model: createGroq({ apiKey: keys.groqApiKey })(id),
    id: `groq/${id}`,
    providerOptions: {
      groq: choice === 'groq-qwen'
        ? { reasoningEffort: 'none' }
        : { reasoningEffort: 'low', reasoningFormat: 'hidden' },
    },
  }
}

/**
 * The task model a runtimeConfig value names (e.g. NUXT_RERANK_MODEL), or
 * undefined when it is "off", unknown, or its API key is missing.
 */
export function configuredTaskModel(keys: ModelKeys, choice: unknown): TaskModel | undefined {
  const name = String(choice ?? '')
  return TASK_MODEL_CHOICES.includes(name) ? taskModel(keys, name as TaskModelChoice) : undefined
}

