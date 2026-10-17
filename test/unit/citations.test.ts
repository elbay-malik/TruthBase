import { describe, expect, it } from 'vitest'
import { parseCitations, isRefusal } from '../../server/rag/prompt'
import { splitCitations } from '../../shared/utils/citations'

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

  it('keeps out-of-range markers as plain text', () => {
    expect(splitCitations('See [9] and [0].', 3)).toEqual([{ type: 'text', text: 'See [9] and [0].' }])
  })
})

describe('parseCitations / isRefusal', () => {
  it('returns valid citation numbers in order of first use', () => {
    expect(parseCitations('x [3] y [1][3] z [1, 7]', 5)).toEqual([3, 1])
  })

  it('recognizes the refusal token with stray whitespace or a period', () => {
    expect(isRefusal(' NO_ANSWER.\n')).toBe(true)
    expect(isRefusal('NO_ANSWER is not mentioned [1]')).toBe(false)
  })
})
