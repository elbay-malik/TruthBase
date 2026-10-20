// SPEC metrics from a promptfoo run of the LLM eval (ADR-0008), checked
// against the SPEC targets and compared with docs/evals/llm-baseline.json.
//
//   pnpm eval:llm && pnpm eval:llm:summary                    # check
//   pnpm eval:llm:summary --update-baseline                   # accept
//
// Pooled, as SPEC defines them (promptfoo's own metric view averages per
// test): faithfulness = supported claims / claims and citation precision =
// supporting citations / citations, over all answered records. Judge results
// come from the judge's disk cache, so this costs no tokens after the eval.
//
// Gate: the SPEC targets (faithfulness ≥ 0.90, citation precision ≥ 0.90,
// 5/5 unanswerable refused, ≤ 1 false refusal), and no metric more than
// TOLERANCE below the baseline: LLM output varies between uncached runs.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ROOT } from '../lib/golden'
import { judgeAnswer, type JudgeSource } from './judge'

const { values } = parseArgs({
  options: {
    results: { type: 'string', default: join(ROOT, '.cache/promptfoo-results.json') },
    'update-baseline': { type: 'boolean', default: false },
  },
})
const BASELINE_FILE = join(ROOT, 'docs/evals/llm-baseline.json')
const TOLERANCE = 0.05
const TARGETS = { faithfulness: 0.9, citationPrecision: 0.9 }

interface Row {
  vars: { id: string, question: string, answerable: boolean | string }
  response?: { output?: string, metadata?: { refused?: boolean, sources?: JudgeSource[], expander?: string, reranker?: string, rewrites?: string[], reranked?: boolean, answeredBy?: string } }
  namedScores?: Record<string, number>
  error?: string
}

const raw = JSON.parse(await readFile(values.results!, 'utf8'))
const rows: Row[] = raw.results?.results ?? raw.results
const errors = rows.filter(r => r.error || !r.response?.metadata)
if (errors.length) console.warn(`${errors.length} rows errored and are left out: ${errors.map(r => r.vars.id).join(', ')}`)
const ok = rows.filter(r => !r.error && r.response?.metadata)

const answerable = ok.filter(r => r.vars.answerable === true || r.vars.answerable === 'true')
const unanswerable = ok.filter(r => !answerable.includes(r))
const refused = (r: Row) => r.response!.metadata!.refused === true
const answered = ok.filter(r => !refused(r))

const pooled = { claims: 0, supportedClaims: 0, citations: 0, supportingCitations: 0, relevant: 0 }
for (const r of answered) {
  const j = await judgeAnswer(r.vars.question, r.response!.output ?? '', r.response!.metadata!.sources ?? [])
  pooled.claims += j.claims
  pooled.supportedClaims += j.supportedClaims
  pooled.citations += j.citations
  pooled.supportingCitations += j.supportingCitations
  if (j.answersQuestion) pooled.relevant++
}

const metrics = {
  records: ok.length,
  faithfulness: pooled.claims ? pooled.supportedClaims / pooled.claims : 1,
  citationPrecision: pooled.citations ? pooled.supportingCitations / pooled.citations : 1,
  answerRelevance: answered.length ? pooled.relevant / answered.length : 1,
  /** Answered answerable records citing a source that holds a golden evidence span (deterministic). */
  evidenceCitation: answerable.filter(r => !refused(r) && (r.namedScores?.['evidence-citation'] ?? 0) > 0).length / Math.max(1, answerable.filter(r => !refused(r)).length),
  unanswerableRefused: unanswerable.filter(refused).length,
  unanswerable: unanswerable.length,
  falseRefusals: answerable.filter(refused).length,
}
const meta = (r: Row) => r.response!.metadata!
const pipeline = {
  expander: [...new Set(ok.map(r => meta(r).expander ?? '?'))].join(', '),
  reranker: [...new Set(ok.map(r => meta(r).reranker ?? '?'))].join(', '),
  rewritten: ok.filter(r => (r.response!.metadata!.rewrites?.length ?? 0) > 0).length,
  /** Reranker configured but the fused order was kept (error, rate limit, timeout). */
  rerankFallbacks: ok.filter(r => meta(r).reranker !== 'off' && meta(r).reranked === false && (meta(r).sources?.length ?? 0) > 1).length,
  answeredBy: Object.fromEntries([...new Set(ok.map(r => r.response!.metadata!.answeredBy ?? '?'))].map(m => [m, ok.filter(r => r.response!.metadata!.answeredBy === m).length])),
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`
const baseline: typeof metrics | undefined = await readFile(BASELINE_FILE, 'utf8').then(s => JSON.parse(s).metrics, () => undefined)
const failures: string[] = []
const rate = (name: keyof typeof metrics & ('faithfulness' | 'citationPrecision' | 'answerRelevance' | 'evidenceCitation'), target?: number) => {
  const now = metrics[name]
  const before = baseline?.[name]
  if (target !== undefined && now < target) failures.push(`${name} ${pct(now)} < target ${pct(target)}`)
  if (before !== undefined && now < before - TOLERANCE) failures.push(`${name} ${pct(now)} more than ${pct(TOLERANCE)} below baseline ${pct(before)}`)
  const delta = before === undefined ? '' : ` (baseline ${pct(before)})`
  console.log(`${name.padEnd(18)} ${pct(now)}${delta}${target ? `  target ≥ ${pct(target)}` : ''}`)
}

console.log(`records ${metrics.records} (${answered.length} answered) · claims ${pooled.claims} · citations ${pooled.citations}`)
rate('faithfulness', TARGETS.faithfulness)
rate('citationPrecision', TARGETS.citationPrecision)
rate('answerRelevance')
rate('evidenceCitation')
console.log(`refusals           ${metrics.unanswerableRefused}/${metrics.unanswerable} unanswerable refused, ${metrics.falseRefusals} false refusals  target 5/5, ≤ 1`)
if (metrics.unanswerableRefused < metrics.unanswerable) failures.push(`${metrics.unanswerable - metrics.unanswerableRefused} unanswerable records answered`)
if (metrics.falseRefusals > 1) failures.push(`${metrics.falseRefusals} false refusals`)
console.log(`pipeline           expand ${pipeline.expander} (${pipeline.rewritten} rewritten) · rerank ${pipeline.reranker} (${pipeline.rerankFallbacks} fallbacks) · answered by ${JSON.stringify(pipeline.answeredBy)}`)

if (values['update-baseline']) {
  await writeFile(BASELINE_FILE, `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), metrics, pooled, pipeline }, null, 1)}\n`)
  console.log(`\nwrote ${BASELINE_FILE}`)
}
if (errors.length) failures.push(`${errors.length} errored rows`)
if (failures.length) {
  console.error(`\nLLM eval gate failed:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
}
else {
  console.log('\nLLM eval gate passed')
}
