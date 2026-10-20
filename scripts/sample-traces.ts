// Phase 10: sample production chat traces from Langfuse as golden-set
// candidates. Real questions are what the golden set should grow from.
//
//   pnpm sample:traces                 # last 7 days
//   pnpm sample:traces --days 30 --random 20
//
// Picks every refusal (a missed answer or a correct "not in the documents"),
// every trace where rewriting or reranking fell back, the slowest answers by
// time to first token, and a random sample of the rest. Writes
// .cache/golden-candidates.json: question, answer, sources and why it was
// picked. A person decides which become records in docs/golden/golden.json,
// with evidence spans checked against the PDFs; nothing is added automatically.
//
// Reads Langfuse's v2 observations API (the v1 traces API is removed on
// Langfuse Cloud on 2026-11-16).

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { NO_ANSWER } from '../shared/types/chat'
import { ROOT } from './lib/golden'

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '7' },
    slowest: { type: 'string', default: '10' },
    random: { type: 'string', default: '10' },
  },
})

const env = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set (run via pnpm sample:traces, which loads .env)`) })()
const base = (process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/$/, '')
const auth = `Basic ${Buffer.from(`${env('LANGFUSE_PUBLIC_KEY')}:${env('LANGFUSE_SECRET_KEY')}`).toString('base64')}`

interface Observation {
  id: string
  traceId: string
  startTime: string
  level: string
  input?: unknown
  output?: unknown
  metadata?: Record<string, unknown>
}

/** Root `chat` observations (one per trace) since `from`, all pages. */
async function chatRoots(from: Date): Promise<Observation[]> {
  const roots: Observation[] = []
  let cursor: string | undefined
  do {
    const query = new URLSearchParams({ fromStartTime: from.toISOString(), name: 'chat', type: 'AGENT', limit: '100', fields: 'core,basic,io,metadata' })
    if (cursor) query.set('cursor', cursor)
    const response = await fetch(`${base}/api/public/v2/observations?${query}`, { headers: { authorization: auth } })
    if (!response.ok) throw new Error(`Langfuse ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const page = await response.json() as { data: Observation[], meta?: { cursor?: string } }
    roots.push(...page.data)
    cursor = page.data.length ? page.meta?.cursor : undefined
  } while (cursor)
  return roots
}

/** The SDK stores observation input/output as JSON strings. */
const parse = (value: unknown) => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  }
  catch {
    return value
  }
}

const roots = await chatRoots(new Date(Date.now() - Number(values.days) * 86_400_000))
const traces = roots.map((o) => {
  const input = parse(o.input) as { question?: string, documentId?: string } | undefined
  const answer = String(parse(o.output) ?? '')
  const meta = o.metadata ?? {}
  return {
    traceId: o.traceId,
    at: o.startTime,
    question: input?.question ?? '',
    documentId: input?.documentId ?? null,
    answer,
    refused: answer.trim() === NO_ANSWER,
    ttftMs: typeof meta.ttftMs === 'number' ? meta.ttftMs : null,
    rewrites: meta.rewrites ?? null,
    reranked: meta.reranked ?? null,
    level: o.level,
  }
}).filter(t => t.question)

const reasons = new Map<string, string[]>()
const pick = (traceId: string, reason: string) => reasons.set(traceId, [...(reasons.get(traceId) ?? []), reason])
for (const t of traces) {
  if (t.refused) pick(t.traceId, 'refused')
  if (t.reranked === false && t.answer) pick(t.traceId, 'rerank fell back')
  if (t.level !== 'DEFAULT') pick(t.traceId, `level ${t.level}`)
}
for (const t of [...traces].filter(t => t.ttftMs !== null).sort((a, b) => b.ttftMs! - a.ttftMs!).slice(0, Number(values.slowest))) pick(t.traceId, `slow (ttft ${t.ttftMs} ms)`)
const rest = traces.filter(t => !reasons.has(t.traceId)).sort(() => Math.random() - 0.5)
for (const t of rest.slice(0, Number(values.random))) pick(t.traceId, 'random sample')

// One candidate per distinct question, keeping the first trace's answer.
const seen = new Set<string>()
const candidates = traces
  .filter(t => reasons.has(t.traceId))
  .filter(t => !seen.has(t.question.toLowerCase()) && seen.add(t.question.toLowerCase()))
  .map(t => ({ ...t, reasons: reasons.get(t.traceId), traceUrl: `${base}/trace/${t.traceId}` }))

const out = join(ROOT, '.cache/golden-candidates.json')
await writeFile(out, `${JSON.stringify(candidates, null, 1)}\n`)
const ttfts = traces.map(t => t.ttftMs).filter((x): x is number => x !== null).sort((a, b) => a - b)
const p = (q: number) => ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.floor(q * ttfts.length))] : '-'
console.log(`${traces.length} chat traces in ${values.days} days · ttft p50 ${p(0.5)} ms, p95 ${p(0.95)} ms · ${traces.filter(t => t.refused).length} refused`)
console.log(`wrote ${candidates.length} candidates to ${out}`)
