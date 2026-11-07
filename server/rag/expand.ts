import { updateActiveObservation } from '@langfuse/tracing'
import { generateText, Output } from 'ai'
import { z } from 'zod'
import type { TaskModel, TaskModelChoice } from './model'
import { neutralise } from './prompt'
import type { SearchHit } from './search'

// Phase 8: multi-query expansion (ADR-0009).
//
// One call rewrites the question into up to MAX_REWRITES search queries:
// one per plausible document for an ambiguous question ("What are the
// tiers?"), or one per part for a question about several things ("How do
// Self-RAG and RAPTOR each use GPT-4?"). A specific question gets none: always
// expanding cost recall@8 on clear questions (ADR-0009). Each query is retrieved separately and the lists are fused with RRF;
// the original question always takes part at full weight, and the reranker
// still ranks against the original wording.
//
// Guardrail (entity preservation): a rewrite must keep every token of the
// question that contains a digit (control IDs, versions, numbers, model names
// like GPT-4) verbatim, or it is dropped. Expansion is optional at run time:
// on any error or timeout the question is retrieved alone.

export const MAX_REWRITES = 3

/**
 * The app's rewriter unless NUXT_EXPAND_MODEL says otherwise (keep
 * nuxt.config.ts in sync). On the reranker's model, not the answer model's:
 * when that quota runs out both optional steps fall back and answers go on.
 */
export const DEFAULT_EXPAND_MODEL: TaskModelChoice = 'groq-20b'

export const EXPAND_INSTRUCTIONS = `You turn a user's question into search queries for a retrieval system over a fixed set of PDF documents.

Most questions need no rewriting: the question itself is searched in any case. Return an empty list unless one of these applies:
- The question is ambiguous between documents (for example "the tiers" or "the functions" without saying which framework): write one query for each document it plausibly refers to, and name that document by its title. Skip documents the question cannot be about.
- The question asks about several things or several documents at once: write one focused query per part.

Write at most ${MAX_REWRITES} queries. A question that names its document, framework, method or identifier, or asks for one specific fact, gets an empty list.

Each listed document is "filename: the start of its first page".

Rules:
- Keep every identifier, number, version and model name exactly as written (for example PR.DS-11, CSF 2.0, GPT-4).
- Do not answer the question and do not add facts that are not in it.
- Each query is one sentence, at most 25 words.`

const expansionSchema = z.object({
  queries: z.array(z.string()).describe(`0 to ${MAX_REWRITES} search queries; empty when the question is already specific.`),
})

/** @param documents One line per document (catalogLine in ./catalog). */
export function buildExpandPrompt(question: string, documents: string[]): string {
  return `Documents:\n${documents.map(d => `- ${d}`).join('\n')}\n\nQuestion: ${neutralise(question)}`
}

/** Tokens of the question that contain a digit, without surrounding punctuation. */
export function protectedTokens(question: string): string[] {
  return question.split(/\s+/)
    .map(token => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(token => /\d/.test(token))
}

/**
 * Keeps usable rewrites: non-empty, at most 300 characters, distinct from the
 * question and from each other (case- and space-insensitive), and keeping
 * every protected token of the question.
 */
export function validateRewrites(question: string, rewrites: readonly string[]): { queries: string[], dropped: number } {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const seen = new Set([norm(question)])
  const tokens = protectedTokens(question).map(t => t.toLowerCase())
  const queries: string[] = []
  for (const raw of rewrites) {
    const query = raw.replace(/\s+/g, ' ').trim()
    const key = norm(query)
    if (!query || query.length > 300 || seen.has(key) || !tokens.every(t => key.includes(t))) continue
    seen.add(key)
    queries.push(query)
    if (queries.length === MAX_REWRITES) break
  }
  return { queries, dropped: rewrites.length - queries.length }
}

export interface Expansion {
  /** Validated rewrites, without the original question. */
  queries: string[]
  /** Rewrites the model returned that failed validation. */
  dropped: number
  inputTokens?: number
  outputTokens?: number
}

/** One expansion call. Throws on model or schema errors (see `expand`). */
export async function rewriteQuery(
  tm: TaskModel,
  question: string,
  documents: string[],
  options: { abortSignal?: AbortSignal, maxRetries?: number } = {},
): Promise<Expansion> {
  const { output, usage } = await generateText({
    model: tm.model,
    instructions: EXPAND_INSTRUCTIONS,
    prompt: buildExpandPrompt(question, documents),
    output: Output.object({ schema: expansionSchema, name: 'queries' }),
    temperature: 0,
    maxOutputTokens: 600,
    providerOptions: tm.providerOptions,
    maxRetries: options.maxRetries ?? 0,
    abortSignal: options.abortSignal,
  })
  return { ...validateRewrites(question, output.queries), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

/**
 * Rewrites, or [] when expansion is unavailable. Never throws, except when the
 * caller's own signal aborts.
 */
export async function expand(
  tm: TaskModel | undefined,
  question: string,
  documents: string[],
  options: { abortSignal?: AbortSignal, timeoutMs?: number } = {},
): Promise<string[]> {
  if (!tm) return []
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 3000), options.abortSignal].filter(s => s !== undefined))
  // Raced as in rerank(): the budget holds even if a provider ignores the signal.
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  try {
    const { queries } = await Promise.race([rewriteQuery(tm, question, documents, { abortSignal: signal }), aborted])
    return queries
  }
  catch (error) {
    if (options.abortSignal?.aborted) throw error
    console.warn(`[expand] ${tm.id} failed, retrieving the question alone: ${String(error).slice(0, 200)}`)
    updateActiveObservation({ level: 'WARNING', statusMessage: `rewrite failed, question searched alone: ${String(error).slice(0, 200)}` })
    return []
  }
}

/** RRF k for fusing the per-query lists (as in hybrid_search_bge_m3, ADR-0006). */
export const MULTI_QUERY_RRF_K = 60

/**
 * Weighted Reciprocal Rank Fusion of several ranked lists of hits (by chunk
 * id); a missing weight is 1. Ties break by the earliest list, then by rank.
 */
export function fuseRankings(lists: readonly SearchHit[][], weights: readonly number[] = [], k = MULTI_QUERY_RRF_K): SearchHit[] {
  const rows = new Map<string, { hit: SearchHit, score: number, first: number }>()
  lists.forEach((list, l) => list.forEach((hit, i) => {
    const row = rows.get(hit.id) ?? { hit, score: 0, first: l * 1000 + i }
    row.score += (weights[l] ?? 1) / (k + i + 1)
    rows.set(hit.id, row)
  }))
  return [...rows.values()].sort((a, b) => b.score - a.score || a.first - b.first).map(r => r.hit)
}
