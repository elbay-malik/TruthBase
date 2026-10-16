import type { ChunkHighlight, HighlightRect } from '#shared/types'
import type { ChunkSpan } from './chunk'
import type { PageLayout } from './extract'

// Phase 3, step 3: chunk character range → per-line highlight rects in PDF
// space (bottom-left origin, scale 1). The viewer converts them with
// `viewport.convertToViewportRectangle` at draw time (shared/types).
//
// Approximations, checked visually by `pnpm render:highlights`:
// - A partially covered item is cut proportionally to its character count
//   (fine for proportional fonts at line scale; off by a glyph at worst).
// - Glyph boxes span baseline − 0.25·fontSize to baseline + 0.8·fontSize,
//   because PDF.js item.height is often 0 or the full line advance.

const DESCENT = 0.25
const ASCENT = 0.8

export function chunkHighlight(page: PageLayout, span: ChunkSpan): ChunkHighlight {
  // Covered character range inside each item touched by the span.
  const covered = new Map<number, { from: number, to: number }>()
  for (let i = span.start; i < span.end; i++) {
    const itemIndex = page.charItem[i]!
    if (itemIndex === -1) continue
    const offset = page.charOffset[i]!
    const range = covered.get(itemIndex)
    if (range) range.to = offset
    else covered.set(itemIndex, { from: offset, to: offset })
  }

  const rects: HighlightRect[] = []
  let lineY = Number.NaN
  for (const [itemIndex, { from, to }] of covered) {
    const item = page.items[itemIndex]!
    const size = item.fontSize || item.height
    if (item.width <= 0 || size <= 0) continue

    const length = item.str.length
    const rect: HighlightRect = {
      x1: item.x + item.width * (from / length),
      y1: item.y - DESCENT * size,
      x2: item.x + item.width * ((to + 1) / length),
      y2: item.y + ASCENT * size,
    }

    const line = rects.at(-1)
    const sameLine = line !== undefined
      && Math.abs(item.y - lineY) < 0.5 * size // same baseline
      && rect.x1 >= line.x2 - size // not jumping back to a new line / column
      && rect.x1 - line.x2 < 3 * size // not across a column gutter
    if (sameLine) {
      line.x2 = Math.max(line.x2, rect.x2)
      line.y1 = Math.min(line.y1, rect.y1)
      line.y2 = Math.max(line.y2, rect.y2)
    }
    else {
      rects.push(rect)
      lineY = item.y
    }
  }

  return {
    pageNumber: page.pageNumber,
    boundingRect: union(rects),
    rects,
    pageWidth: page.width,
    pageHeight: page.height,
    usePdfCoordinates: true,
    startOffset: span.start,
    endOffset: span.end,
  }
}

function union(rects: HighlightRect[]): HighlightRect {
  if (rects.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 }
  return {
    x1: Math.min(...rects.map(r => r.x1)),
    y1: Math.min(...rects.map(r => r.y1)),
    x2: Math.max(...rects.map(r => r.x2)),
    y2: Math.max(...rects.map(r => r.y2)),
  }
}
