import { createHash, timingSafeEqual } from 'node:crypto'
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing'
import { geminiEmbedder } from '../ingest/embed'
import { IngestError, ingestPdf, type IngestProgress } from '../ingest/pipeline'
import { storeDocument } from '../ingest/store'
import { clearCatalogCache } from '../rag/catalog'

// POST /api/ingest — multipart `file` (PDF) → parse → chunk → embed → store,
// streaming progress as Server-Sent Events:
//   event: progress  data: { stage, done, total }
//   event: done      data: { documentId, pageCount, chunkCount }
//   event: error     data: { message, stage? }
// Validation failures are plain JSON errors sent before the stream opens.
// On Vercel, bodies over 4.5 MB never reach the route (ADR-0011): a larger
// declared length gets a 413 that says so, and the corpus is ingested with
// the CLI (pnpm ingest:golden) instead.
//
// Ingestion spends embedding quota and storage, so until Phase 11 adds
// bring-your-own-docs auth it is operator-only: `Authorization: Bearer
// <NUXT_INGEST_TOKEN>`, and disabled entirely when no token is configured.
//
// Traced (Phase 10) as an `ingest` trace: file, outcome and failing stage,
// with each embedding batch nested as an AI SDK observation.

const MAX_PDF_BYTES = 20 * 1024 * 1024 // matches the `documents` bucket limit

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  // Everything before readMultipartFormData must not touch the body: an
  // anonymous request is rejected on headers alone (token, declared length).
  // Nitro parses env overrides, so a numeric-looking token arrives as a number.
  requireIngestToken(getHeader(event, 'authorization'), String(config.ingestToken ?? ''))
  const declaredLength = Number(getHeader(event, 'content-length'))
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    // Chunked bodies would bypass the size limiter, which reads Content-Length.
    throw createError({ statusCode: 411, statusMessage: 'Length Required', message: 'Send the upload with a Content-Length header.' })
  }
  const limit = uploadLimit(onVercel(), MAX_PDF_BYTES)
  if (declaredLength > limit.maxRequestBytes) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: limit.message })
  }
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
  // The body is consumed, so a client that goes away shows up as the response
  // closing early: stop spending embedding quota and never store the document.
  const abort = new AbortController()
  event.node.res.on('close', () => {
    if (!event.node.res.writableFinished) abort.abort()
  })

  const filename = file.filename
  void propagateAttributes({ traceName: 'ingest', tags: ['ingest'] }, () => startActiveObservation('ingest', async (observation) => {
    observation.update({ input: { filename, bytes: file.data.length } })
    try {
      const result = await ingestPdf(new Uint8Array(file.data), filename, {
        embed: geminiEmbedder(config.geminiApiKey, 'RETRIEVAL_DOCUMENT', abort.signal),
        store: (document, pdf, chunks, onBatch, signal) => storeDocument(supabase, document, pdf, chunks, onBatch, signal),
        onProgress: (progress: IngestProgress) => void send('progress', progress),
        assets: nitroPdfAssets(),
        signal: abort.signal,
      })
      observation.update({ output: result })
      await send('done', result)
    }
    catch (error: unknown) {
      console.error('[ingest]', error)
      const stage = error instanceof IngestError ? error.stage : undefined
      const detail = error instanceof IngestError && error.cause !== undefined ? error.cause : error
      observation.update({ level: abort.signal.aborted ? 'WARNING' : 'ERROR', statusMessage: `${stage ?? 'unknown stage'}: ${String(detail).slice(0, 300)}` })
      // IngestError messages are written for users; anything else stays in the log.
      const message = error instanceof IngestError ? error.message : 'Ingestion failed.'
      await send('error', { message, stage })
    }
    finally {
      // New or rolled-back documents change the catalog query expansion reads.
      clearCatalogCache()
      await stream.close()
    }
  }, { asType: 'chain' }))

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
