import { documentParamsSchema } from '#shared/schemas'
import { DOCUMENTS_BUCKET } from '../../../ingest/store'

// GET /api/documents/:id/file — short-lived signed URL for the PDF in the
// private `documents` bucket. The viewer passes it straight to PDF.js
// (Storage answers with CORS `*` and supports Range; TECH_NOTES §7).
// The URL is a bearer credential for this one object until it expires, so
// it is never cached or logged.

const TTL_SECONDS = 15 * 60 // covers a viewing session, incl. streamed loading

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, documentParamsSchema.parse)
  const supabase = serverSupabase()

  const { data: document, error } = await supabase.from('documents').select('storage_path').eq('id', id).maybeSingle()
  if (error) {
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: `Document lookup failed: ${error.message}` })
  }
  if (!document?.storage_path) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found', message: 'No such document.' })
  }

  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString()
  const signed = await supabase.storage.from(DOCUMENTS_BUCKET).createSignedUrl(document.storage_path, TTL_SECONDS)
  if (signed.error) {
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: `Signing the PDF URL failed: ${signed.error.message}` })
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { url: signed.data.signedUrl, expiresAt }
})
