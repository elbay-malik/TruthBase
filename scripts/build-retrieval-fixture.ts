// Phase 9: export the hosted corpus and the golden questions' embeddings to
// test/fixtures/retrieval-corpus.json.gz for the offline retrieval gate
// (scripts/eval-retrieval.ts, ADR-0008).
//
//   pnpm fixtures:retrieval
//
// Re-run after re-ingesting the corpus or editing golden questions, then
// `pnpm eval:retrieval --install --update-baseline` and commit both files:
// the PR diff then shows how the change moved the metrics.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { EMBEDDING_MODEL } from '../server/ingest/embed'
import { queryEmbeddings, ROOT, type GoldenRecord } from './lib/golden'
import { encodeVector, FIXTURE_FILE, writeFixture, type Fixture } from './lib/retrieval-fixture'

const env = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set (run via pnpm fixtures:retrieval, which loads .env)`) })()
const supabase = createClient(env('NUXT_SUPABASE_URL'), env('NUXT_SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } })

const documents = await supabase.from('documents').select('id, filename, page_count').order('id')
if (documents.error) throw new Error(documents.error.message)

const chunks: Fixture['chunks'] = []
for (let from = 0; ; from += 500) {
  const page = await supabase.from('chunks').select('id, document_id, page_number, content, context, embedding:embedding_bge_m3').order('id').range(from, from + 499)
  if (page.error) throw new Error(page.error.message)
  // embedding arrives as pgvector text ('[0.1,…]').
  chunks.push(...page.data.map(c => ({ ...c, embedding: encodeVector(JSON.parse(c.embedding as string)) })))
  if (page.data.length < 500) break
}

// All golden questions, answerable or not: the gate measures the former, the
// LLM eval (promptfoo) can retrieve for all of them offline.
const golden: GoldenRecord[] = JSON.parse(await readFile(join(ROOT, 'docs/golden/golden.json'), 'utf8'))
const questions = golden.map(r => r.question)
const vectors = await (await queryEmbeddings({ cloudflareAccountId: env('NUXT_CLOUDFLARE_ACCOUNT_ID'), cloudflareApiToken: env('NUXT_CLOUDFLARE_API_TOKEN') }))(questions)

await writeFixture({
  exportedAt: new Date().toISOString(),
  embeddingModel: EMBEDDING_MODEL,
  documents: documents.data,
  chunks,
  queries: Object.fromEntries(questions.map((q, i) => [q, encodeVector(vectors[i]!)])),
})
console.log(`wrote ${FIXTURE_FILE}: ${documents.data.length} documents, ${chunks.length} chunks, ${questions.length} queries`)
