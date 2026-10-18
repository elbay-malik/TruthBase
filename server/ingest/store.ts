import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChunkHighlight } from '#shared/types'

// Phase 3, step 5: persist a document, its PDF and its chunks.
// Works with any service-role client (Nitro route or CLI script).

export const DOCUMENTS_BUCKET = 'documents'
const INSERT_BATCH = 100

export interface DocumentInsert {
  id: string
  filename: string
  pageCount: number
}

export interface ChunkInsert {
  pageNumber: number
  content: string
  embedding: number[]
  highlight: ChunkHighlight
}

/**
 * Uploads the PDF, then inserts the document row and its chunks. Chunk inserts
 * span several requests, so on any failure the document row is deleted
 * (chunks cascade) and the upload removed — no half-ingested documents.
 * `signal` (client gone) is checked after the upload and before each insert;
 * an abort rolls back like any other failure.
 *
 * Known gap: the document row is visible (GET /api/documents) while its chunk
 * batches are still being inserted. Uploads are operator-only today; a
 * `status` column filtering listing/search lands with Phase 11's
 * bring-your-own-docs uploads.
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
  if (upload.error) throw new Error(`PDF upload failed: ${upload.error.message}`)

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
        embedding: chunk.embedding, // JSON array → pgvector input; don't stringify
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
    const removed = await supabase.from('documents').delete().eq('id', document.id)
    if (removed.error) console.error(`[ingest] rollback: document ${document.id} (and its chunks) not deleted: ${removed.error.message}`)
    const unlinked = await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath])
    if (unlinked.error) console.error(`[ingest] rollback: ${DOCUMENTS_BUCKET}/${storagePath} not removed: ${unlinked.error.message}`)
    throw error
  }
}
