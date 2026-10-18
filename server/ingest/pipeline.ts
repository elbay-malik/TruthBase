import { chunkPage, DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from './chunk'
import type { Embedder } from './embed'
import { extractPages } from './extract'
import type { PdfAssetReader } from './pdf-assets'
import { chunkHighlight } from './highlight'
import type { ChunkInsert, DocumentInsert } from './store'

// Phase 3 orchestration: parse → chunk → embed → store, reporting progress per
// stage (the stage names match the UI and, in Phase 10, the trace spans).
// Dependencies are injected so the pipeline runs in the Nitro route, the CLI
// seeding script, and tests alike.

export type IngestStage = 'parse' | 'chunk' | 'embed' | 'store'

export interface IngestProgress {
  stage: IngestStage
  done: number
  total: number
}

export interface IngestDeps {
  embed: Embedder
  /** Must roll back and throw when `signal` aborts mid-store. */
  store: (document: DocumentInsert, pdf: Uint8Array, chunks: ChunkInsert[], onBatch: (stored: number) => void, signal?: AbortSignal) => Promise<void>
  onProgress?: (progress: IngestProgress) => void
  chunkOptions?: ChunkOptions
  /** Texts per embedding request. */
  embedBatchSize?: number
  /** PDF.js CMap / standard-font files (default: from node_modules). */
  assets?: PdfAssetReader
  /**
   * Aborts between stages and embedding batches (client disconnected), so an
   * abandoned upload stops spending embedding quota and is never stored.
   */
  signal?: AbortSignal
}

export interface IngestResult {
  documentId: string
  pageCount: number
  chunkCount: number
}

export class IngestError extends Error {
  constructor(message: string, readonly stage: IngestStage) {
    super(message)
  }
}

export async function ingestPdf(pdf: Uint8Array, filename: string, deps: IngestDeps): Promise<IngestResult> {
  const report = deps.onProgress ?? (() => {})
  const batchSize = deps.embedBatchSize ?? 50

  const checkAborted = (stage: IngestStage) => {
    if (deps.signal?.aborted) throw new IngestError('Ingestion cancelled.', stage)
  }

  // unpdf hands the buffer to a PDF.js worker that may detach it; keep ours.
  const pages = await extractPages(pdf.slice(), { assets: deps.assets })
  report({ stage: 'parse', done: pages.length, total: pages.length })
  if (pages.every(page => page.text.length === 0)) {
    throw new IngestError('No text layer found — scanned PDFs are not supported.', 'parse')
  }

  const chunks = pages.flatMap(page =>
    chunkPage(page.text, deps.chunkOptions ?? DEFAULT_CHUNK_OPTIONS).map(span => ({
      pageNumber: page.pageNumber,
      content: page.text.slice(span.start, span.end),
      highlight: chunkHighlight(page, span),
    })),
  )
  report({ stage: 'chunk', done: chunks.length, total: chunks.length })

  const embeddings: number[][] = []
  for (let i = 0; i < chunks.length; i += batchSize) {
    checkAborted('embed')
    const batch = chunks.slice(i, i + batchSize)
    const vectors = await deps.embed(batch.map(chunk => chunk.content))
    if (vectors.length !== batch.length) throw new IngestError('embedding count mismatch', 'embed')
    embeddings.push(...vectors)
    report({ stage: 'embed', done: embeddings.length, total: chunks.length })
  }

  checkAborted('store')
  const document: DocumentInsert = { id: crypto.randomUUID(), filename, pageCount: pages.length }
  await deps.store(
    document,
    pdf,
    chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i]! })),
    stored => report({ stage: 'store', done: stored, total: chunks.length }),
    deps.signal,
  ).catch((error: unknown) => {
    // The store rolled back; report the abort like the earlier stages do.
    if (deps.signal?.aborted) throw new IngestError('Ingestion cancelled.', 'store')
    throw error
  })

  return { documentId: document.id, pageCount: pages.length, chunkCount: chunks.length }
}
