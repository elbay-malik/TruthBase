import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { embedMany } from 'ai'
import { l2Normalize } from '../../shared/utils/vector'

// Text → 1024-dim, L2-normalized bge-m3 embeddings on Cloudflare Workers AI.
// Must match `chunks.embedding_bge_m3 vector(1024)`. bge-m3 has no separate
// document and query modes, so ingestion and search use the same call.

export const EMBEDDING_MODEL = '@cf/baai/bge-m3'
export const EMBEDDING_DIMENSIONS = 1024

/** Embeds a batch of texts; returns one unit-length vector per text, in order. */
export type Embedder = (texts: string[]) => Promise<number[][]>

export interface EmbeddingKeys {
  cloudflareAccountId?: string
  cloudflareApiToken?: string
}

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

export const embeddingsConfigured = (keys: EmbeddingKeys) => Boolean(keys.cloudflareAccountId && keys.cloudflareApiToken)

/** @param abortSignal Cancels in-flight requests (client disconnected). */
export function cloudflareEmbedder(keys: EmbeddingKeys, abortSignal?: AbortSignal, limits: EmbedLimits = {}): Embedder {
  if (!embeddingsConfigured(keys)) throw new Error('Embeddings are not configured (set the NUXT_CLOUDFLARE_* values).')
  const model = createOpenAICompatible({
    name: 'cloudflare',
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${keys.cloudflareAccountId}/ai/v1`,
    apiKey: keys.cloudflareApiToken,
  }).embeddingModel(EMBEDDING_MODEL)

  return async (texts) => {
    const timeout = limits.timeoutMs === undefined ? undefined : AbortSignal.timeout(limits.timeoutMs)
    const signals = [abortSignal, timeout].filter(s => s !== undefined)
    const { embeddings } = await embedMany({
      model,
      values: texts,
      maxRetries: limits.maxRetries ?? 5,
      abortSignal: signals.length ? AbortSignal.any(signals) : undefined,
    }).catch((error: unknown) => {
      // The budget can run out during a retry's wait, which the SDK reports as a
      // plain AbortError. Callers tell a timeout from a disconnect by its name.
      throw timeout?.aborted && !abortSignal?.aborted ? timeout.reason : error
    })
    return embeddings.map((embedding) => {
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`expected ${EMBEDDING_DIMENSIONS}-dim embeddings, got ${embedding.length}`)
      }
      return l2Normalize(embedding)
    })
  }
}
