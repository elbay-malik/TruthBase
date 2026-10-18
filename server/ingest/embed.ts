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

/** @param abortSignal Cancels in-flight requests (client disconnected). */
export function geminiEmbedder(apiKey: string, taskType: EmbeddingTask, abortSignal?: AbortSignal): Embedder {
  const google = createGoogle({ apiKey })
  const model = google.embedding(EMBEDDING_MODEL)

  return async (texts) => {
    const { embeddings } = await embedMany({
      model,
      values: texts,
      maxRetries: 5, // free-tier 429s back off and retry inside the SDK
      abortSignal,
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
