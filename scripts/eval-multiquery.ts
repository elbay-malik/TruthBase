// Phase 8: does multi-query expansion improve the candidate pool? (ADR-0009)
//
// For every answerable golden record: rewrite the question (one cached
// task-model call), retrieve the question and each rewrite from the hosted
// `hybrid_search_bge_m3`, and fuse the lists with weighted RRF. Compares, on the
// RERANK_CANDIDATES the reranker would see:
//   single     the question alone (Phase 7's candidates)
//   multi w    question at weight 1, each rewrite at weight w
// No rerank calls: this measures what expansion adds to the pool, so it spends
// only the rewrite model's quota (~0.5K tokens per question).
//
//   pnpm eval:multiquery                      # the app's rewriter (groq-20b)
//   pnpm eval:multiquery --model groq-120b --label groq-120b
//   pnpm eval:multiquery --model gemini --tpm 0 --label gemini
//
// Metrics as in eval:rerank (scripts/lib/golden.ts); nDCG@5 takes its ideal
// from the union of all compared lists, so they share one ideal.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { catalogLine, documentCatalog } from '../server/rag/catalog'
import { buildExpandPrompt, DEFAULT_EXPAND_MODEL, EXPAND_INSTRUCTIONS, fuseRankings, rewriteQuery } from '../server/rag/expand'
import { taskModel, type TaskModelChoice } from '../server/rag/model'
import { RERANK_CANDIDATES } from '../server/rag/rerank'
import { searchChunks, type SearchHit } from '../server/rag/search'
import { answerableRecords, documentMaps, metrics, pct, queryEmbeddings, ROOT, summarize, type Scored } from './lib/golden'
import { taskCache } from './lib/task-cache'

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: DEFAULT_EXPAND_MODEL },
    candidates: { type: 'string', default: String(RERANK_CANDIDATES) },
    /** Pace uncached calls to this many tokens per minute (0 = no pacing). */
    tpm: { type: 'string', default: '7500' },
    label: { type: 'string' },
    only: { type: 'string' },
  },
})
const choice = values.model as TaskModelChoice
const candidates = Number(values.candidates)
const WEIGHTS = [1, 0.5] as const

