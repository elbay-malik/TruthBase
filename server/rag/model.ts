import { createGoogle } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import type { LanguageModel } from 'ai'

// Generation model selection (ADR-0001): Groq llama-3.3-70b-versatile when a
// Groq key is configured, otherwise Gemini Flash-Lite. Both free tiers are
// rate-limited (Groq 1K RPD / 100K TPD; Gemini ~15 RPM), so the eval script
// throttles and Phase 11 adds per-IP caps.

export const GROQ_MODEL = 'llama-3.3-70b-versatile'
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
}

export function chatModel(keys: ModelKeys): ChatModel {
  if (keys.groqApiKey) {
    return { model: createGroq({ apiKey: keys.groqApiKey })(GROQ_MODEL), id: `groq/${GROQ_MODEL}` }
  }
  if (keys.geminiApiKey) {
    return { model: createGoogle({ apiKey: keys.geminiApiKey })(GEMINI_MODEL), id: `google/${GEMINI_MODEL}` }
  }
  throw new Error('No generation model configured (set NUXT_GROQ_API_KEY or NUXT_GEMINI_API_KEY).')
}
