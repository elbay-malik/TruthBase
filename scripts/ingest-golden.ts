// Seeds the demo workspace: ingests the golden PDFs (docs/golden/pdfs) into the
// Supabase project from .env, through the same pipeline as POST /api/ingest.
//
//   pnpm ingest:golden               # skips PDFs already ingested (by filename)
//   pnpm ingest:golden --replace     # deletes and re-ingests them
//
// Needs NUXT_SUPABASE_URL, NUXT_SUPABASE_SERVICE_KEY and NUXT_GEMINI_API_KEY.

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { geminiEmbedder } from '../server/ingest/embed'
import { ingestPdf } from '../server/ingest/pipeline'
import { DOCUMENTS_BUCKET, storeDocument } from '../server/ingest/store'

const PDFS = resolve(import.meta.dirname, '../docs/golden/pdfs')
const { values } = parseArgs({ options: { replace: { type: 'boolean', default: false } } })

const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (run via \`pnpm ingest:golden\`, which loads .env)`)
  return value
}

const supabase = createClient(env('NUXT_SUPABASE_URL'), env('NUXT_SUPABASE_SERVICE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
const embed = geminiEmbedder(env('NUXT_GEMINI_API_KEY'), 'RETRIEVAL_DOCUMENT')

for (const filename of (await readdir(PDFS)).filter(f => f.endsWith('.pdf')).sort()) {
  const { data: existing, error } = await supabase.from('documents').select('id, storage_path').eq('filename', filename)
  if (error) throw new Error(`lookup failed: ${error.message}`)
  if (existing.length > 0 && !values.replace) {
    console.log(`skip     ${filename} (already ingested)`)
    continue
  }
  for (const doc of existing) {
    await supabase.from('documents').delete().eq('id', doc.id)
    if (doc.storage_path) await supabase.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path])
  }

  const started = Date.now()
  const result = await ingestPdf(new Uint8Array(await readFile(join(PDFS, filename))), filename, {
    embed,
    store: (document, pdf, chunks, onBatch) => storeDocument(supabase, document, pdf, chunks, onBatch),
    onProgress: p => process.stdout.write(`\r${p.stage.padEnd(8)} ${filename} ${p.done}/${p.total}   `),
  })
  console.log(`\rdone     ${filename}: ${result.pageCount} pages, ${result.chunkCount} chunks in ${((Date.now() - started) / 1000).toFixed(1)}s → ${result.documentId}`)
}
