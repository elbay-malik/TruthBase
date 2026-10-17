import { SearchError, searchChunks, type HybridSearchParams, type SearchHit } from '../rag/search'

// Nitro-side hybrid search: the framework-free core lives in server/rag/search.ts
// (shared with the golden-set eval); this adds the service-role client and maps
// failures to 502. Auto-imported by Nitro.

export type { HybridSearchParams, SearchHit } from '../rag/search'

export async function hybridSearch(params: HybridSearchParams): Promise<SearchHit[]> {
  try {
    return await searchChunks(serverSupabase(), params)
  }
  catch (error) {
    if (!(error instanceof SearchError)) throw error
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: error.message })
  }
}
