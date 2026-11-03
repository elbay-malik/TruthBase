// Phase 7: does listwise LLM reranking improve the top of the list? (ADR-0007)
//
// For every answerable golden record: the fused top-N from the hosted
// `hybrid_search_bge_m3` (as the chat route retrieves it) → one rerank call → metrics
// on the fused and the reranked order of the same candidates.
//
//   pnpm eval:rerank --model groq-20b                 # 45 records, all documents
//   pnpm eval:rerank --model groq-20b --filtered      # + document-filtered runs
//   pnpm eval:rerank --model gemini --tpm 0 --label gemini
//
// Rankings are cached in .cache/rerank/ by (model, prompt), so re-runs and
// metric changes cost nothing; latency is taken from the uncached calls.
// Calls are paced to --tpm tokens/min. Groq's free tier meters 8K tokens/min
// AND 200K tokens/day per model: a 45-record run is ~135K, so a spent daily
// quota stops the run (re-run later; finished rankings stay cached).
//
// Metrics (docs/SPEC.md, same evidence matching as scripts/eval-answers.ts):
//   recall@k   all evidence spans of a record lie in the top k
//   MRR        1 / the rank at which all spans are covered
//   nDCG@5     binary relevance (a chunk is relevant if it contains any
//              evidence span); the ideal ranking puts every relevant
//              candidate first, so all orders share one ideal.
//
// Three orders of the same candidates: fused, reranked (the model's full
// order) and shipped (the reranked top RERANK_HEAD, then fused order: what
// the chat route uses).

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { taskModel, type TaskModelChoice } from '../server/rag/model'
import { blendRanking, RERANK_CANDIDATES, RERANK_HEAD } from '../server/rag/rerank'
import { searchChunks, type SearchHit } from '../server/rag/search'
import { answerableRecords, documentMaps, metrics, pct, queryEmbeddings, ROOT, summarize, type Evidence } from './lib/golden'
import { rankingCache } from './lib/ranking-cache'

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'groq-20b' },
    candidates: { type: 'string', default: String(RERANK_CANDIDATES) },
    head: { type: 'string', default: String(RERANK_HEAD) },
    filtered: { type: 'boolean', default: false },
    /** Pace uncached calls to this many tokens per minute (0 = no pacing). */
    tpm: { type: 'string', default: '7500' },
    label: { type: 'string' },
    only: { type: 'string' },
  },
})
const choice = values.model as TaskModelChoice
const candidates = Number(values.candidates)
const tpm = Number(values.tpm)

