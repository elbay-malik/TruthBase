import { searchRequestSchema } from '#shared/schemas'
import { geminiEmbedder, INTERACTIVE_EMBED_LIMITS } from '../ingest/embed'
import { retrieveSources } from '../rag/retrieve'
import { SearchError } from '../rag/search'

// POST /api/search { query, documentId?, topK? } → ranked sources without
// generation: the retrieval half of /api/chat, for debugging and Phase 6
// tuning. Plain hybrid retrieval (RRF with the tuned SQL defaults) with no LLM
// steps: no rewrites and no reranker, so `reranked` is always false (ADR-0010).
export default defineEventHandler(async (event) => {
  // A client that goes away cancels the embedding call.
  const abort = new AbortController()
  event.node.res.on('close', () => {
    if (!event.node.res.writableFinished) abort.abort()
  })
  assertSameSiteJson(event)
  const { query, documentId, topK } = await readValidatedBody(event, searchRequestSchema.parse)
  const config = useRuntimeConfig(event)
  if (!config.geminiApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'Query embeddings are not configured (set NUXT_GEMINI_API_KEY).' })
  }
  const supabase = serverSupabase()
  // Per-minute and daily limits (ADR-0010): search spends embedding quota only.
  const quota = quotaConfig('search')
  if (quota) await enforceQuota(event, supabase, 'search', quota.limits, quota.options)
  try {
    return await retrieveSources(supabase, geminiEmbedder(config.geminiApiKey, 'RETRIEVAL_QUERY', abort.signal, INTERACTIVE_EMBED_LIMITS), query, {
      topK, documentId, abortSignal: abort.signal,
    })
  }
  catch (error) {
    // The client is gone: nobody to answer, and nothing to log.
    if (abort.signal.aborted) return null
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw createError({ statusCode: 504, statusMessage: 'Gateway Timeout', message: 'Search timed out, try again.' })
    }
    if (!(error instanceof SearchError)) throw error
    console.error('[search] retrieval failed:', error.message)
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'Search failed.' })
  }
})
