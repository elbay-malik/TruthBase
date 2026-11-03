// Golden-set plumbing shared by the retrieval evals (eval:rerank,
// eval:multiquery): records, document lookups, cached query embeddings and
// the ranking metrics from docs/SPEC.md.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cloudflareEmbedder, EMBEDDING_DIMENSIONS, type EmbeddingKeys } from '../../server/ingest/embed'
import type { SearchHit } from '../../server/rag/search'

export const ROOT = resolve(import.meta.dirname, '../..')

export interface Evidence { document: string, page: number, text: string }
export interface GoldenRecord { id: string, question: string, answer: string | null, evidence: Evidence[], tags: string[] }

/** Answerable records (those with evidence), optionally only the given ids. */
export async function answerableRecords(only?: string): Promise<GoldenRecord[]> {
  const golden: GoldenRecord[] = JSON.parse(await readFile(join(ROOT, 'docs/golden/golden.json'), 'utf8'))
  const ids = only ? new Set(only.split(',')) : undefined
  return golden.filter(r => r.answer !== null && r.evidence.length > 0 && (!ids || ids.has(r.id)))
}

export async function documentMaps(supabase: SupabaseClient) {
  const { data, error } = await supabase.from('documents').select('id, filename')
  if (error) throw new Error(error.message)
  return {
    filenameById: new Map(data.map(d => [d.id as string, d.filename as string])),
    idByFilename: new Map(data.map(d => [d.filename as string, d.id as string])),
  }
}

/** One file per model and dimension, so a model change never reuses old vectors. */
const EMBEDDING_FILE = join(ROOT, `.cache/query-embeddings/bge-m3-${EMBEDDING_DIMENSIONS}.json`)

/**
 * Query embeddings by text, cached in .cache/ (shared with
 * scripts/tune-retrieval.ts). Missing texts are embedded in one batch.
 */
export async function queryEmbeddings(keys: EmbeddingKeys) {
  const read = (file: string) => readFile(file, 'utf8').then(JSON.parse as (s: string) => Record<string, number[]>, () => undefined)
  const stored = await read(EMBEDDING_FILE) ?? {}
  const cache = Object.fromEntries(Object.entries(stored).filter(([, v]) => v.length === EMBEDDING_DIMENSIONS))
  return async (texts: string[]): Promise<number[][]> => {
    const missing = [...new Set(texts.filter(t => !cache[t]))]
    if (missing.length) {
      const vectors = await cloudflareEmbedder(keys)(missing)
      missing.forEach((t, i) => (cache[t] = vectors[i]!))
      await mkdir(dirname(EMBEDDING_FILE), { recursive: true })
      await writeFile(EMBEDDING_FILE, JSON.stringify(cache))
    }
    return texts.map(t => cache[t]!)
  }
}

/** Ranking metrics against a record's evidence (same matching as scripts/eval-answers.ts). */
export function metrics(idByFilename: Map<string, string>) {
  const covers = (hit: SearchHit, e: Evidence) =>
    hit.documentId === idByFilename.get(e.document) && hit.pageNumber === e.page && hit.content.includes(e.text)

  /** Rank (1-based) at which every evidence span is covered, or null. */
  function coverageRank(hits: SearchHit[], evidence: Evidence[]): number | null {
    let worst = 0
    for (const e of evidence) {
      const rank = hits.findIndex(h => covers(h, e)) + 1
      if (rank === 0) return null
      worst = Math.max(worst, rank)
    }
    return worst
  }

  /**
   * nDCG@k with binary relevance (a chunk is relevant if it contains any
   * evidence span). `pool` gives the ideal ranking (all its relevant chunks
   * first): pass the whole corpus, or at least the union of the lists being
   * compared, so the ideal doesn't depend on what the ranking under test found.
   */
  function ndcgAt(k: number, hits: SearchHit[], evidence: Evidence[], pool: SearchHit[] = hits): number {
    const relevant = (list: SearchHit[]) => list.map(h => evidence.some(e => covers(h, e)))
    const dcg = (flags: boolean[]) => flags.slice(0, k).reduce((s, rel, i) => s + (rel ? 1 / Math.log2(i + 2) : 0), 0)
    const ideal = dcg(relevant(pool).sort((a, b) => Number(b) - Number(a)))
    return ideal === 0 ? 0 : dcg(relevant(hits)) / ideal
  }

  return { covers, coverageRank, ndcgAt }
}

export interface Scored { rank: number | null, ndcg5: number }

/** recall@k, MRR and mean nDCG@5 over a set of scored records. */
export function summarize(scored: Scored[]) {
  const n = scored.length
  const at = (k: number) => scored.filter(s => s.rank !== null && s.rank <= k).length / n
  return {
    n,
    recall5: at(5),
    recall8: at(8),
    recall10: at(10),
    recall15: at(15),
    mrr: scored.reduce((s, x) => s + (x.rank ? 1 / x.rank : 0), 0) / n,
    ndcg5: scored.reduce((s, x) => s + x.ndcg5, 0) / n,
  }
}

export type Summary = ReturnType<typeof summarize>

/** The retrieval gate's metrics, all "higher is better". */
export const GATED = ['recall5', 'recall8', 'recall10', 'recall15', 'mrr', 'ndcg5'] as const

export interface RetrievalReport { all: Summary, filtered: Summary }

/**
 * Why a retrieval run fails its gate: a gated metric that isn't a number (an
 * empty scope), dropped, or has no baseline value; a record count that differs
 * from the baseline's; baseline records missing from the run. Without a
 * baseline, only the first.
 */
export function retrievalGateFailures(
  report: RetrievalReport,
  ranks: Record<string, number | null>,
  baseline?: Partial<RetrievalReport> & { ranks?: Record<string, number | null> },
): string[] {
  const failures: string[] = []
  for (const scope of ['all', 'filtered'] as const) {
    const now = report[scope]
    const before = baseline?.[scope]
    for (const key of GATED) {
      if (!Number.isFinite(now[key])) failures.push(`${scope} ${key} is ${now[key]} (n=${now.n})`)
      else if (baseline && !Number.isFinite(before?.[key])) failures.push(`${scope} ${key} has no baseline value`)
      else if (before && now[key] - before[key] < -1e-9) failures.push(`${scope} ${key} dropped`)
    }
    if (baseline && now.n !== before?.n) failures.push(`${scope} has ${now.n} records, the baseline ${before?.n}`)
  }
  const missing = Object.keys(baseline?.ranks ?? {}).filter(id => !(id in ranks))
  if (missing.length) failures.push(`baseline records missing from this run: ${missing.join(', ')}`)
  return failures
}

export const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4)
