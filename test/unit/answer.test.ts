import { describe, expect, it } from 'vitest'
import { answerBlocks, tidySegments } from '../../app/utils/answer'
import type { AnswerSegment } from '../../shared/utils/citations'

const t = (text: string): AnswerSegment => ({ type: 'text', text })
const c = (index: number): AnswerSegment => ({ type: 'cite', index })

describe('tidySegments', () => {
  it('drops the space between a chip and the punctuation after it', () => {
    expect(tidySegments([t('layers of the tree'), c(1), t(' . Next'), c(2), t(' clause')]))
      .toEqual([t('layers of the tree'), c(1), t('. Next'), c(2), t(' clause')])
  })

  it('collapses runs of spaces but keeps line breaks', () => {
    expect(tidySegments([t('text  embedding.\n\nThe  clustering')])).toEqual([t('text embedding.\n\nThe clustering')])
  })
})

describe('answerBlocks', () => {
  it('turns marker lines into a list, with chips inside the items', () => {
    expect(answerBlocks([t('The Functions:\n- GOVERN'), c(2), t('\n- DETECT'), c(3)])).toEqual([
      { type: 'p', lines: [[t('The Functions:')]] },
      { type: 'ul', items: [[t('GOVERN'), c(2)], [t('DETECT'), c(3)]] },
    ])
  })

  it('numbers a list that the model numbered, and splits paragraphs at blank lines', () => {
    expect(answerBlocks([t('1. First\n2) Second\n\nAfter.\nSame paragraph.')])).toEqual([
      { type: 'ol', items: [[t('First')], [t('Second')]] },
      { type: 'p', lines: [[t('After.')], [t('Same paragraph.')]] },
    ])
  })

  it('keeps a hyphen inside a sentence, and a chip-only item', () => {
    expect(answerBlocks([t('Risk - as defined - is measured.')])).toEqual([{ type: 'p', lines: [[t('Risk - as defined - is measured.')]] }])
    expect(answerBlocks([t('- '), c(1)])).toEqual([{ type: 'ul', items: [[c(1)]] }])
  })
})
