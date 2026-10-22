import { documentParamsSchema } from '#shared/schemas'
import { DOCUMENTS_BUCKET } from '../../../ingest/store'

// GET /api/documents/:id/file — where the viewer loads the PDF from. The
// public corpus is a static file on this origin (server/utils/static-pdfs.ts),
// so opening it costs no Storage egress. Any other document gets a
// short-lived signed URL for the private `documents` bucket, which the viewer
// passes straight to PDF.js (Storage answers with CORS `*` and supports Range;
// TECH_NOTES §7).
// A signed URL is a bearer credential for this one object until it expires, so
// it is never cached or logged. It can be downloaded any number of times
// until then, so the TTL is kept short: a little longer than the viewer reuses
// an opened document (MAX_AGE_MS in app/utils/pdf-documents.ts, 10 min), which
// signs again on a reopen or an expired URL. The TTL must stay above that age,
// or a reopen near it could stream ranges from a URL about to expire.

const TTL_SECONDS = 12 * 60

// A document's filename and storage path never change once ingested, so they
// are looked up once per server process: a sign then needs one Supabase round
// trip, not two. Only found documents are kept (a 404 may be ingested later);
// the corpus is a handful of documents, and the cap only guards against
// unbounded growth.
const MAX_DOCUMENTS = 1000
const documents = new Map<string, { filename: string, storagePath: string }>()

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, documentParamsSchema.parse)
  const supabase = serverSupabase()

  let document = documents.get(id)
  if (!document) {
    const { data, error } = await supabase.from('documents').select('filename, storage_path').eq('id', id).maybeSingle()
    if (error) {
      // Database and Storage error text stays in the server log, not the response.
      console.error('[documents] lookup failed:', error.message)
      throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'Document lookup failed.' })
    }
    if (!data?.storage_path) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found', message: 'No such document.' })
    }
    document = { filename: data.filename as string, storagePath: data.storage_path as string }
    if (documents.size < MAX_DOCUMENTS) documents.set(id, document)
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  const url = staticPdfUrl(document.filename)
  if (url) return { url }

  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString()
  const signed = await supabase.storage.from(DOCUMENTS_BUCKET).createSignedUrl(document.storagePath, TTL_SECONDS)
  if (signed.error) {
    console.error('[documents] signing the PDF URL failed:', signed.error.message)
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'Signing the PDF URL failed.' })
  }
  return { url: signed.data.signedUrl, expiresAt }
})
