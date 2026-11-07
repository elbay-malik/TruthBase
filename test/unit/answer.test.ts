import { describe, expect, it } from 'vitest'
import { answerBlocks, dropPartialMarker, sharedChunkId, tidySegments } from '../../app/utils/answer'
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

describe('dropPartialMarker', () => {
  it('drops a citation marker still streaming in, with the space before it', () => {
    expect(dropPartialMarker('layers of the tree [1')).toBe('layers of the tree')
    expect(dropPartialMarker('layers of the tree [1, 2–')).toBe('layers of the tree')
    expect(dropPartialMarker('layers of the tree\n[')).toBe('layers of the tree')
    expect(dropPartialMarker('layers of the tree 【2†sou')).toBe('layers of the tree')
    expect(dropPartialMarker('tree 【1】 and 【2† [3')).toBe('tree 【1】 and')
  })

  it('keeps finished markers and brackets that are not citations', () => {
    expect(dropPartialMarker('layers of the tree [1].')).toBe('layers of the tree [1].')
    expect(dropPartialMarker('tree 【1†source】')).toBe('tree 【1†source】')
    expect(dropPartialMarker('see [the appendix')).toBe('see [the appendix')
    expect(dropPartialMarker('no marker at all  ')).toBe('no marker at all  ')
  })

  it('removes what the single regex it replaces removed, for every short string', () => {
    const legacy = (text: string) => text.replace(/\s*(?:\[[\d\s,，\-–]*|【[^】]*)$/, '')
    const alphabet = ['a', ' ', '[', '1', ',', '【', '】']
    let strings = ['']
    for (let length = 1; length <= 5; length++) {
      strings = strings.flatMap(s => alphabet.map(ch => s + ch))
      for (const text of strings) expect(dropPartialMarker(text), JSON.stringify(text)).toBe(legacy(text))
    }
  })

  it('stays linear on a long run of whitespace', () => {
    const text = `a${' '.repeat(100_000)}b`
    const started = performance.now()
    expect(dropPartialMarker(text)).toBe(text)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('sharedChunkId', () => {
  it('takes an id, never a path to another route', () => {
    expect(sharedChunkId('0f8e2c1a-4b7d-4e3a-9c2b-5d6e7f8a9b0c')).toBe('0f8e2c1a-4b7d-4e3a-9c2b-5d6e7f8a9b0c')
    expect(sharedChunkId('c9')).toBe('c9')
    for (const value of ['../health', '..', 'c9/../../health', 'c9?x=1', 'c9#x', '%2e%2e', '', ['c9'], undefined, null]) {
      expect(sharedChunkId(value), JSON.stringify(value)).toBeUndefined()
    }
  })
})
