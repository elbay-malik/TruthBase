// Seeds the demo workspace: ingests the golden PDFs (docs/golden/pdfs) into the
// Supabase project from .env, through the same pipeline as POST /api/ingest.
//
//   pnpm ingest:golden               # skips PDFs already ingested (by filename)
//   pnpm ingest:golden --replace     # re-ingests them, then deletes the old copies
//   pnpm ingest:golden --highlights-only
//                                    # recomputes stored highlight rects from each
//                                    # chunk's offsets (after highlight-math changes;
//                                    # no re-embedding, text must be unchanged)
//
// Needs NUXT_SUPABASE_URL, NUXT_SUPABASE_SERVICE_KEY and NUXT_GEMINI_API_KEY.

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { geminiEmbedder } from '../server/ingest/embed'
import { extractPages } from '../server/ingest/extract'
import { chunkHighlight } from '../server/ingest/highlight'
import { ingestPdf } from '../server/ingest/pipeline'
import { DOCUMENTS_BUCKET, storeDocument } from '../server/ingest/store'

const PDFS = resolve(import.meta.dirname, '../docs/golden/pdfs')
const { values } = parseArgs({ options: { 'replace': { type: 'boolean', default: false }, 'highlights-only': { type: 'boolean', default: false } } })

const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (run via \`pnpm ingest:golden\`, which loads .env)`)
  return value
}

const supabase = createClient(env('NUXT_SUPABASE_URL'), env('NUXT_SUPABASE_SERVICE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

if (values['highlights-only']) {
  await refreshHighlights()
  process.exit(0)
}

// Ctrl+C aborts the current PDF so the store rolls back instead of leaving a
// partial document (which a later run would skip); a second Ctrl+C exits.
const abort = new AbortController()
process.on('SIGINT', () => {
  if (abort.signal.aborted) process.exit(130)
  console.log('\ncancelling (Ctrl+C again to exit now)…')
  abort.abort()
})
const embed = geminiEmbedder(env('NUXT_GEMINI_API_KEY'), 'RETRIEVAL_DOCUMENT', abort.signal)

for (const filename of (await readdir(PDFS)).filter(f => f.endsWith('.pdf')).sort()) {
  const { data: existing, error } = await supabase.from('documents').select('id, storage_path').eq('filename', filename)
  if (error) throw new Error(`lookup failed: ${error.message}`)
  if (existing.length > 0 && !values.replace) {
    console.log(`skip     ${filename} (already ingested)`)
    continue
  }

  // Ingest first, so a failure (e.g. embedding quota) keeps the old copy.
  const started = Date.now()
  const result = await ingestPdf(new Uint8Array(await readFile(join(PDFS, filename))), filename, {
    embed,
    store: (document, pdf, chunks, onBatch, signal) => storeDocument(supabase, document, pdf, chunks, onBatch, signal),
    onProgress: p => process.stdout.write(`\r${p.stage.padEnd(8)} ${filename} ${p.done}/${p.total}   `),
    signal: abort.signal,
  })
  console.log(`\rdone     ${filename}: ${result.pageCount} pages, ${result.chunkCount} chunks in ${((Date.now() - started) / 1000).toFixed(1)}s → ${result.documentId}`)

  for (const doc of existing) {
    const removed = await supabase.from('documents').delete().eq('id', doc.id)
    if (removed.error) throw new Error(`${filename}: old copy ${doc.id} not deleted (now duplicated): ${removed.error.message}`)
    if (!doc.storage_path) continue
    const unlinked = await supabase.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path])
    if (unlinked.error) console.error(`${filename}: ${DOCUMENTS_BUCKET}/${doc.storage_path} not removed: ${unlinked.error.message}`)
  }
  if (existing.length > 0) console.log(`replaced ${filename}: deleted ${existing.length} old cop${existing.length === 1 ? 'y' : 'ies'}`)
}

async function refreshHighlights() {
  for (const filename of (await readdir(PDFS)).filter(f => f.endsWith('.pdf')).sort()) {
    // filename is not unique (no constraint; uploads can repeat it): refresh every copy.
    const { data: docs, error } = await supabase.from('documents').select('id').eq('filename', filename)
    if (error) throw new Error(`lookup failed: ${error.message}`)
    if (docs.length === 0) {
      console.log(`skip     ${filename} (not ingested)`)
      continue
    }
    const pages = await extractPages(new Uint8Array(await readFile(join(PDFS, filename))))
    for (const doc of docs) {
      const { data: chunks, error: chunksError } = await supabase.from('chunks')
        .select('id, page_number, content, highlight').eq('document_id', doc.id)
      if (chunksError) throw new Error(`chunk read failed: ${chunksError.message}`)

      // Validate every chunk before writing any, so a mismatch leaves the document untouched.
      const updates = chunks.map((chunk) => {
        const page = pages[chunk.page_number - 1]
        const { startOffset: start, endOffset: end } = chunk.highlight as { startOffset: number, endOffset: number }
        if (!page || page.text.slice(start, end) !== chunk.content) {
          throw new Error(`${filename} (${doc.id}) chunk ${chunk.id}: stored text no longer matches page ${chunk.page_number} — re-ingest with --replace`)
        }
        return { id: chunk.id, highlight: chunkHighlight(page, { start, end }) }
      })
      for (const { id, highlight } of updates) {
        const { error: updateError } = await supabase.from('chunks').update({ highlight }).eq('id', id)
        if (updateError) throw new Error(`update failed for ${id}: ${updateError.message}`)
      }
      console.log(`updated  ${filename} (${doc.id}): ${updates.length} chunk highlights`)
    }
  }
}
