import { createGoogle } from '@ai-sdk/google'
import { embedMany } from 'ai'
import { l2Normalize } from '../../shared/utils/vector'

// Phase 3, step 4: chunk text → 768-dim, L2-normalized Gemini embeddings.
// Must match the `chunks.embedding vector(768)` column (ADR-0002) and the
// query-side embedding added in Phase 4 (same model, RETRIEVAL_QUERY task).

export const EMBEDDING_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIMENSIONS = 768

/** Embeds a batch of texts; returns one unit-length vector per text, in order. */
export type Embedder = (texts: string[]) => Promise<number[][]>

export type EmbeddingTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'

export interface EmbedLimits {
  /** SDK retries with exponential backoff (2 s, 4 s, …); default 5, about a minute in all. */
  maxRetries?: number
  /** Budget per call, retries included. */
  timeoutMs?: number
}

/**
 * Limits for a user waiting on a query embedding (chat, search): one retry,
 * then fail fast instead of backing off for a minute before the first byte.
 * Batch ingestion and evals keep the default retries.
 */
export const INTERACTIVE_EMBED_LIMITS: EmbedLimits = { maxRetries: 1, timeoutMs: 8_000 }

/** @param abortSignal Cancels in-flight requests (client disconnected). */
export function geminiEmbedder(apiKey: string, taskType: EmbeddingTask, abortSignal?: AbortSignal, limits: EmbedLimits = {}): Embedder {
  const google = createGoogle({ apiKey })
  const model = google.embedding(EMBEDDING_MODEL)

  return async (texts) => {
    const signals = [abortSignal, limits.timeoutMs === undefined ? undefined : AbortSignal.timeout(limits.timeoutMs)].filter(s => s !== undefined)
    const { embeddings } = await embedMany({
      model,
      values: texts,
      maxRetries: limits.maxRetries ?? 5, // free-tier 429s back off and retry inside the SDK
      abortSignal: signals.length ? AbortSignal.any(signals) : undefined,
      providerOptions: { google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType } },
    })
    return embeddings.map((embedding) => {
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`expected ${EMBEDDING_DIMENSIONS}-dim embeddings, got ${embedding.length}`)
      }
      // Truncated Gemini vectors are not unit-length (docs/TECH_NOTES.md §2).
      return l2Normalize(embedding)
    })
  }
}
