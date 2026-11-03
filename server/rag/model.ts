import { createGoogle } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { APICallError, RetryError } from 'ai'
import { withoutHarmony } from './harmony'

// Generation model selection (ADR-0001, amended in ADR-0005): Groq
// gpt-oss-120b, with the same model on Cloudflare Workers AI as the fallback.
// llama-3.3-70b-versatile (the plan's choice) is no longer served by Groq.
//
// Groq's free tier is 8K tokens/min (~3 answers/min across all users), so when
// both are configured, a Groq request that fails before streaming starts (any
// API error, unreachable, or no stream within 10 s) goes straight to
// Cloudflare. The AI SDK's own retry loop (`maxRetries`) wraps this whole
// chain, so each SDK attempt tries both. Cloudflare's free 10,000 Neurons a day
// cover about 147 answers; past that its requests fail, and the visitor gets
// the "busy" message.

export const GROQ_MODEL = 'openai/gpt-oss-120b'
export const GEMINI_MODEL = 'gemini-3.5-flash-lite'
export const CLOUDFLARE_MODEL = '@cf/openai/gpt-oss-120b'

export interface ModelKeys {
  groqApiKey?: string
  /** Only for `chatModel(keys, 'gemini')` and the `gemini` task model. */
  geminiApiKey?: string
  cloudflareAccountId?: string
  cloudflareApiToken?: string
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
const CLOUDFLARE_OPTIONS = { cloudflare: { reasoningEffort: 'low' } } as const

function cloudflareModel(keys: ModelKeys): LanguageModelV4 | undefined {
  if (!keys.cloudflareAccountId || !keys.cloudflareApiToken) return undefined
  return withoutHarmony(createOpenAICompatible({
    name: 'cloudflare',
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${keys.cloudflareAccountId}/ai/v1`,
    apiKey: keys.cloudflareApiToken,
  }).chatModel(CLOUDFLARE_MODEL))
}

/**
 * @param prefer Force one provider (the evals compare them); by default Groq
 *   with Cloudflare as fallback when both are configured. Gemini only by name.
 */
export function chatModel(keys: ModelKeys, prefer?: 'groq' | 'cloudflare' | 'gemini'): ChatModel {
  if (prefer === 'gemini') {
    if (!keys.geminiApiKey) throw new Error('The gemini model is not configured (set its API key).')
    return { model: createGoogle({ apiKey: keys.geminiApiKey })(GEMINI_MODEL), id: `google/${GEMINI_MODEL}`, providerOptions: {} }
  }
  const groq = keys.groqApiKey && prefer !== 'cloudflare' ? createGroq({ apiKey: keys.groqApiKey })(GROQ_MODEL) : undefined
  const cloudflare = prefer === 'groq' ? undefined : cloudflareModel(keys)

  if (groq && cloudflare) {
    return {
      model: withFallback(groq, cloudflare),
      id: `groq/${GROQ_MODEL} → cloudflare/${CLOUDFLARE_MODEL}`,
      providerOptions: { ...GROQ_OPTIONS, ...CLOUDFLARE_OPTIONS },
    }
  }
  if (groq) return { model: groq, id: `groq/${GROQ_MODEL}`, providerOptions: GROQ_OPTIONS }
  if (cloudflare) return { model: cloudflare, id: `cloudflare/${CLOUDFLARE_MODEL}`, providerOptions: CLOUDFLARE_OPTIONS }
  throw new Error(prefer
    ? `The ${prefer} model is not configured (set its API key).`
    : 'No generation model configured (set NUXT_GROQ_API_KEY or the NUXT_CLOUDFLARE_* values).')
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

/**
 * Any API error from the primary, also the 4xx that isFallbackError leaves out:
 * a retired model or a parameter Groq starts rejecting shouldn't take answers
 * down while the fallback works. Not used for the "busy" message, which must
 * stay true to isFallbackError.
 */
function isApiError(error: unknown): boolean {
  if (RetryError.isInstance(error)) return isApiError(error.lastError)
  return APICallError.isInstance(error)
}

/** How long the primary may take to start streaming before the fallback gets the request. */
export const PRIMARY_STREAM_TIMEOUT_MS = 10_000

/**
 * A model that calls `primary` and, if the request fails before any output
 * (an API error of any status, unreachable) or a stream doesn't start within
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
      if (options.abortSignal?.aborted || !(budget.signal.aborted || isApiError(error))) throw error
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

