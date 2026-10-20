import { describe, expect, it } from 'vitest'
import { decodeVector, encodeVector, vectorLiteral } from '../../scripts/lib/retrieval-fixture'
import { evidenceCitation, refusal } from '../../scripts/promptfoo/assertions'
import { scoreJudgment } from '../../scripts/promptfoo/judge'

describe('retrieval fixture vectors', () => {
  it('round-trips at float32 precision, as pgvector stores them', () => {
    const vector = [0.1, -0.25, 1 / 3, 0]
    const decoded = decodeVector(encodeVector(vector))
    expect(decoded).toHaveLength(4)
    decoded.forEach((x, i) => expect(x).toBe(Math.fround(vector[i]!)))
    expect(vectorLiteral([1, 0.5])).toBe('[1,0.5]')
  })
})

describe('scoreJudgment', () => {
  it('pools claims and citations, ignoring support from sources a claim does not cite', () => {
    const score = scoreJudgment({
      answersQuestion: true,
      claims: [
        { claim: 'a', citations: [1, 2], supportingCitations: [1] }, // supported; 1 of 2 citations
        { claim: 'b', citations: [3], supportingCitations: [4] }, // 4 isn't cited: unsupported
        { claim: 'c', citations: [], supportingCitations: [] }, // uncited: unsupported
      ],
    })
    expect(score).toMatchObject({ claims: 3, supportedClaims: 1, citations: 3, supportingCitations: 1, answersQuestion: true })
    expect(score.faithfulness).toBeCloseTo(1 / 3)
    expect(score.citationPrecision).toBeCloseTo(1 / 3)
  })

  it('treats an answer without factual claims as fully grounded', () => {
    expect(scoreJudgment({ answersQuestion: false, claims: [] })).toMatchObject({ faithfulness: 1, citationPrecision: 1, answersQuestion: false })
  })
})

describe('promptfoo assertions', () => {
  const source = (index: number, content: string) => ({ index, filename: 'csf.pdf', pageNumber: 12, content })
  const ctx = (answerable: boolean, metadata: Record<string, unknown>) => ({
    vars: { question: 'q', answerable, evidence: JSON.stringify([{ document: 'csf.pdf', page: 12, text: 'Tier 1: Partial' }]) },
    metadata,
  })

  it('refusal: passes when answerability and refusal disagree', () => {
    expect(refusal('', ctx(true, { refused: false })).pass).toBe(true)
    expect(refusal('', ctx(true, { refused: true })).reason).toBe('false refusal')
    expect(refusal('', ctx(false, { refused: true })).pass).toBe(true)
    expect(refusal('', ctx(false, { refused: false })).pass).toBe(false)
  })

  it('evidenceCitation: needs a cited source holding a golden span', () => {
    const sources = [source(1, 'Tiers. Tier 1: Partial, Tier 2: Risk Informed'), source(2, 'Profiles')]
    expect(evidenceCitation('', ctx(true, { refused: false, cited: [1, 2], sources }))).toMatchObject({ pass: true, score: 0.5 })
    expect(evidenceCitation('', ctx(true, { refused: false, cited: [2], sources })).pass).toBe(false)
    expect(evidenceCitation('', ctx(true, { refused: true, cited: [], sources })).pass).toBe(true)
  })
})
