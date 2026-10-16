import { createHash, timingSafeEqual } from 'node:crypto'
import { geminiEmbedder } from '../ingest/embed'
import { IngestError, ingestPdf, type IngestProgress } from '../ingest/pipeline'
import { storeDocument } from '../ingest/store'

// POST /api/ingest — multipart `file` (PDF) → parse → chunk → embed → store,
// streaming progress as Server-Sent Events:
//   event: progress  data: { stage, done, total }
//   event: done      data: { documentId, pageCount, chunkCount }
//   event: error     data: { message, stage? }
// Validation failures are plain JSON errors sent before the stream opens.
//
// Ingestion spends embedding quota and storage, so until Phase 11 adds
// bring-your-own-docs auth it is operator-only: `Authorization: Bearer
// <NUXT_INGEST_TOKEN>`, and disabled entirely when no token is configured.

const MAX_PDF_BYTES = 20 * 1024 * 1024 // matches the `documents` bucket limit

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  requireIngestToken(getHeader(event, 'authorization'), config.ingestToken)
  if (!config.geminiApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'Embeddings are not configured (set NUXT_GEMINI_API_KEY).' })
  }

  const file = (await readMultipartFormData(event))?.find(part => part.name === 'file')
  if (!file?.filename || !file.data.length) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'Send the PDF as multipart field "file".' })
  }
  if (file.data.length > MAX_PDF_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: 'PDFs are limited to 20 MB.' })
  }
  if (file.data.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw createError({ statusCode: 415, statusMessage: 'Unsupported Media Type', message: 'Only PDF files can be ingested.' })
  }

  const stream = createEventStream(event)
  const send = (name: string, data: unknown) => stream.push({ event: name, data: JSON.stringify(data) })
  const supabase = serverSupabase()

  ingestPdf(new Uint8Array(file.data), file.filename, {
    embed: geminiEmbedder(config.geminiApiKey, 'RETRIEVAL_DOCUMENT'),
    store: (document, pdf, chunks, onBatch) => storeDocument(supabase, document, pdf, chunks, onBatch),
    onProgress: (progress: IngestProgress) => void send('progress', progress),
  })
    .then(result => send('done', result))
    .catch((error: unknown) => {
      console.error('[ingest]', error)
      const stage = error instanceof IngestError ? error.stage : undefined
      // IngestError messages are written for users; anything else stays in the log.
      const message = error instanceof IngestError ? error.message : 'Ingestion failed.'
      return send('error', { message, stage })
    })
    .finally(() => stream.close())

  return stream.send()
})

function requireIngestToken(header: string | undefined, token: string) {
  if (!token) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'Ingestion is disabled (set NUXT_INGEST_TOKEN).' })
  }
  // Hash both sides so timingSafeEqual compares equal-length buffers.
  const digest = (value: string) => createHash('sha256').update(value).digest()
  if (!header?.startsWith('Bearer ') || !timingSafeEqual(digest(header.slice(7)), digest(token))) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: 'A valid ingest token is required.' })
  }
}
