// Phase 6: hybrid retrieval tuning against the golden set (docs/adr/0006).
//
// Runs SQL variants of `hybrid_search_bge_m3` against a LOCAL copy of the corpus, so
// keyword-query forms, rank functions, pool sizes and RRF k / weights can be
// compared without touching the hosted schema. Both arms run exactly as the
// function does (the semantic arm is an exact cosine scan, see the v2
// migration); fusion happens here, identically to the SQL.
//
//   docker run -d --name truthbase-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 supabase/postgres:17.11.0.004
//   (apply supabase/migrations/*.sql to it, e.g. `docker exec -i truthbase-pg psql -U postgres < file`)
//   pnpm tune:retrieval --sync          # copy documents + chunks from the hosted project
//   pnpm tune:retrieval                 # run the variant grid, print recall / MRR
//   pnpm tune:retrieval --json out.json # also write every variant's numbers
//
// Metrics follow scripts/eval-answers.ts: a record counts at k when ALL its
// evidence spans lie in the top-k chunks. MRR uses that full-coverage rank.
// Filtered recall repeats the search with filter_document_id = the evidence's
// document (single-document records), as the chat UI's document filter does.

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { queryEmbeddings } from './lib/golden'

const ROOT = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    sync: { type: 'boolean', default: false },
    json: { type: 'string' },
    /** Only evaluate the installed `hybrid_search_bge_m3` function with its defaults (regression check). */
    function: { type: 'boolean', default: false },
    db: { type: 'string', default: process.env.TUNE_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres' },
  },
})

const sql = postgres(values.db!, { onnotice: () => {}, max: 4 })

interface Evidence { document: string, page: number, text: string }
interface GoldenRecord { id: string, question: string, answer: string | null, evidence: Evidence[] }

