// Golden-set plumbing shared by the retrieval evals (eval:rerank,
// eval:multiquery): records, document lookups, cached query embeddings and
// the ranking metrics from docs/SPEC.md.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { geminiEmbedder } from '../../server/ingest/embed'
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

const EMBEDDING_FILE = join(ROOT, '.cache/golden-query-embeddings.json')

/**
 * RETRIEVAL_QUERY embeddings by text, cached in .cache/ (shared with
 * scripts/tune-retrieval.ts). Missing texts are embedded in one batch.
 */
export async function queryEmbeddings(geminiApiKey: string) {
  const cache: Record<string, number[]> = await readFile(EMBEDDING_FILE, 'utf8').then(JSON.parse, () => ({}))
  const embed = geminiEmbedder(geminiApiKey, 'RETRIEVAL_QUERY')
  return async (texts: string[]): Promise<number[][]> => {
    const missing = [...new Set(texts.filter(t => !cache[t]))]
    if (missing.length) {
      const vectors = await embed(missing)
      missing.forEach((t, i) => (cache[t] = vectors[i]!))
      await mkdir(join(ROOT, '.cache'), { recursive: true })
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
   * first); pass the union of the lists being compared so they share one ideal.
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

export const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4)
