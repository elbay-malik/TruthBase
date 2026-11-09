import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChunkHighlight } from '#shared/types'

// Phase 3, step 5: persist a document, its PDF and its chunks.
// Works with any service-role client (Nitro route or CLI script).

export const DOCUMENTS_BUCKET = 'documents'
const INSERT_BATCH = 100
const ROLLBACK_ATTEMPTS = 3

export interface DocumentInsert {
  id: string
  filename: string
  pageCount: number
}

export interface ChunkInsert {
  pageNumber: number
  content: string
  /** The opening of the over-long run this chunk continues, or '' (chunk.ts `context`). */
  context: string
  embedding: number[]
  highlight: ChunkHighlight
}

/**
 * Uploads the PDF, then inserts the document row and its chunks. Chunk inserts
 * span several requests, so on any failure the document row is deleted
 * (chunks cascade) and the upload removed, each retried a few times.
 * `signal` (client gone) is checked after the upload and before each insert;
 * an abort rolls back like any other failure.
 *
 * Known gaps, until a `status` column hides unfinished documents from
 * listing and search (bring-your-own-docs uploads, Phase 11b): the document
 * row is visible (GET /api/documents) while its chunk batches are inserted,
 * and a rollback that keeps failing, or a process killed mid-store, leaves a
 * partial document behind. Both are logged as `[ingest] rollback:` errors
 * except the kill; re-ingest with `pnpm ingest:golden --replace` or delete the
 * row. Uploads are operator-only today.
 */
export async function storeDocument(
  supabase: SupabaseClient,
  document: DocumentInsert,
  pdf: Uint8Array,
  chunks: ChunkInsert[],
  onBatch?: (stored: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const storagePath = `${document.id}.pdf`
  const upload = await supabase.storage.from(DOCUMENTS_BUCKET)
    .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: false })
  if (upload.error) {
    // The object may exist even so (e.g. a gateway timeout after the write).
    await removeUpload(supabase, storagePath)
    throw new Error(`PDF upload failed: ${upload.error.message}`)
  }

  try {
    signal?.throwIfAborted()
    const inserted = await supabase.from('documents').insert({
      id: document.id,
      filename: document.filename,
      storage_path: storagePath,
      page_count: document.pageCount,
    })
    if (inserted.error) throw new Error(`document insert failed: ${inserted.error.message}`)

    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      signal?.throwIfAborted()
      const batch = chunks.slice(i, i + INSERT_BATCH).map(chunk => ({
        document_id: document.id,
        page_number: chunk.pageNumber,
        content: chunk.content,
        context: chunk.context,
        embedding_bge_m3: chunk.embedding, // JSON array → pgvector input; don't stringify
        highlight: chunk.highlight,
      }))
      const { error } = await supabase.from('chunks').insert(batch)
      if (error) throw new Error(`chunk insert failed at ${i}: ${error.message}`)
      onBatch?.(Math.min(i + INSERT_BATCH, chunks.length))
    }
  }
  catch (error) {
    // supabase-js reports failures as `{ error }` instead of throwing: check the
    // compensating steps, log what is left behind, and keep the original error.
    const removed = await retry(async () => (await supabase.from('documents').delete().eq('id', document.id)).error)
    if (removed) console.error(`[ingest] rollback: PARTIAL document ${document.id} "${document.filename}" (and its chunks) not deleted: ${removed.message}`)
    await removeUpload(supabase, storagePath)
    throw error
  }
}

async function removeUpload(supabase: SupabaseClient, storagePath: string) {
  const failed = await retry(async () => (await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath])).error)
  if (failed) console.error(`[ingest] rollback: ${DOCUMENTS_BUCKET}/${storagePath} not removed: ${failed.message}`)
}

/** Runs `step` until it reports no error; returns the last error, if any. */
async function retry(step: () => Promise<{ message: string } | null>): Promise<{ message: string } | null> {
  let error: { message: string } | null = null
  for (let attempt = 0; attempt < ROLLBACK_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 250 * attempt))
    error = await step().catch((thrown: unknown) => ({ message: String(thrown) }))
    if (!error) return null
  }
  return error
}
