import { searchRequestSchema } from '#shared/schemas'

// The DB layer is ready: the `hybrid_search` RRF RPC (supabase/migrations) and
// the `hybridSearch()` helper (server/utils/retrieval.ts) are wired. This route
// goes live once query embeddings exist (Phase 4 adds Gemini), which the
// semantic arm needs. Until then it validates and returns a clean 501.
export default defineEventHandler(async (event) => {
  await readValidatedBody(event, searchRequestSchema.parse)

  throw createError({
    statusCode: 501,
    statusMessage: 'Not Implemented',
    message: 'Search goes live in Phase 4, once queries are embedded for the semantic arm.',
  })
})
