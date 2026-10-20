import { describe, expect, it } from 'vitest'
import type { PageLayout, PositionedItem } from '../../server/ingest/extract'
import { chunkHighlight } from '../../server/ingest/highlight'
import { normalizePageText } from '../../shared/utils/page-text'

// chunkHighlight on synthetic layouts: every geometry rule in isolation.
// test/unit/ingest-glyphs.test.ts checks the same code against MuPDF on the
// golden PDFs. Items are 5 pt per character at font size 10, so a rect spans
// baseline − 2.5 to baseline + 8 (DESCENT 0.25, ASCENT 0.8).

const item = (str: string, x: number, y: number, extra: Partial<PositionedItem> = {}): PositionedItem =>
  ({ str, x, y, width: 5 * str.length, height: 10, fontSize: 10, hasEOL: false, ...extra })

function layout(items: PositionedItem[]): PageLayout {
  return { pageNumber: 3, width: 600, height: 800, items, glyphAlignedItems: 0, ...normalizePageText(items) }
}

/** Highlight of the first occurrence of `quote` in the page text. */
function highlightOf(page: PageLayout, quote: string) {
  const start = page.text.indexOf(quote)
  expect(start).toBeGreaterThanOrEqual(0)
  return chunkHighlight(page, { start, end: start + quote.length })
}

