// Rerank calls for the eval scripts (scripts/lib/task-cache.ts). Shared by
// eval:rerank and eval:answers, so the answers eval reuses rankings
// eval:rerank already paid for: both spend the reranker model's 200K
// tokens/day (ADR-0007).

import type { TaskModel } from '../../server/rag/model'
import { buildRerankPrompt, rankPassages, RERANK_INSTRUCTIONS, type Ranking } from '../../server/rag/rerank'
import type { SearchHit } from '../../server/rag/search'
import { taskCache, type Cached } from './task-cache'

export type CachedRanking = Cached<Ranking>

/**
 * @param tpm Pace uncached calls to this many tokens per minute (0 = no pacing).
 */
export async function rankingCache(rm: TaskModel, filenameById: Map<string, string>, tpm: number) {
  const cached = await taskCache('rerank', rm, tpm)
  return (question: string, hits: SearchHit[]): Promise<CachedRanking> =>
    cached(RERANK_INSTRUCTIONS, buildRerankPrompt(question, hits, filenameById), () => rankPassages(rm, question, hits, filenameById))
}
