import { createGoogle } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import type { LanguageModel } from 'ai'

// Generation model selection (ADR-0001, amended in ADR-0005): Groq
// gpt-oss-120b when a Groq key is configured, otherwise Gemini Flash-Lite.
// llama-3.3-70b-versatile (the plan's choice) is no longer served by Groq
// (TECH_NOTES §9). Free tiers are rate-limited, so the eval script throttles
// and Phase 11 adds per-IP caps.

export const GROQ_MODEL = 'openai/gpt-oss-120b'
// gemini-2.5-flash-lite (the plan's fallback) is closed to new API users (TECH_NOTES §9).
export const GEMINI_MODEL = 'gemini-3.5-flash-lite'

export interface ModelKeys {
  groqApiKey?: string
  geminiApiKey?: string
}

export interface ChatModel {
  model: LanguageModel
  /** "provider/model", for logs, traces and eval reports. */
  id: string
  /** Pass to streamText/generateText so every caller uses the same settings. */
  providerOptions: SharedProviderOptions
}

type SharedProviderOptions = NonNullable<Parameters<typeof import('ai').streamText>[0]['providerOptions']>

export function chatModel(keys: ModelKeys): ChatModel {
  if (keys.groqApiKey) {
    return {
      model: createGroq({ apiKey: keys.groqApiKey })(GROQ_MODEL),
      id: `groq/${GROQ_MODEL}`,
      // gpt-oss is a reasoning model: keep reasoning short (latency, free-tier
      // token quota) and out of the answer stream.
      providerOptions: { groq: { reasoningEffort: 'low', reasoningFormat: 'hidden' } },
    }
  }
  if (keys.geminiApiKey) {
    return { model: createGoogle({ apiKey: keys.geminiApiKey })(GEMINI_MODEL), id: `google/${GEMINI_MODEL}`, providerOptions: {} }
  }
  throw new Error('No generation model configured (set NUXT_GROQ_API_KEY or NUXT_GEMINI_API_KEY).')
}
