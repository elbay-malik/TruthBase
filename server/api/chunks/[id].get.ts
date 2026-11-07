import { documentParamsSchema } from '#shared/schemas'
import type { SourceRef } from '#shared/types/chat'

// GET /api/chunks/:id — one chunk with its document and stored highlight, for
// citation deep links (/?chunk=<id>) and the Phase 5 viewer check. Public demo
// data; explicit columns only (never the embedding or tsvector).
// Cached for a day, in the function and on Vercel's CDN (s-maxage): every miss
// is Supabase egress, and chunks change only through operator ingestion. Keyed
// by id alone, so a query string cannot add entries. The id must be the
// canonical lower-case uuid (documentParamsSchema), so one chunk has one key;
// any other spelling is a 400 before the database. A thrown error is not
// cached, so rejected and unknown ids cannot fill the cache either.
export default defineCachedEventHandler(async (event): Promise<SourceRef> => {
  const { id } = await getValidatedRouterParams(event, documentParamsSchema.parse)
  const { data, error } = await serverSupabase()
    .from('chunks')
    .select('id, document_id, page_number, content, highlight, documents(filename)')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    // The database's error text stays in the server log, not the response.
    console.error('[chunks] lookup failed:', error.message)
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'Chunk lookup failed.' })
  }
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found', message: 'No such chunk.' })
  }
  const document = data.documents as unknown as { filename: string } | null
  return {
    index: 1,
    chunkId: data.id as string,
    documentId: data.document_id as string,
    filename: document?.filename ?? 'unknown document',
    pageNumber: data.page_number as number | null,
    content: data.content as string,
    highlight: data.highlight as SourceRef['highlight'],
  }
}, {
  name: 'chunks',
  getKey: event => getRouterParam(event, 'id') ?? '',
  maxAge: 24 * 60 * 60,
  swr: true,
})
