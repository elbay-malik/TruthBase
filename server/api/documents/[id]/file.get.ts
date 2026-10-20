import { documentParamsSchema } from '#shared/schemas'
import { DOCUMENTS_BUCKET } from '../../../ingest/store'

// GET /api/documents/:id/file — short-lived signed URL for the PDF in the
// private `documents` bucket. The viewer passes it straight to PDF.js
// (Storage answers with CORS `*` and supports Range; TECH_NOTES §7).
// The URL is a bearer credential for this one object until it expires, so
// it is never cached or logged. It can be downloaded any number of times
// until then, so the TTL is kept short: a little longer than the viewer reuses
// an opened document (MAX_AGE_MS in app/utils/pdf-documents.ts, 10 min), which
// signs again on a reopen or an expired URL. The TTL must stay above that age,
// or a reopen near it could stream ranges from a URL about to expire. Storage
// egress is otherwise bounded only by the per-minute limiter (ADR-0010).

const TTL_SECONDS = 12 * 60

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, documentParamsSchema.parse)
  const supabase = serverSupabase()

  const { data: document, error } = await supabase.from('documents').select('storage_path').eq('id', id).maybeSingle()
  if (error) {
    // Database and Storage error text stays in the server log, not the response.
    console.error('[documents] lookup failed:', error.message)
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'Document lookup failed.' })
  }
  if (!document?.storage_path) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found', message: 'No such document.' })
  }

  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString()
  const signed = await supabase.storage.from(DOCUMENTS_BUCKET).createSignedUrl(document.storage_path, TTL_SECONDS)
  if (signed.error) {
    console.error('[documents] signing the PDF URL failed:', signed.error.message)
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'Signing the PDF URL failed.' })
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { url: signed.data.signedUrl, expiresAt }
})