// ── sync ───────────────────────────────────────────────────────────────────
if (values.sync) {
  const env = (name: string) => process.env[name] ?? (() => { throw new Error(`${name} is not set`) })()
  const supabase = createClient(env('NUXT_SUPABASE_URL'), env('NUXT_SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } })
  const { data: documents, error } = await supabase.from('documents').select('id, filename, storage_path, page_count, created_at')
  if (error) throw new Error(error.message)
  const chunks: Record<string, unknown>[] = []
  for (let from = 0; ; from += 500) {
    const page = await supabase.from('chunks').select('id, document_id, page_number, content, context, embedding:embedding_bge_m3, highlight, created_at')
      .order('id').range(from, from + 499)
    if (page.error) throw new Error(page.error.message)
    chunks.push(...page.data)
    if (page.data.length < 500) break
  }
  await sql.begin(async (tx) => {
    await tx`delete from documents`
    await tx`insert into documents ${tx(documents)}`
    // embedding arrives as pgvector text ('[0.1,…]'); fts is a generated column (context || ' ' || content).
    await tx`
      insert into chunks (id, document_id, page_number, content, context, embedding_bge_m3, highlight, created_at)
      select id, document_id, page_number, content, context, embedding::extensions.vector, highlight, created_at
      from jsonb_to_recordset(${tx.json(chunks as never)}::jsonb)
        as x(id uuid, document_id uuid, page_number int, content text, context text, embedding text, highlight jsonb, created_at timestamptz)`
  })
  console.log(`synced ${documents.length} documents, ${chunks.length} chunks`)
  await sql.end()
  process.exit(0)
}

// ── golden set + cached query embeddings ───────────────────────────────────
const golden: GoldenRecord[] = JSON.parse(await readFile(join(ROOT, 'docs/golden/golden.json'), 'utf8'))
const answerable = golden.filter(r => r.answer !== null && r.evidence.length > 0)
const vectors = await (await queryEmbeddings({ cloudflareAccountId: process.env.NUXT_CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: process.env.NUXT_CLOUDFLARE_API_TOKEN }))(answerable.map(r => r.question))
const queryEmbedding = Object.fromEntries(answerable.map((r, i) => [r.question, vectors[i]!]))

const docs = await sql<{ id: string, filename: string }[]>`select id, filename from documents`
const docByName = new Map(docs.map(d => [d.filename, d.id]))
const chunkRows = await sql<{ id: string, document_id: string, page_number: number, content: string }[]>`
  select id, document_id, page_number, content from chunks`
const chunkById = new Map(chunkRows.map(c => [c.id, c]))
if (chunkRows.length === 0) throw new Error('local DB is empty: run with --sync first')

// ── variants ───────────────────────────────────────────────────────────────
interface Variant {
  name: string
  /** websearch: AND of all terms (current); or: any term; fallback: AND, else OR when AND finds < 3 rows. */
  keyword: 'websearch' | 'or' | 'fallback'
  rank: 'ts_rank_cd' | 'ts_rank'
  /** Candidates per arm. */
  pool: number
  rrfK: number
  fullTextWeight: number
  semanticWeight: number
}

/** hybrid_search v1 as called with match_count 10 (pool = 2 × match_count). */
const BASE: Variant = { name: 'v1', keyword: 'websearch', rank: 'ts_rank_cd', pool: 20, rrfK: 50, fullTextWeight: 1, semanticWeight: 1 }

const tsquery = (v: Variant) => {
  const and = `websearch_to_tsquery('english', $1)`
  // The OR of the question's own to_tsvector lexemes — the v2 migration's expression.
  const or = `(select coalesce(string_agg('''' || replace(replace(l, '\\', '\\\\'), '''', '''''') || '''', ' | '), '')::tsquery from unnest(tsvector_to_array(to_tsvector('english', $1))) l)`
  if (v.keyword === 'websearch') return and
  if (v.keyword === 'or') return or
  return `(case when (select count(*) from chunks c2 where c2.fts @@ ${and} and ($3::uuid is null or c2.document_id = $3::uuid)) >= 3 then ${and} else ${or} end)`
}

/** Keyword arm: ids in rank order (ties by id, so runs are deterministic). */
function keywordSql(v: Variant): string {
  return `
with q as (select ${tsquery(v)} as tsq)
select c.id from chunks c, q
where c.fts @@ q.tsq and ($3::uuid is null or c.document_id = $3::uuid)
order by ${v.rank}(c.fts, q.tsq) desc, c.id
limit $2`
}

/** Semantic arm: exact cosine order, ties by id (as the function). */
function semanticSql(): string {
  return `
select id from chunks
where embedding_bge_m3 is not null and ($3::uuid is null or document_id = $3::uuid)
order by embedding_bge_m3 <=> $1::extensions.vector, id
limit $2`
}

/** RRF exactly as hybrid_search_bge_m3 computes it, plus a tie-breaker (semantic rank, then id). */
function fuse(v: Variant, keyword: string[], semantic: string[]): string[] {
  const rows = new Map<string, { score: number, sem: number }>()
  keyword.forEach((id, i) => rows.set(id, { score: v.fullTextWeight / (v.rrfK + i + 1), sem: Infinity }))
  semantic.forEach((id, i) => {
    const row = rows.get(id) ?? { score: 0, sem: Infinity }
    row.score += v.semanticWeight / (v.rrfK + i + 1)
    row.sem = i + 1
    rows.set(id, row)
  })
  return [...rows].filter(([, r]) => r.score > 0)
    .sort(([a, x], [b, y]) => y.score - x.score || x.sem - y.sem || (a < b ? -1 : 1))
    .map(([id]) => id)
}

const contains = (chunkId: string, e: Evidence) => {
  const c = chunkById.get(chunkId)!
  return c.document_id === docByName.get(e.document) && c.page_number === e.page && c.content.includes(e.text)
}
function coverageRank(ids: string[], evidence: Evidence[]): number | null {
  let worst = 0
  for (const e of evidence) {
    const rank = ids.findIndex(id => contains(id, e)) + 1
    if (rank === 0) return null
    worst = Math.max(worst, rank)
  }
  return worst
}

/** The installed hybrid_search_bge_m3() with its SQL defaults, as the app calls it. */
async function runFunction(filtered: boolean) {
  return run(BASE, filtered, async (question, embedding, filter) =>
    (await sql`select id from hybrid_search_bge_m3(${question}, ${embedding}::extensions.vector, 10, filter_document_id => ${filter}::uuid)`).map(row => row.id as string))
}

type Search = (question: string, embedding: string, filter: string | null) => Promise<string[]>

async function run(v: Variant, filtered: boolean, search?: Search) {
  const ranks: (number | null)[] = []
  for (const r of answerable) {
    const documents = new Set(r.evidence.map(e => e.document))
    if (filtered && documents.size !== 1) continue
    const filter = filtered ? docByName.get([...documents][0]!)! : null
    const embedding = `[${queryEmbedding[r.question]!.join(',')}]`
    if (search) {
      ranks.push(coverageRank(await search(r.question, embedding, filter), r.evidence))
      continue
    }
    const keyword = (await sql.unsafe(keywordSql(v), [r.question, v.pool, filter])).map(row => row.id as string)
    const semantic = (await sql.unsafe(semanticSql(), [embedding, v.pool, filter])).map(row => row.id as string)
    const ids = fuse(v, keyword, semantic).slice(0, 10)
    ranks.push(coverageRank(ids, r.evidence))
  }
  const at = (k: number) => ranks.filter(x => x !== null && x <= k).length / ranks.length
  return {
    /** Full-coverage rank per evaluated record (null = not in the top 10), for cross-validation. */
    ranks,
    n: ranks.length,
    recall5: at(5),
    recall8: at(8),
    recall10: at(10),
    mrr: ranks.reduce<number>((s, x) => s + (x ? 1 / x : 0), 0) / ranks.length,
  }
}

const variants: Variant[] = []
const add = (name: string, patch: Partial<Variant>) => variants.push({ ...BASE, name, ...patch })
add('v1 (AND, k 50, 1/1, pool 20)', {})
add('dense only', { fullTextWeight: 0 })
add('keyword only (AND)', { semanticWeight: 0 })
add('keyword only (OR, ts_rank_cd)', { semanticWeight: 0, keyword: 'or' })
add('keyword only (OR, ts_rank)', { semanticWeight: 0, keyword: 'or', rank: 'ts_rank' })
add('keyword only (AND→OR fallback)', { semanticWeight: 0, keyword: 'fallback' })
for (const keyword of ['or', 'fallback'] as const) {
  for (const rank of ['ts_rank_cd', 'ts_rank'] as const) {
    for (const rrfK of [10, 30, 60]) {
      for (const [fullTextWeight, semanticWeight] of [[1, 1], [0.5, 1], [1, 0.5]] as const) {
        for (const pool of [20, 40]) {
          add(`hybrid ${keyword} ${rank} k=${rrfK} w=${fullTextWeight}/${semanticWeight} pool=${pool}`, { keyword, rank, rrfK, fullTextWeight, semanticWeight, pool })
        }
      }
    }
  }
}

if (values.function) {
  const [all, filtered] = [await runFunction(false), await runFunction(true)]
  const p = (x: number) => `${(100 * x).toFixed(0)}%`
  console.log(`hybrid_search() defaults: @5 ${p(all.recall5)} @8 ${p(all.recall8)} @10 ${p(all.recall10)} MRR ${all.mrr.toFixed(3)} │ filtered @8 ${p(filtered.recall8)} (n=${filtered.n})`)
  await sql.end()
  process.exit(0)
}

const results = []
for (const v of variants) {
  const [all, filtered] = [await run(v, false), await run(v, true)]
  results.push({ ...v, all, filtered })
  const p = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4)
  console.log(`${v.name.padEnd(58)} @5 ${p(all.recall5)} @8 ${p(all.recall8)} @10 ${p(all.recall10)} MRR ${all.mrr.toFixed(3)} │ filtered @8 ${p(filtered.recall8)} (n=${filtered.n})`)
}
if (values.json) await writeFile(values.json, `${JSON.stringify(results, null, 1)}\n`)
await sql.end()
