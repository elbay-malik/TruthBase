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
// (429 rate limit, 5xx) goes straight to Gemini. The AI SDK's own retry loop
// (`maxRetries`) wraps this whole chain, so each SDK attempt tries both.

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
 * Rate limits and provider outages, as opposed to bad requests. Looks through
 * the AI SDK's RetryError, which wraps the last attempt's error once
 * `maxRetries` is exhausted.
 */
export function isFallbackError(error: unknown): boolean {
  if (RetryError.isInstance(error)) return isFallbackError(error.lastError)
  if (!APICallError.isInstance(error)) return false
  return error.statusCode === 429 || (error.statusCode ?? 0) >= 500
}

/**
 * A model that calls `primary` and, if the request is rejected before any
 * output (429 / 5xx), calls `fallback` with the same options. Once streaming
 * has started there is no switch: the stream's own error handling applies.
 */
export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4): LanguageModelV4 {
  const attempt = async <T>(call: (model: LanguageModelV4) => PromiseLike<T>): Promise<T> => {
    try {
      return await call(primary)
    }
    catch (error) {
      if (!isFallbackError(error)) throw error
      console.warn(`[model] ${primary.provider}/${primary.modelId} unavailable (${(error as APICallError).statusCode}); falling back to ${fallback.provider}/${fallback.modelId}`)
      return await call(fallback)
    }
  }
  return {
    specificationVersion: 'v4',
    provider: primary.provider,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    doGenerate: (options: LanguageModelV4CallOptions) => attempt(m => m.doGenerate(options)),
    doStream: (options: LanguageModelV4CallOptions) => attempt(m => m.doStream(options)),
  }
}