describe('chunkHighlight', () => {
  it('covers a whole item with one em-box rect and carries the page metadata', () => {
    const page = layout([item('Backups', 100, 700)])
    expect(chunkHighlight(page, { start: 0, end: 7 })).toEqual({
      pageNumber: 3,
      boundingRect: { x1: 100, y1: 697.5, x2: 135, y2: 708 },
      rects: [{ x1: 100, y1: 697.5, x2: 135, y2: 708 }],
      pageWidth: 600,
      pageHeight: 800,
      usePdfCoordinates: true,
      startOffset: 0,
      endOffset: 7,
    })
  })

  it('cuts a partially covered item proportionally by character count', () => {
    const page = layout([item('abcdefghij', 100, 700)])
    expect(chunkHighlight(page, { start: 2, end: 5 }).rects).toEqual([{ x1: 110, y1: 697.5, x2: 125, y2: 708 }])
    // A single character at either end of the item.
    expect(chunkHighlight(page, { start: 0, end: 1 }).rects[0]).toMatchObject({ x1: 100, x2: 105 })
    expect(chunkHighlight(page, { start: 9, end: 10 }).rects[0]).toMatchObject({ x1: 145, x2: 150 })
  })

  it('prefers exact glyph positions and falls back per edge where they are NaN', () => {
    const exact = item('abcd', 100, 700, {
      charX0: Float64Array.from([100, 103, 111, 114]),
      charX1: Float64Array.from([103, 111, 114, 120]),
    })
    expect(chunkHighlight(layout([exact]), { start: 1, end: 3 }).rects[0]).toMatchObject({ x1: 103, x2: 114 })

    const partial = item('abcd', 100, 700, {
      charX0: Float64Array.from([100, Number.NaN, 111, 114]),
      charX1: Float64Array.from([103, 111, Number.NaN, 120]),
    })
    // Start falls back to 100 + 20 · 1/4, end to 100 + 20 · 3/4.
    expect(chunkHighlight(layout([partial]), { start: 1, end: 3 }).rects[0]).toMatchObject({ x1: 105, x2: 115 })
  })

  it('merges items on one baseline into one line rect, tolerating baseline jitter and mixed sizes', () => {
    const page = layout([
      item('Risk', 100, 700),
      item(' is', 120, 701), // superscript-ish jitter < 0.5 · size
      item(' high', 135, 700, { fontSize: 20, width: 25 }),
    ])
    const { rects } = highlightOf(page, 'Risk is high')
    expect(rects).toEqual([{ x1: 100, y1: 695, x2: 160, y2: 716 }])
  })

  it('starts a new rect on a new baseline and unions them in boundingRect', () => {
    const page = layout([item('first line', 100, 700, { hasEOL: true }), item('second', 100, 686)])
    const highlight = highlightOf(page, 'line second')
    expect(highlight.rects).toEqual([
      { x1: 130, y1: 697.5, x2: 150, y2: 708 },
      { x1: 100, y1: 683.5, x2: 130, y2: 694 },
    ])
    expect(highlight.boundingRect).toEqual({ x1: 100, y1: 683.5, x2: 150, y2: 708 })
  })

  it('splits a line across a column gutter of 3 · size or more', () => {
    // "left" ends at 120; the next item starts 30 pt (split) or 29.9 pt (merged) later.
    const split = layout([item('left', 100, 700, { hasEOL: true }), item('right', 150, 700)])
    expect(highlightOf(split, 'left right').rects).toHaveLength(2)
    const merged = layout([item('left', 100, 700, { hasEOL: true }), item('right', 149.9, 700)])
    expect(highlightOf(merged, 'left right').rects).toHaveLength(1)
  })

  it('starts a new rect when the next item jumps back left on the same baseline', () => {
    // Reading order continues in another column whose line shares the baseline.
    const page = layout([item('column two', 300, 700, { hasEOL: true }), item('column one', 100, 700)])
    const { rects } = highlightOf(page, 'two column')
    expect(rects.map(r => [r.x1, r.x2])).toEqual([[335, 350], [100, 130]])
  })

  it('tolerates a small overlap with the previous item (kerned or overprinted runs)', () => {
    const page = layout([item('ab', 100, 700, { hasEOL: true }), item('cd', 105, 700)]) // starts 5 pt (< size) before "ab" ends
    expect(highlightOf(page, 'ab cd').rects).toEqual([{ x1: 100, y1: 697.5, x2: 115, y2: 708 }])
  })

  it('keeps the line right edge as a running max when an item ends inside the previous one', () => {
    // "x" (121–126) is overprinted inside "abcdef" (100–130): the line still ends at 130.
    const inside = layout([item('abcdef', 100, 700, { hasEOL: true }), item('x', 121, 700)])
    expect(highlightOf(inside, 'abcdef x').rects).toEqual([{ x1: 100, y1: 697.5, x2: 130, y2: 708 }])
    // "z" at 158 is 28 pt past 130 (merge) but 32 pt past 126 (would split).
    const after = layout([item('abcdef', 100, 700, { hasEOL: true }), item('x', 121, 700, { hasEOL: true }), item('zz', 158, 700)])
    expect(highlightOf(after, 'abcdef x zz').rects).toEqual([{ x1: 100, y1: 697.5, x2: 168, y2: 708 }])
  })

  it('boxes a rotated item along its own axes and never merges it into a line', () => {
    // Text running up the page (90°): baseline along +y, ascender towards −x.
    const up = { ux: 0, uy: 1, nx: -1, ny: 0 }
    const page = layout([item('abcd', 50, 100, { rotation: up, hasEOL: true }), item('next', 50, 100)])
    const { rects } = chunkHighlight(page, { start: 0, end: page.text.length })
    expect(rects).toHaveLength(2)
    expect(rects[0]).toEqual({ x1: 42, y1: 100, x2: 52.5, y2: 120 })
    // Partial cover follows the baseline: characters 1..2 → s ∈ [5, 15].
    expect(chunkHighlight(page, { start: 1, end: 3 }).rects).toEqual([{ x1: 42, y1: 105, x2: 52.5, y2: 115 }])
  })

  it('handles a 180° item (upside-down) with a non-inverted box', () => {
    const flipped = { ux: -1, uy: 0, nx: 0, ny: -1 }
    const page = layout([item('ab', 200, 500, { rotation: flipped })])
    expect(chunkHighlight(page, { start: 0, end: 2 }).rects).toEqual([{ x1: 190, y1: 492, x2: 200, y2: 502.5 }])
  })

  it('skips zero-width and zero-size items, falling back to height when fontSize is 0', () => {
    const page = layout([
      item('ghost', 100, 700, { width: 0, hasEOL: true }),
      item('void', 100, 680, { fontSize: 0, height: 0, hasEOL: true }),
      item('tall', 100, 660, { fontSize: 0, height: 20 }),
    ])
    const { rects } = chunkHighlight(page, { start: 0, end: page.text.length })
    expect(rects).toEqual([{ x1: 100, y1: 655, x2: 120, y2: 676 }])
  })

  it('returns no rects and a zero bounding box for an empty span or one covering only a separator', () => {
    const page = layout([item('ab', 100, 700, { hasEOL: true }), item('cd', 200, 700)])
    expect(page.text).toBe('ab cd')
    for (const span of [{ start: 1, end: 1 }, { start: 2, end: 3 }]) {
      const highlight = chunkHighlight(page, span)
      expect(highlight.rects).toEqual([])
      expect(highlight.boundingRect).toEqual({ x1: 0, y1: 0, x2: 0, y2: 0 })
    }
  })

  it('ignores the separator space at either edge of the span', () => {
    const page = layout([item('ab', 100, 700, { hasEOL: true }), item('cd', 110, 700)])
    expect(chunkHighlight(page, { start: 2, end: 5 }).rects).toEqual([{ x1: 110, y1: 697.5, x2: 120, y2: 708 }])
  })

  it('keeps every rect well-formed and inside the item hull on a multi-line page', () => {
    const lines = Array.from({ length: 6 }, (_, i) => item(`Line ${i} of the paragraph text.`, 72, 700 - 14 * i, { hasEOL: true }))
    const page = layout(lines)
    const { rects, boundingRect } = chunkHighlight(page, { start: 3, end: page.text.length - 4 })
    expect(rects).toHaveLength(6)
    for (const r of rects) {
      expect(r.x2).toBeGreaterThan(r.x1)
      expect(r.y2).toBeGreaterThan(r.y1)
      expect(r.x1).toBeGreaterThanOrEqual(72)
      expect(r.x2).toBeLessThanOrEqual(72 + lines[0]!.width)
    }
    // Lines stack top to bottom in reading order.
    for (let i = 1; i < rects.length; i++) expect(rects[i]!.y2).toBeLessThan(rects[i - 1]!.y2)
    expect(boundingRect.y1).toBe(rects.at(-1)!.y1)
    expect(boundingRect.y2).toBe(rects[0]!.y2)
  })
})
