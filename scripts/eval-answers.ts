// Golden-set evaluation of retrieval + grounded generation, through the same
// code as POST /api/chat (server/rag/*). Phase 4 baseline; Phase 9 moves the
// metric definitions into promptfoo as a CI gate.
//
//   pnpm eval:answers                     # full run, writes docs/evals/<label>.json
//   pnpm eval:answers --label phase-4 --delay 4000 --only g-020,g-046
//
// Metrics (docs/SPEC.md):
//   recall@k            all evidence spans of a record lie inside retrieved chunks
//                       (same document + page, chunk text contains the span),
//                       for hybrid, dense-only and keyword-only search
//   answer rate         answerable records the model answered (did not refuse)
//   correct citation    answered records citing ≥1 source that contains evidence
//   citation precision  cited sources containing evidence / all cited sources
//                       (a lower bound: other passages can support a claim too)
//   refusal accuracy    unanswerable records answered with NO_ANSWER

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { generateText } from 'ai'
import type { SourceRef } from '../shared/types/chat'
import { geminiEmbedder } from '../server/ingest/embed'
import { chatModel } from '../server/rag/model'
import { buildPrompt, GROUNDING_INSTRUCTIONS, isRefusal, parseCitations } from '../server/rag/prompt'
import { DEFAULT_TOP_K, toSources } from '../server/rag/retrieve'
import { searchChunks, type SearchHit } from '../server/rag/search'

const ROOT = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'phase-4-baseline' },
    delay: { type: 'string', default: '4000' }, // ms between generations (free-tier RPM)
    only: { type: 'string' },
  },
})

interface Evidence { document: string, page: number, text: string }
interface GoldenRecord { id: string, question: string, answer: string | null, evidence: Evidence[], tags: string[] }

const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (run via \`pnpm eval:answers\`, which loads .env)`)
  return value
}

const supabase = createClient(env('NUXT_SUPABASE_URL'), env('NUXT_SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } })
const embed = geminiEmbedder(env('NUXT_GEMINI_API_KEY'), 'RETRIEVAL_QUERY')
const { model, id: modelId, providerOptions } = chatModel({ groqApiKey: process.env.NUXT_GROQ_API_KEY, geminiApiKey: env('NUXT_GEMINI_API_KEY') })

let golden: GoldenRecord[] = JSON.parse(await readFile(join(ROOT, 'docs/golden/golden.json'), 'utf8'))
if (values.only) {
  const ids = new Set(values.only.split(','))
  golden = golden.filter(r => ids.has(r.id))
}

const { data: docs, error } = await supabase.from('documents').select('id, filename')
if (error) throw new Error(error.message)
const filenameById = new Map(docs.map(d => [d.id as string, d.filename as string]))

const contains = (source: { filename: string, pageNumber: number | null, content: string }, e: Evidence) =>
  source.filename === e.document && source.pageNumber === e.page && source.content.includes(e.text)
const asSource = (hit: SearchHit) => ({ filename: filenameById.get(hit.documentId) ?? '', pageNumber: hit.pageNumber, content: hit.content })
/** Rank (1-based) at which every evidence span is covered, or null if not within the list. */
const fullCoverageRank = (hits: SearchHit[], evidence: Evidence[]) => {
  if (evidence.length === 0) return null // unanswerable: nothing to retrieve
  let worst = 0
  for (const e of evidence) {
    const rank = hits.findIndex(h => contains(asSource(h), e)) + 1
    if (rank === 0) return null
    worst = Math.max(worst, rank)
  }
  return worst
}

/** Retries transient failures (network blips to Supabase or the model API). */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    }
    catch (error) {
      if (attempt >= attempts) throw error
      console.log(`  retry ${label} (${attempt}/${attempts - 1}): ${String(error).slice(0, 100)}`)
      await new Promise(r => setTimeout(r, 5000 * attempt))
    }
  }
}

console.log(`model ${modelId} · ${golden.length} questions · top-${DEFAULT_TOP_K} sources`)
const embeddings = await withRetry('embed questions', () => embed(golden.map(r => r.question)))

