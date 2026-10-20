// Phase 9: the offline retrieval gate (ADR-0008). Runs the installed
// `hybrid_search` for every answerable golden record against the fixture
// corpus (test/fixtures/retrieval-corpus.json.gz) and compares recall@k, MRR
// and nDCG@5 with docs/evals/retrieval-baseline.json. No API keys: the
// fixture carries the query embeddings.
//
//   pnpm eval:retrieval --install                    # load the fixture, then check
//   pnpm eval:retrieval --install --update-baseline  # accept the current numbers
//
// Deterministic (exact cosine, id tie-breaks), so there is no tolerance: any
// drop fails, and a change that trades metrics must update the baseline in
// the same PR, where the diff shows it. Tag slices are reported, not gated.
//
// The database is TUNE_DATABASE_URL, DATABASE_URL, or the local Docker one
// from scripts/tune-retrieval.ts. LLM steps (multi-query, rerank) are not
// part of this gate; the promptfoo eval covers them.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import postgres from 'postgres'
import type { SearchHit } from '../server/rag/search'
import { answerableRecords, metrics, pct, ROOT, summarize, type GoldenRecord, type Scored } from './lib/golden'
import { decodeVector, installFixture, readFixture, vectorLiteral } from './lib/retrieval-fixture'

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: process.env.TUNE_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres' },
    install: { type: 'boolean', default: false },
    'update-baseline': { type: 'boolean', default: false },
  },
})

const BASELINE_FILE = join(ROOT, 'docs/evals/retrieval-baseline.json')
/** Gated metrics, all "higher is better". */
const GATED = ['recall5', 'recall8', 'recall10', 'recall15', 'mrr', 'ndcg5'] as const

const sql = postgres(values.db!, { onnotice: () => {}, max: 4 })
const fixture = await readFixture()
if (values.install) {
  await installFixture(sql, fixture)
  console.log(`installed fixture: ${fixture.documents.length} documents, ${fixture.chunks.length} chunks (exported ${fixture.exportedAt.slice(0, 10)})`)
}

const golden = await answerableRecords()
const docs = await sql<{ id: string, filename: string }[]>`select id, filename from documents`
const idByFilename = new Map(docs.map(d => [d.filename, d.id]))
const { coverageRank, ndcgAt } = metrics(idByFilename)

async function search(record: GoldenRecord, filter: string | null): Promise<SearchHit[]> {
  const encoded = fixture.queries[record.question]
  if (!encoded) throw new Error(`${record.id}: no query embedding in the fixture (run pnpm fixtures:retrieval)`)
  const rows = await sql<{ id: string, document_id: string, page_number: number | null, content: string, score: number }[]>`
    select id, document_id, page_number, content, score
    from hybrid_search(${record.question}, ${vectorLiteral(decodeVector(encoded))}::extensions.vector, 15, filter_document_id => ${filter}::uuid)`
  return rows.map(r => ({ id: r.id, documentId: r.document_id, pageNumber: r.page_number, content: r.content, score: r.score }) as SearchHit)
}

const rows: { id: string, tags: string[], filtered: boolean, scored: Scored }[] = []
for (const filtered of [false, true]) {
  for (const r of golden) {
    const documents = new Set(r.evidence.map(e => e.document))
    if (filtered && documents.size !== 1) continue
    const hits = await search(r, filtered ? idByFilename.get([...documents][0]!) ?? null : null)
    rows.push({ id: r.id, tags: r.tags, filtered, scored: { rank: coverageRank(hits, r.evidence), ndcg5: ndcgAt(5, hits, r.evidence) } })
  }
}
await sql.end()

const report = {
  all: summarize(rows.filter(r => !r.filtered).map(r => r.scored)),
  filtered: summarize(rows.filter(r => r.filtered).map(r => r.scored)),
}
const tags = [...new Set(golden.flatMap(r => r.tags))].sort()
const slices = Object.fromEntries(tags.map(t => [t, summarize(rows.filter(r => !r.filtered && r.tags.includes(t)).map(r => r.scored))]))
/** Per-record full-coverage rank, so a baseline diff names the records that moved. */
const ranks = Object.fromEntries(rows.map(r => [`${r.filtered ? 'F ' : ''}${r.id}`, r.scored.rank]))

type Summary = typeof report.all
const fmt = (key: typeof GATED[number], x: number) => key.startsWith('recall') ? pct(x) : x.toFixed(3)
const baseline: { all: Summary, filtered: Summary, ranks: Record<string, number | null> } | undefined
  = await readFile(BASELINE_FILE, 'utf8').then(JSON.parse, () => undefined)

let failed = false
for (const scope of ['all', 'filtered'] as const) {
  const now = report[scope]
  const before = baseline?.[scope]
  const cells = GATED.map((key) => {
    const delta = before ? now[key] - before[key] : 0
    if (delta < -1e-9) failed = true
    const mark = !before || Math.abs(delta) < 1e-9 ? '' : delta > 0 ? ` (+${fmt(key, delta).trim()})` : ` (${fmt(key, delta).trim()}) ✗`
    return `${key} ${fmt(key, now[key])}${mark}`
  })
  console.log(`${scope.padEnd(8)} n=${now.n}  ${cells.join('  ')}`)
}
for (const [tag, s] of Object.entries(slices)) console.log(`  ${tag.padEnd(18)} n=${String(s.n).padStart(2)}  @5 ${pct(s.recall5)} @8 ${pct(s.recall8)} MRR ${s.mrr.toFixed(3)}`)

if (baseline) {
  const moved = Object.entries(ranks).filter(([id, rank]) => baseline.ranks[id] !== rank)
  if (moved.length) console.log(`\nmoved: ${moved.map(([id, rank]) => `${id} ${baseline.ranks[id] ?? '-'}→${rank ?? '-'}`).join(', ')}`)
}

if (values['update-baseline']) {
  await writeFile(BASELINE_FILE, `${JSON.stringify({ fixtureExportedAt: fixture.exportedAt, ...report, slices, ranks }, null, 1)}\n`)
  console.log(`\nwrote ${BASELINE_FILE}`)
}
else if (!baseline) {
  console.error('\nno baseline yet: run with --update-baseline')
  process.exitCode = 1
}
else if (failed) {
  console.error('\nretrieval regressed against docs/evals/retrieval-baseline.json (✗ above). If the trade-off is intended, re-run with --update-baseline and commit the baseline with the change.')
  process.exitCode = 1
}
else {
  console.log('\nretrieval gate passed')
}
