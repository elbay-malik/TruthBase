import { describe, expect, it } from 'vitest'
import { parseCitations, isRefusal } from '../../server/rag/prompt'
import { claimSentence, looksLikeRefusalPrefix, splitCitations, stripEmphasis } from '../../shared/utils/citations'

describe('splitCitations', () => {
  it('splits text and adjacent / comma-separated markers', () => {
    expect(splitCitations('A [1][3]. B [2, 4].', 4)).toEqual([
      { type: 'text', text: 'A ' },
      { type: 'cite', index: 1 },
      { type: 'cite', index: 3 },
      { type: 'text', text: '. B ' },
      { type: 'cite', index: 2 },
      { type: 'cite', index: 4 },
      { type: 'text', text: '.' },
    ])
  })

  it('accepts gpt-oss native markers 【n】 and 【n†…】', () => {
    expect(splitCitations('GOVERN【6】 and DETECT【3†L4-L7】.', 6)).toEqual([
      { type: 'text', text: 'GOVERN' },
      { type: 'cite', index: 6 },
      { type: 'text', text: ' and DETECT' },
      { type: 'cite', index: 3 },
      { type: 'text', text: '.' },
    ])
  })

  it('keeps out-of-range markers as plain text', () => {
    expect(splitCitations('See [9] and [0].', 3)).toEqual([{ type: 'text', text: 'See [9] and [0].' }])
  })

  it('expands short ranges and keeps the valid numbers of a mixed marker', () => {
    expect(parseCitations('x [1-3] y [2–4]', 5)).toEqual([1, 2, 3, 4])
    expect(parseCitations('x [2, 9]', 3)).toEqual([2])
    expect(parseCitations('x [1-40]', 50)).toEqual([]) // not a citation list
  })

  it('ignores brackets glued to a word, also when chained', () => {
    expect(parseCitations('arr[1] and m[1][2] are indexes', 3)).toEqual([])
    expect(parseCitations('end.[1][2]', 3)).toEqual([1, 2])
    expect(parseCitations('Set arr[1] = x[2] then call f(my_var[3]).', 3)).toEqual([])
  })

  it('accepts markers glued to a number, or to a word at the end of a clause', () => {
    expect(parseCitations('Defined as PR.DS-11[2]. In CSF 2.0[1] and in 2024[3] too.', 3)).toEqual([2, 1, 3])
    expect(parseCitations('There are four tiers[1][2]. Each has a profile[3], see below', 3)).toEqual([1, 2, 3])
    expect(parseCitations('Four tiers[1] exist', 3)).toEqual([]) // mid-clause: could be an index
    expect(parseCitations('The GOVERN function sets policy[1]', 3)).toEqual([1])
    expect(parseCitations('- Govern[1]\n- Map[2]\n- Measure[3]', 3)).toEqual([1, 2, 3])
    expect(parseCitations('Each has a profile[1]), done. It says "set policies[2]"', 3)).toEqual([1, 2])
  })
})

describe('stripEmphasis', () => {
  it('unwraps bold but leaves operators and identifiers alone', () => {
    expect(stripEmphasis('The **GOVERN** and **DETECT** functions [1].')).toBe('The GOVERN and DETECT functions [1].')
    expect(stripEmphasis('2 * 3 and snake_case_name')).toBe('2 * 3 and snake_case_name')
    expect(stripEmphasis('x**2 + y**2 and __init__ and f(**kwargs)')).toBe('x**2 + y**2 and __init__ and f(**kwargs)')
    expect(stripEmphasis('**a\nb**')).toBe('**a\nb**') // never across lines
  })
})

describe('parseCitations / isRefusal', () => {
  it('returns valid citation numbers in order of first use', () => {
    expect(parseCitations('x [3] y [1][3] z [1, 7]', 5)).toEqual([3, 1])
    expect(parseCitations('a【2】 b【4†L1】', 5)).toEqual([2, 4])
  })

  it('recognizes the refusal token with stray whitespace, punctuation or emphasis', () => {
    expect(isRefusal(' NO_ANSWER.\n')).toBe(true)
    expect(isRefusal('**NO_ANSWER**')).toBe(true)
    expect(isRefusal('`NO_ANSWER`.')).toBe(true)
  })

  it('treats a refusal followed by an uncited explanation as a refusal', () => {
    expect(isRefusal('NO_ANSWER — the sources only discuss pricing.', 3)).toBe(true)
  })

  it('is not a refusal when it cites a valid source or does not start with the token', () => {
    expect(isRefusal('NO_ANSWER is not mentioned [1]', 1)).toBe(false)
    expect(isRefusal('NO_ANSWER is not mentioned [4]', 3)).toBe(true) // [4] is not a valid source
    expect(isRefusal('The answer is NO_ANSWER', 3)).toBe(false)
  })

  it('spots a partially streamed refusal token', () => {
    expect(looksLikeRefusalPrefix('NO_ANS')).toBe(true)
    expect(looksLikeRefusalPrefix('**NO_')).toBe(true)
    expect(looksLikeRefusalPrefix('NO_ANSWER')).toBe(true)
    expect(looksLikeRefusalPrefix('No, the')).toBe(false)
    expect(looksLikeRefusalPrefix('')).toBe(false)
  })
})

describe('claimSentence', () => {
  const claim = (answer: string, index: number) => claimSentence(splitCitations(answer, 4), index)

  it('returns the sentence carrying the chip, without markers', () => {
    const answer = 'The CSF has six Functions [1]. Recovery restores assets [2][3]. Backups are verified before use [3].'
    expect(claim(answer, 1)).toBe('The CSF has six Functions.')
    expect(claim(answer, 2)).toBe('Recovery restores assets.')
    // The first sentence citing it.
    expect(claim(answer, 3)).toBe('Recovery restores assets.')
  })

  it('keeps the rest of a sentence cited mid-way, and decimals inside it', () => {
    expect(claim('CSF 2.0 adds Govern [1] and keeps Identify [2]. Next.', 1)).toBe('CSF 2.0 adds Govern and keeps Identify.')
  })

  it('stops at line breaks and drops list bullets', () => {
    expect(claim('Functions:\n- Govern sets strategy [1]\n- Identify [2]', 1)).toBe('Govern sets strategy')
    expect(claim('Steps:\n1. Cluster the chunks [4].\n2. Summarize.', 4)).toBe('Cluster the chunks.')
  })

  it('takes the sentence a chip follows when it comes after the full stop', () => {
    const answer = '“In total, we use 150k pairs.” [1] “We use 145,619 instances.” [2]'
    expect(claim(answer, 1)).toBe('“In total, we use 150k pairs.”')
    expect(claim(answer, 2)).toBe('“We use 145,619 instances.”')
    expect(claim('Backups are verified. [3] Next one.', 3)).toBe('Backups are verified.')
  })

  it('is empty when the answer does not cite the index', () => {
    expect(claim('No citations here.', 1)).toBe('')
  })
})
