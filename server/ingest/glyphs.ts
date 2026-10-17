import type { PDFPageProxy } from 'unpdf/pdfjs'
import { getResolvedPDFJS } from 'unpdf'
import type { PositionedItem } from './extract'

// Exact per-character x-positions for text items (Phase 3.5 finding, ADR-0004).
//
// PDF.js text items only give an item's start and total width, so a highlight
// that starts or ends inside an item had to cut it proportionally by character
// count — off by up to ~3 glyphs (15.6 pt on the golden set, vs MuPDF). Here we
// replay PDF.js's own showText advance math over the page's operator list
// (text matrix, Tc/Tw/Tz, TJ kerning, font matrix) to get every glyph's x
// extent, then align glyphs to items.
//
// An item gets per-character positions only when the alignment reproduces the
// item's own start and width; otherwise (rotated or vertical text, Type3
// oddities, ligature mismatches) it keeps the proportional cut as a fallback.

interface Glyph {
  /** Unicode of the glyph (may be several chars for a ligature). */
  unicode: string
  x0: number
  x1: number
  /** Baseline y in PDF space. */
  y: number
  font: string
}

type Matrix = [number, number, number, number, number, number]

interface TextState {
  ctm: Matrix
  tm: Matrix
  x: number
  y: number
  lineX: number
  lineY: number
  charSpacing: number
  wordSpacing: number
  hScale: number
  leading: number
  font: string
  size: number
  rise: number
  fontScale: number
  vertical: boolean
  /** -1 after a negative Tf size (PDF.js fontDirection): text advances leftwards. */
  direction: number
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
/** Edge tolerance (pt) for accepting an item's alignment against its own geometry. */
const ALIGN_TOLERANCE = 0.5

const toMatrix = (args: unknown): Matrix => {
  const a = args as ArrayLike<number> & { 0?: ArrayLike<number> }
  const m = a[0] !== undefined && typeof a[0] === 'object' ? a[0] : a
  return [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!]
}

/** Replays showText advances over the operator list → positioned glyphs. */
async function pageGlyphs(page: PDFPageProxy): Promise<Glyph[]> {
  const { OPS, Util } = await getResolvedPDFJS()
  const ops = await page.getOperatorList()
  const glyphs: Glyph[] = []
  let st: TextState = {
    ctm: [...IDENTITY], tm: [...IDENTITY], x: 0, y: 0, lineX: 0, lineY: 0,
    charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, font: '', size: 0, rise: 0, fontScale: 0.001, vertical: false, direction: 1,
  }
  const stack: TextState[] = []
  const apply = (m: Matrix, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as const
  // Mirrors CanvasGraphics.setFont: a negative size flips the text direction.
  const setFont = (name: string, size: number) => {
    st.font = name
    st.size = Math.abs(size)
    st.direction = size < 0 ? -1 : 1
    let font: { fontMatrix?: number[], vertical?: boolean } | undefined
    try {
      font = page.commonObjs.get(name)
    }
    catch { /* font not resolved: keep defaults */ }
    st.fontScale = font?.fontMatrix?.[0] ?? 0.001
    st.vertical = Boolean(font?.vertical)
  }

  for (let k = 0; k < ops.fnArray.length; k++) {
    const args = ops.argsArray[k] as unknown[]
    switch (ops.fnArray[k]) {
      case OPS.save: stack.push({ ...st }); break
      case OPS.restore: st = stack.pop() ?? st; break
      case OPS.transform: st.ctm = Util.transform(st.ctm, toMatrix(args)) as Matrix; break
      case OPS.paintFormXObjectBegin:
        stack.push({ ...st })
        if (args[0]) st.ctm = Util.transform(st.ctm, toMatrix(args[0])) as Matrix
        break
      case OPS.paintFormXObjectEnd: st = stack.pop() ?? st; break
      case OPS.beginText: st.tm = [...IDENTITY]; st.x = st.lineX = st.y = st.lineY = 0; break
      case OPS.setCharSpacing: st.charSpacing = args[0] as number; break
      case OPS.setWordSpacing: st.wordSpacing = args[0] as number; break
      case OPS.setHScale: st.hScale = (args[0] as number) / 100; break
      case OPS.setLeading: st.leading = -(args[0] as number); break
      case OPS.setTextRise: st.rise = args[0] as number; break
      case OPS.setFont: setFont(args[0] as string, args[1] as number); break
      case OPS.setGState:
        // An ExtGState /Font entry arrives as ["Font", [name, size]] (gs operator).
        for (const [key, value] of args[0] as [string, unknown][]) {
          if (key === 'Font') setFont((value as [string, number])[0], (value as [string, number])[1])
        }
        break
      case OPS.moveText:
        st.x = st.lineX += args[0] as number
        st.y = st.lineY += args[1] as number
        break
      case OPS.setLeadingMoveText:
        st.leading = args[1] as number
        st.x = st.lineX += args[0] as number
        st.y = st.lineY += args[1] as number
        break
      case OPS.setTextMatrix: st.tm = toMatrix(args); st.x = st.lineX = st.y = st.lineY = 0; break
      case OPS.nextLine: st.x = st.lineX; st.y = st.lineY += st.leading; break
      case OPS.showText: {
        // Mirrors CanvasGraphics.showText (pdfjs-dist 6.4.299, pdf.mjs ~12196-12336).
        const m = Util.transform(st.ctm, st.tm) as Matrix
        const scale = st.fontScale * st.size // widthAdvanceScale
        const hScale = st.hScale * st.direction
        const spacingDir = st.vertical ? 1 : -1
        let advance = 0
        for (const g of args[0] as (number | { unicode?: string, width: number, isSpace?: boolean, vmetric?: number[] } | null)[]) {
          if (typeof g === 'number') {
            advance += spacingDir * g * st.size / 1000 // TJ adjustment, thousandths of text space
            continue
          }
          if (!g) continue
          const spacing = ((g.isSpace ? st.wordSpacing : 0) + st.charSpacing) * st.direction
          if (st.vertical) {
            // Vertical writing: advance down the column; no glyphs are recorded,
            // so these items keep the proportional cut.
            advance += -(g.vmetric?.[0] ?? -g.width) * scale - spacing
            continue
          }
          const [x0, y] = apply(m, st.x + advance * hScale, st.y + st.rise)
          const [x1] = apply(m, st.x + (advance + g.width * scale) * hScale, st.y + st.rise)
          glyphs.push({ unicode: g.unicode ?? '', x0: Math.min(x0, x1), x1: Math.max(x0, x1), y, font: st.font })
          advance += g.width * scale + spacing
        }
        if (st.vertical) st.y -= advance
        else st.x += advance * hScale
        break
      }
    }
  }
  return glyphs
}

/**
 * Attaches `charX0`/`charX1` (per character of `item.str`) to every item whose
 * glyphs align exactly; other items are left untouched (proportional fallback).
 * Returns the number of items that received exact positions.
 */
export async function attachGlyphPositions(page: PDFPageProxy, items: PositionedItem[], fontNames: string[]): Promise<number> {
  const glyphs = await pageGlyphs(page)
  const byFont = Map.groupBy(glyphs, g => g.font)
  let aligned = 0

  items.forEach((item, index) => {
    const size = item.fontSize || item.height
    if (!item.str.trim() || size <= 0 || item.width <= 0) return
    const candidates = (byFont.get(fontNames[index]!) ?? []).filter(g =>
      Math.abs(g.y - item.y) < 0.3 * size
      && g.x0 >= item.x - ALIGN_TOLERANCE
      && g.x0 <= item.x + item.width + ALIGN_TOLERANCE
      && g.unicode.trim() !== '')

    // Expand ligature glyphs ("fi") into per-character slices, in NFKC form so
    // they compare with the text item's characters.
    const sequence = candidates.flatMap((g) => {
      const chars = [...g.unicode.normalize('NFKC')]
      const w = (g.x1 - g.x0) / chars.length
      return chars.map((ch, j) => ({ ch, x0: g.x0 + w * j, x1: g.x0 + w * (j + 1) }))
    })

    const x0 = new Float64Array(item.str.length).fill(Number.NaN)
    const x1 = new Float64Array(item.str.length).fill(Number.NaN)
    let next = 0
    for (let offset = 0; offset < item.str.length; offset++) {
      const ch = item.str[offset]!
      if (/\s/.test(ch)) continue
      let q = next
      while (q < sequence.length && sequence[q]!.ch !== ch.normalize('NFKC')) q++
      if (q >= sequence.length || q - next >= 3) return // misaligned: keep proportional cut
      x0[offset] = sequence[q]!.x0
      x1[offset] = sequence[q]!.x1
      next = q + 1
    }

    // Accept only if the glyphs reproduce the item's own extent.
    const first = x0.findIndex(v => !Number.isNaN(v))
    const last = x1.findLastIndex(v => !Number.isNaN(v))
    if (first === -1) return
    // Leading/trailing spaces take up advance width inside the item, so with
    // them the outer glyphs only need to lie within the item's extent.
    const itemEnd = item.x + item.width
    const startsAtItem = first > 0
      ? x0[first]! >= item.x - ALIGN_TOLERANCE
      : Math.abs(x0[first]! - item.x) <= ALIGN_TOLERANCE
    const endsAtItem = last < item.str.length - 1
      ? x1[last]! <= itemEnd + ALIGN_TOLERANCE
      : Math.abs(x1[last]! - itemEnd) <= ALIGN_TOLERANCE
    if (!startsAtItem || !endsAtItem) return

    item.charX0 = x0
    item.charX1 = x1
    aligned++
  })
  return aligned
}
