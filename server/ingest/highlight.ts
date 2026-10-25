import type { ChunkHighlight, HighlightRect } from '#shared/types'
import { itemRanges } from '../../shared/utils/page-text'
import type { ChunkSpan } from './chunk'
import type { PageLayout } from './extract'

// Phase 3, step 3: chunk character range → per-line highlight rects in PDF
// space (bottom-left origin, scale 1). The viewer converts both corners with
// `viewport.convertToViewportPoint` at draw time (TECH_NOTES §7).
//
// Horizontal edges come from exact per-character glyph positions when the
// glyph replay aligned the item (./glyphs.ts; checked against MuPDF by
// test/unit/ingest-glyphs.test.ts). Otherwise a partially covered item is cut
// proportionally to its character count (off by up to ~3 glyphs).
// Vertical extent is a fixed em-box approximation (checked in the Phase 3.5
// spike; better ink coverage than the PDF.js text layer's box):
// - Glyph boxes span baseline − 0.25·fontSize to baseline + 0.8·fontSize,
//   because PDF.js item.height is often 0 or the full line advance.
// - A covered glyph whose outline (./glyphs.ts) leaves its line rect by more
//   than 0.05·fontSize gets an extra rect of its own: the glyph's advance
//   width, from the line edge to the outline's extreme. TeX math-extension
//   sums hang up to 1.4 em below their baseline (ADR-0004, "Big operators").
//   The line rect itself never grows, so an inline big operator in running
//   text can't make its line overlap the next one; the extra rect overlaps
//   only where the glyph really is.

const DESCENT = 0.25
const ASCENT = 0.8
/** How far (× fontSize) a glyph outline may leave its line rect before it gets its own rect. */
const OUTLINE_OVERHANG = 0.05

/** A covered glyph whose outline leaves its item's em box. */
interface Overhang {
  /** Index of its line rect in `rects`. */
  line: number
  x1: number
  x2: number
  /** Outline bottom / top. */
  y1: number
  y2: number
  size: number
}

export function chunkHighlight(page: PageLayout, span: ChunkSpan): ChunkHighlight {
  const covered = itemRanges(page, span.start, span.end)

  const rects: HighlightRect[] = []
  const overhangs: Overhang[] = []
  let lineY = Number.NaN
  for (const [itemIndex, { from, to }] of covered) {
    const item = page.items[itemIndex]!
    const size = item.fontSize || item.height
    if (item.width <= 0 || size <= 0) continue

    const length = item.str.length

    // Rotated or mirrored text: the box of the covered quad (baseline span ×
    // descent..ascent along the item's own axes), kept as its own rect.
    if (item.rotation) {
      rects.push(rotatedRect(item.x, item.y, item.rotation, item.width * (from / length), item.width * ((to + 1) / length), size))
      lineY = Number.NaN
      continue
    }

    const exactX1 = item.charX0?.[from]
    const exactX2 = item.charX1?.[to]
    const rect: HighlightRect = {
      x1: exactX1 !== undefined && !Number.isNaN(exactX1) ? exactX1 : item.x + item.width * (from / length),
      y1: item.y - DESCENT * size,
      x2: exactX2 !== undefined && !Number.isNaN(exactX2) ? exactX2 : item.x + item.width * ((to + 1) / length),
      y2: item.y + ASCENT * size,
    }

    const line = rects.at(-1)
    const sameLine = line !== undefined
      && Math.abs(item.y - lineY) < 0.5 * size // same baseline
      && rect.x1 >= line.x2 - size // not jumping back to a new line / column
      && rect.x1 - line.x2 < 3 * size // not across a column gutter
    if (sameLine) {
      // x1 too: an item tolerated as a small overlap (< size) can start left
      // of the line's first item.
      line.x1 = Math.min(line.x1, rect.x1)
      line.x2 = Math.max(line.x2, rect.x2)
      line.y1 = Math.min(line.y1, rect.y1)
      line.y2 = Math.max(line.y2, rect.y2)
    }
    else {
      rects.push(rect)
      lineY = item.y
    }

    // Glyphs that leave this item's em box may leave the line rect too; that
    // is decided once the line is complete (a taller item can still join it).
    const { charX0, charX1, charY0, charY1 } = item
    if (charX0 && charX1 && charY0 && charY1) {
      for (let offset = from; offset <= to; offset++) {
        const bottom = charY0[offset]!
        const top = charY1[offset]!
        if (Number.isNaN(bottom) || Number.isNaN(charX0[offset]!)) continue
        if (bottom < rect.y1 - OUTLINE_OVERHANG * size || top > rect.y2 + OUTLINE_OVERHANG * size) {
          overhangs.push({ line: rects.length - 1, x1: charX0[offset]!, x2: charX1[offset]!, y1: bottom, y2: top, size })
        }
      }
    }
  }

  // Each line rect, then the rects of its overhanging glyphs (rare: only TeX
  // big operators on the golden set), so rects stay in reading order.
  const out: HighlightRect[] = []
  for (const [index, line] of rects.entries()) {
    out.push(line)
    for (const glyph of overhangs) {
      if (glyph.line !== index) continue
      if (line.y1 - glyph.y1 > OUTLINE_OVERHANG * glyph.size) out.push({ x1: glyph.x1, y1: glyph.y1, x2: glyph.x2, y2: line.y1 })
      if (glyph.y2 - line.y2 > OUTLINE_OVERHANG * glyph.size) out.push({ x1: glyph.x1, y1: line.y2, x2: glyph.x2, y2: glyph.y2 })
    }
  }

  return {
    pageNumber: page.pageNumber,
    boundingRect: union(out),
    rects: out,
    pageWidth: page.width,
    pageHeight: page.height,
    usePdfCoordinates: true,
    startOffset: span.start,
    endOffset: span.end,
  }
}

/** Axis-aligned box of a run [s0, s1] along a rotated baseline at (x, y). */
function rotatedRect(
  x: number, y: number,
  { ux, uy, nx, ny }: { ux: number, uy: number, nx: number, ny: number },
  s0: number, s1: number, size: number,
): HighlightRect {
  const xs: number[] = []
  const ys: number[] = []
  for (const s of [s0, s1]) {
    for (const t of [-DESCENT * size, ASCENT * size]) {
      xs.push(x + ux * s + nx * t)
      ys.push(y + uy * s + ny * t)
    }
  }
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
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