const env = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set (run via pnpm eval:multiquery, which loads .env)`) })()
const supabase = createClient(env('NUXT_SUPABASE_URL'), env('NUXT_SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } })
const tm = taskModel({ groqApiKey: process.env.NUXT_GROQ_API_KEY, geminiApiKey: process.env.NUXT_GEMINI_API_KEY }, choice)
if (!tm) throw new Error(`--model ${choice} is not configured (missing API key) or unknown`)

const golden = await answerableRecords(values.only)
const { idByFilename } = await documentMaps(supabase)
const titles = (await documentCatalog(supabase)).map(catalogLine)
const embed = await queryEmbeddings({ cloudflareAccountId: process.env.NUXT_CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: process.env.NUXT_CLOUDFLARE_API_TOKEN })
const cachedExpansion = await taskCache('expand', tm, Number(values.tpm))
const { coverageRank, ndcgAt } = metrics(idByFilename)

type Variant = 'single' | `multi ${typeof WEIGHTS[number]}`
const VARIANTS: Variant[] = ['single', ...WEIGHTS.map(w => `multi ${w}` as const)]

interface Row {
  id: string
  tags: string[]
  rewrites: string[]
  dropped: number
  scores: Record<Variant, Scored>
  ms: number
  cached: boolean
  tokens: number
}

console.log(`multi-query ${tm.id} · ${candidates} candidates · ${golden.length} records`)
const rows: Row[] = []
for (const r of golden) {
  const expansion = await cachedExpansion(EXPAND_INSTRUCTIONS, buildExpandPrompt(r.question, titles), () => rewriteQuery(tm, r.question, titles))
  const texts = [r.question, ...expansion.queries]
  const vectors = await embed(texts)
  const lists = await Promise.all(texts.map((text, i) => searchChunks(supabase, { queryText: text, queryEmbedding: vectors[i]!, matchCount: candidates })))

  const orders: Record<Variant, SearchHit[]> = { single: lists[0]! } as Record<Variant, SearchHit[]>
  for (const w of WEIGHTS) orders[`multi ${w}`] = fuseRankings(lists, [1, ...expansion.queries.map(() => w)]).slice(0, candidates)
  const pool = [...new Map(Object.values(orders).flat().map(h => [h.id, h])).values()]
  const scores = Object.fromEntries(VARIANTS.map(v => [v, {
    rank: coverageRank(orders[v], r.evidence),
    ndcg5: ndcgAt(5, orders[v], r.evidence, pool),
  }])) as Record<Variant, Scored>

  const row: Row = {
    id: r.id,
    tags: r.tags,
    rewrites: expansion.queries,
    dropped: expansion.dropped,
    scores,
    ms: expansion.ms,
    cached: expansion.cached,
    tokens: (expansion.inputTokens ?? 0) + (expansion.outputTokens ?? 0),
  }
  rows.push(row)
  const ranks = VARIANTS.map(v => `${scores[v].rank ?? '-'}`.padStart(2)).join(' / ')
  console.log(`  ${r.id} cover@ ${ranks}  ${expansion.queries.length} rewrites${expansion.dropped ? ` (${expansion.dropped} dropped)` : ''}${row.cached ? '' : ` ${(row.ms / 1000).toFixed(1)}s`}`)
  if (r.tags.includes('ambiguous') || r.tags.includes('multi-hop')) for (const q of expansion.queries) console.log(`        → ${q}`)
}

const summary = (subset: Row[]) => Object.fromEntries(VARIANTS.map(v => [v, summarize(subset.map(r => r.scores[v]))]))
const line = (name: string, subset: Row[]) => {
  const s = summary(subset)
  const f = (v: Variant) => `${v} @5 ${pct(s[v]!.recall5)} @8 ${pct(s[v]!.recall8)} @15 ${pct(s[v]!.recall15)} MRR ${s[v]!.mrr.toFixed(3)} nDCG@5 ${s[v]!.ndcg5.toFixed(3)}`
  console.log(`${name.padEnd(18)} n=${String(subset.length).padStart(2)}  ${VARIANTS.map(f).join('  │  ')}`)
}

console.log()
line('all', rows)
const tags = [...new Set(golden.flatMap(r => r.tags))].sort()
for (const tag of tags) line(`  ${tag}`, rows.filter(r => r.tags.includes(tag)))

const live = rows.filter(r => !r.cached).map(r => r.ms).sort((a, b) => a - b)
const quantile = (q: number) => live.length ? live[Math.min(live.length - 1, Math.floor(q * live.length))]! : null
const latency = { calls: live.length, p50: quantile(0.5), p95: quantile(0.95) }
const meanTokens = rows.reduce((s, r) => s + r.tokens, 0) / rows.length
const meanRewrites = rows.reduce((s, r) => s + r.rewrites.length, 0) / rows.length
const dropped = rows.reduce((s, r) => s + r.dropped, 0)
console.log(`\nrewrites/question ${meanRewrites.toFixed(1)} · dropped ${dropped} · mean tokens ${meanTokens.toFixed(0)}${live.length ? ` · latency p50 ${(latency.p50! / 1000).toFixed(2)}s p95 ${(latency.p95! / 1000).toFixed(2)}s (${live.length} live calls)` : ''}`)

if (values.label) {
  const out = join(ROOT, 'docs/evals', `phase-8-${values.label}.json`)
  const slices = Object.fromEntries(tags.map(tag => [tag, summary(rows.filter(r => r.tags.includes(tag)))]))
  await writeFile(out, `${JSON.stringify({ model: tm.id, candidates, weights: WEIGHTS, date: new Date().toISOString().slice(0, 10), overall: summary(rows), slices, meanRewrites, dropped, meanTokens, latency, rows }, null, 1)}\n`)
  console.log(`wrote ${out}`)
}