const results = []
for (const [i, record] of golden.entries()) {
  const search = (fullTextWeight: number, semanticWeight: number) => searchChunks(supabase, {
    queryText: record.question, queryEmbedding: embeddings[i]!, matchCount: 10, fullTextWeight, semanticWeight,
  })
  const [hybrid, dense, keyword] = await withRetry(`${record.id} search`, () => Promise.all([search(1, 1), search(0, 1), search(1, 0)]))
  const sources: SourceRef[] = toSources(hybrid.slice(0, DEFAULT_TOP_K), filenameById)

  const { text } = await withRetry(`${record.id} generate`, () => generateText({
    model,
    instructions: GROUNDING_INSTRUCTIONS,
    prompt: buildPrompt(record.question, sources),
    temperature: 0,
    maxOutputTokens: 700,
    maxRetries: 5,
    providerOptions,
  }))
  const refused = isRefusal(text)
  const cited = refused ? [] : parseCitations(text, sources.length)
  const supporting = cited.filter(n => record.evidence.some(e => contains(sources[n - 1]!, e)))

  const result = {
    id: record.id,
    tags: record.tags,
    answerable: record.answer !== null,
    rank: { hybrid: fullCoverageRank(hybrid, record.evidence), dense: fullCoverageRank(dense, record.evidence), keyword: fullCoverageRank(keyword, record.evidence) },
    refused,
    cited,
    supporting,
    answer: text.trim(),
    sources: sources.map(s => `${s.filename} p.${s.pageNumber}`),
  }
  results.push(result)
  const mark = !result.answerable ? (refused ? 'refused ✓' : 'ANSWERED ✗') : refused ? 'refused' : supporting.length ? 'cited ✓' : cited.length ? 'cited ✗' : 'no cite ✗'
  console.log(`${record.id.padEnd(6)} hybrid rank ${String(result.rank.hybrid ?? '–').padStart(2)}  ${mark}`)
  if (i < golden.length - 1) await new Promise(r => setTimeout(r, Number(values.delay)))
}

// ── aggregate ──────────────────────────────────────────────────────────────
const answerable = results.filter(r => r.answerable)
const unanswerable = results.filter(r => !r.answerable)
const recall = (arm: 'hybrid' | 'dense' | 'keyword', k: number) =>
  answerable.filter(r => r.rank[arm] !== null && r.rank[arm]! <= k).length / answerable.length
const answered = answerable.filter(r => !r.refused)
const allCited = answered.flatMap(r => r.cited.map(n => r.supporting.includes(n)))
const summary = {
  label: values.label,
  model: modelId,
  date: new Date().toISOString().slice(0, 10),
  topK: DEFAULT_TOP_K,
  questions: results.length,
  retrieval: Object.fromEntries((['hybrid', 'dense', 'keyword'] as const).map(arm =>
    [arm, { 'recall@5': recall(arm, 5), 'recall@8': recall(arm, 8), 'recall@10': recall(arm, 10) }])),
  generation: {
    answerRate: answered.length / answerable.length,
    correctCitation: answered.filter(r => r.supporting.length > 0).length / Math.max(1, answered.length),
    correctCitationOverAnswerable: answerable.filter(r => r.supporting.length > 0).length / answerable.length,
    citationPrecision: allCited.filter(Boolean).length / Math.max(1, allCited.length),
    answeredWithoutCitation: answered.filter(r => r.cited.length === 0).length,
    refusalAccuracy: unanswerable.filter(r => r.refused).length / Math.max(1, unanswerable.length),
    // Refusing because retrieval missed the evidence is the grounded behaviour.
    refusedWithEvidenceRetrieved: answerable.filter(r => r.refused && r.rank.hybrid !== null && r.rank.hybrid <= DEFAULT_TOP_K).length,
    refusedWithEvidenceMissing: answerable.filter(r => r.refused && (r.rank.hybrid === null || r.rank.hybrid > DEFAULT_TOP_K)).length,
  },
}

const pct = (x: number) => `${(100 * x).toFixed(0)}%`
console.log('\nretrieval recall (answerable, all evidence spans):')
for (const arm of ['hybrid', 'dense', 'keyword'] as const) {
  const r = summary.retrieval[arm]!
  console.log(`  ${arm.padEnd(8)} @5 ${pct(r['recall@5']!)}  @8 ${pct(r['recall@8']!)}  @10 ${pct(r['recall@10']!)}`)
}
const g = summary.generation
console.log(`generation: answered ${pct(g.answerRate)} of answerable · ≥1 correct citation ${pct(g.correctCitation)} of answered (${pct(g.correctCitationOverAnswerable)} of answerable)`)
console.log(`            citation precision ${pct(g.citationPrecision)} · answered without citation ${g.answeredWithoutCitation} · refusal accuracy ${pct(g.refusalAccuracy)} (${unanswerable.filter(r => r.refused).length}/${unanswerable.length})`)
console.log(`            refusals on answerable: ${g.refusedWithEvidenceMissing} with evidence not retrieved (grounded), ${g.refusedWithEvidenceRetrieved} with evidence retrieved`)

if (!values.only) {
  const out = join(ROOT, 'docs/evals', `${values.label}.json`)
  await mkdir(join(ROOT, 'docs/evals'), { recursive: true })
  await writeFile(out, `${JSON.stringify({ summary, results }, null, 1)}\n`)
  console.log(`\n→ ${out}`)
}
