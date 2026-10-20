import { searchRequestSchema } from '#shared/schemas'
import { geminiEmbedder } from '../ingest/embed'
import { configuredTaskModel } from '../rag/model'
import { configuredReranker } from '../rag/rerank'
import { retrieveSources } from '../rag/retrieve'
import { SearchError } from '../rag/search'

// POST /api/search { query, documentId?, topK? } → ranked sources without
// generation: the retrieval half of /api/chat, for debugging and Phase 6
// tuning. Same ranking as the chat route (hybrid RRF with the tuned SQL
// defaults, then the configured reranker); `reranked` says which order applied.
export default defineEventHandler(async (event) => {
  const { query, documentId, topK } = await readValidatedBody(event, searchRequestSchema.parse)
  const config = useRuntimeConfig(event)
  if (!config.geminiApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'Query embeddings are not configured (set NUXT_GEMINI_API_KEY).' })
  }
  try {
    return await retrieveSources(serverSupabase(), geminiEmbedder(config.geminiApiKey, 'RETRIEVAL_QUERY'), query, {
      topK, documentId, expander: configuredTaskModel(config, config.expandModel), reranker: configuredReranker(config),
    })
  }
  catch (error) {
    if (!(error instanceof SearchError)) throw error
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: error.message })
  }
})
