// promptfoo assertions for the golden set (ADR-0008). Each returns a
// GradingResult; the aggregate SPEC metrics come from scripts/promptfoo/summary.ts.
//
//   refusal            unanswerable → refused; answerable → not refused
//   evidenceCitation   an answered question cites ≥1 source containing a golden
//                      evidence span (deterministic, no judge)
//   grounded           LLM judge: faithfulness ≥ 0.9, citation precision ≥ 0.9
//                      and the answer addresses the question (SPEC targets)

import { judgeAnswer, type JudgeSource } from './judge'

interface Evidence { document: string, page: number, text: string }
interface Context {
  vars: Record<string, unknown>
  metadata?: Record<string, unknown>
}
interface GradingResult { pass: boolean, score: number, reason: string, namedScores?: Record<string, number> }

const evidenceOf = (ctx: Context): Evidence[] => JSON.parse(String(ctx.vars.evidence ?? '[]'))
const sourcesOf = (ctx: Context): JudgeSource[] => (ctx.metadata?.sources as JudgeSource[] | undefined) ?? []
const refusedOf = (ctx: Context) => ctx.metadata?.refused === true

export function refusal(_output: string, ctx: Context): GradingResult {
  const answerable = ctx.vars.answerable === true || ctx.vars.answerable === 'true'
  const refused = refusedOf(ctx)
  const pass = answerable !== refused
  return { pass, score: pass ? 1 : 0, reason: answerable ? (refused ? 'false refusal' : 'answered') : (refused ? 'refused as expected' : 'answered an unanswerable question') }
}

export function evidenceCitation(_output: string, ctx: Context): GradingResult {
  if (refusedOf(ctx)) return { pass: true, score: 1, reason: 'refused (graded by refusal)' }
  const evidence = evidenceOf(ctx)
  const sources = sourcesOf(ctx)
  const cited = (ctx.metadata?.cited as number[] | undefined) ?? []
  const supporting = cited.filter((n) => {
    const s = sources.find(x => x.index === n)
    return s && evidence.some(e => s.filename === e.document && s.pageNumber === e.page && s.content.includes(e.text))
  })
  const pass = supporting.length > 0
  return { pass, score: cited.length ? supporting.length / cited.length : 0, reason: `${supporting.length}/${cited.length} cited sources contain golden evidence` }
}

export async function grounded(output: string, ctx: Context): Promise<GradingResult> {
  if (refusedOf(ctx)) return { pass: true, score: 1, reason: 'refused (nothing to ground)' }
  const result = await judgeAnswer(String(ctx.vars.question), output, sourcesOf(ctx))
  const pass = result.faithfulness >= 0.9 && result.citationPrecision >= 0.9 && result.answersQuestion
  const unsupported = result.judgment.claims.filter(c => !c.supportingCitations.some(n => c.citations.includes(n))).map(c => c.claim)
  return {
    pass,
    score: (result.faithfulness + result.citationPrecision + (result.answersQuestion ? 1 : 0)) / 3,
    reason: `faithfulness ${result.supportedClaims}/${result.claims}, citation precision ${result.supportingCitations}/${result.citations}, ${result.answersQuestion ? 'answers the question' : 'does NOT answer the question'}`
      + (unsupported.length ? `; unsupported: ${unsupported.map(c => `"${c.slice(0, 80)}"`).join('; ')}` : ''),
    namedScores: { faithfulness: result.faithfulness, citationPrecision: result.citationPrecision, answerRelevance: result.answersQuestion ? 1 : 0 },
  }
}