const env = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set (run via pnpm eval:rerank, which loads .env)`) })()
const supabase = createClient(env('NUXT_SUPABASE_URL'), env('NUXT_SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } })
const rm = taskModel({ groqApiKey: process.env.NUXT_GROQ_API_KEY, geminiApiKey: process.env.NUXT_GEMINI_API_KEY }, choice)
if (!rm) throw new Error(`--model ${choice} is not configured (missing API key) or unknown`)

const golden = await answerableRecords(values.only)
const { filenameById, idByFilename } = await documentMaps(supabase)
const embed = await queryEmbeddings({ cloudflareAccountId: process.env.NUXT_CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: process.env.NUXT_CLOUDFLARE_API_TOKEN })
const embeddings = Object.fromEntries((await embed(golden.map(r => r.question))).map((v, i) => [golden[i]!.question, v]))

// ── metrics (scripts/lib/golden.ts) ──────────────────────────────────────
const { coverageRank, ndcgAt } = metrics(idByFilename)
const scores = (hits: SearchHit[], evidence: Evidence[]) => ({ rank: coverageRank(hits, evidence), ndcg5: ndcgAt(5, hits, evidence) })

// ── rerank calls (cached, paced: scripts/lib/ranking-cache.ts) ──────────
const cachedRanking = await rankingCache(rm, filenameById, tpm)

// ── run ──────────────────────────────────────────────────────────────────
interface Row {
  id: string
  tags: string[]
  filtered: boolean
  fused: ReturnType<typeof scores>
  reranked: ReturnType<typeof scores>
  shipped: ReturnType<typeof scores>
  /** Distinct valid passage numbers returned, of `candidates`. */
  ranked: number
  ms: number
  cached: boolean
  tokens: number
}

console.log(`rerank ${rm.id} · ${candidates} candidates · ${golden.length} records${values.filtered ? ' (+ filtered)' : ''}`)
const rows: Row[] = []
for (const filtered of values.filtered ? [false, true] : [false]) {
  for (const r of golden) {
    const documents = new Set(r.evidence.map(e => e.document))
    if (filtered && documents.size !== 1) continue
    const hits = await searchChunks(supabase, {
      queryText: r.question,
      queryEmbedding: embeddings[r.question]!,
      matchCount: candidates,
      documentId: filtered ? idByFilename.get([...documents][0]!) : undefined,
    })
    const ranking = await cachedRanking(r.question, hits)
    const reranked = ranking.order.map(i => hits[i]!)
    const row: Row = {
      id: r.id,
      tags: r.tags,
      filtered,
      fused: scores(hits, r.evidence),
      reranked: scores(reranked, r.evidence),
      shipped: scores(blendRanking(hits, reranked, Number(values.head)), r.evidence),
      ranked: ranking.ranked,
      ms: ranking.ms,
      cached: ranking.cached,
      tokens: (ranking.inputTokens ?? 0) + (ranking.outputTokens ?? 0),
    }
    rows.push(row)
    const fmt = (s: Row['fused']) => `${s.rank ?? '-'}`.padStart(2)
    console.log(`${filtered ? 'F' : ' '} ${r.id} cover@ ${fmt(row.fused)} → ${fmt(row.reranked)} / ${fmt(row.shipped)}  nDCG@5 ${row.fused.ndcg5.toFixed(2)} → ${row.reranked.ndcg5.toFixed(2)} / ${row.shipped.ndcg5.toFixed(2)}  ${row.ranked}/${hits.length}${row.cached ? '' : ` ${(row.ms / 1000).toFixed(1)}s`}`)
  }
}

function summary(subset: Row[]) {
  const side = (key: 'fused' | 'reranked' | 'shipped') => summarize(subset.map(r => r[key]))
  return { n: subset.length, fused: side('fused'), reranked: side('reranked'), shipped: side('shipped') }
}

const line = (name: string, s: ReturnType<typeof summary>) => {
  const f = (x: ReturnType<typeof summary>['fused']) => `@5 ${pct(x.recall5)} @8 ${pct(x.recall8)} MRR ${x.mrr.toFixed(3)} nDCG@5 ${x.ndcg5.toFixed(3)}`
  console.log(`${name.padEnd(18)} n=${String(s.n).padStart(2)}  fused ${f(s.fused)}  │  reranked ${f(s.reranked)}  │  shipped ${f(s.shipped)}`)
}

const overall = { all: summary(rows.filter(r => !r.filtered)), filtered: values.filtered ? summary(rows.filter(r => r.filtered)) : undefined }
console.log()
line('all', overall.all)
if (overall.filtered) line('filtered', overall.filtered)
const tags = [...new Set(golden.flatMap(r => r.tags))].sort()
const slices = Object.fromEntries(tags.map(tag => [tag, summary(rows.filter(r => !r.filtered && r.tags.includes(tag)))]))
for (const [tag, s] of Object.entries(slices)) line(`  ${tag}`, s)

const live = rows.filter(r => !r.cached).map(r => r.ms).sort((a, b) => a - b)
const quantile = (q: number) => live.length ? live[Math.min(live.length - 1, Math.floor(q * live.length))]! : null
const incomplete = rows.filter(r => r.ranked < Math.min(candidates, 30)).length
const latency = { calls: live.length, p50: quantile(0.5), p95: quantile(0.95) }
const meanTokens = rows.reduce((s, r) => s + r.tokens, 0) / rows.length
console.log(`\nincomplete rankings ${incomplete}/${rows.length} · mean tokens ${meanTokens.toFixed(0)}${live.length ? ` · latency p50 ${(latency.p50! / 1000).toFixed(2)}s p95 ${(latency.p95! / 1000).toFixed(2)}s (${live.length} live calls)` : ''}`)

if (values.label) {
  const out = join(ROOT, 'docs/evals', `phase-7-${values.label}.json`)
  await writeFile(out, `${JSON.stringify({ model: rm.id, candidates, head: Number(values.head), date: new Date().toISOString().slice(0, 10), overall, slices, incomplete, meanTokens, latency, rows }, null, 1)}\n`)
  console.log(`wrote ${out}`)
}
