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
//
// The same replay also gives each glyph its outline's vertical extent
// (ADR-0004, "Big operators"). With font faces disabled (./extract.ts), the
// getOperatorList call below makes PDF.js compile every shown glyph's outline
// and send it to this thread as the common object
// `${font.loadedName}_path_${glyph.fontChar}`: path commands in em units with
// the font matrix applied, y up. highlight.ts uses the extent only where a
// glyph leaves the fixed em box by a margin (TeX math-extension sums hang up
// to 1.4 em below their baseline).

interface Glyph {
  /** Unicode of the glyph (may be several chars for a ligature). */
  unicode: string
  x0: number
  x1: number
  /** Baseline y in PDF space. */
  y: number
  /** Outline extent in PDF space (bottom, top); NaN without an outline. */
  y0: number
  y1: number
  font: string
  /** Emission order in the content stream (alignment relies on it). */
  seq: number
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
  /** The font's loadedName: the prefix of its glyph outline objects. */
  loadedName: string
  /** Type3 glyphs are drawn from their own operator lists, not outlines. */
  type3: boolean
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

/** Outline y-range (em units) per `${loadedName}_path_${fontChar}`; null: no outline. */
type OutlineCache = Map<string, readonly [number, number] | null>
/**
 * Keyed by the document's commonObjs (shared by its pages, dropped with it):
 * loadedNames ("g_d1_f15") restart in every document, so a module-wide cache
 * could hand one PDF another PDF's outlines.
 */
const outlineCaches = new WeakMap<object, OutlineCache>()

/** Path command codes in a FontPath buffer (PDF.js DrawOPS). */
const MOVE_TO = 0
const LINE_TO = 1
const CURVE_TO = 2
const QUADRATIC_CURVE_TO = 3
const CLOSE_PATH = 4

/**
 * Exact y-range of a glyph outline: segment end points plus the y-extrema of
 * its Bézier curves (control points alone would overstate round glyphs).
 * Undefined for an empty or unreadable path.
 */
export function outlineYRange(path: ArrayLike<number>): [number, number] | undefined {
  let lo = Infinity
  let hi = -Infinity
  let y0 = 0
  const see = (y: number) => {
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  // A 1-D cubic Bézier at t, for the y-extrema found below.
  const cubicAt = (t: number, a: number, b: number, c: number, d: number) => {
    const u = 1 - t
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
  }
  for (let i = 0; i < path.length;) {
    switch (path[i++]) {
      case MOVE_TO:
      case LINE_TO:
        y0 = path[i + 1]!
        see(y0)
        i += 2
        break
      case CURVE_TO: {
        const [y1, y2, y3] = [path[i + 1]!, path[i + 3]!, path[i + 5]!]
        i += 6
        see(y3)
        // d/dt of the cubic, divided by 3: a·t² + b·t + c.
        const a = -y0 + 3 * y1 - 3 * y2 + y3
        const b = 2 * (y0 - 2 * y1 + y2)
        const c = y1 - y0
        const roots: number[] = []
        if (Math.abs(a) < 1e-12) {
          if (Math.abs(b) > 1e-12) roots.push(-c / b)
        }
        else {
          const disc = b * b - 4 * a * c
          if (disc >= 0) roots.push((-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a))
        }
        for (const t of roots) if (t > 0 && t < 1) see(cubicAt(t, y0, y1, y2, y3))
        y0 = y3
        break
      }
      case QUADRATIC_CURVE_TO: {
        const [y1, y2] = [path[i + 1]!, path[i + 3]!]
        i += 4
        see(y2)
        const den = y0 - 2 * y1 + y2
        if (Math.abs(den) > 1e-12) {
          const t = (y0 - y1) / den
          if (t > 0 && t < 1) see((1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * y1 + t * t * y2)
        }
        y0 = y2
        break
      }
      case CLOSE_PATH: break
      default: return undefined // not a path buffer this code understands
    }
  }
  return lo <= hi ? [lo, hi] : undefined
}

const round2 = (v: number) => Math.round(v * 100) / 100

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
    charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, font: '', loadedName: '', type3: false, size: 0, rise: 0, fontScale: 0.001, vertical: false, direction: 1,
  }
  const stack: TextState[] = []
  const objs = page.commonObjs
  let outlines = outlineCaches.get(objs)
  if (!outlines) outlineCaches.set(objs, outlines = new Map())
  /** Outline y-range (em units) of one glyph, from the cache or the common object. */
  const outlineOf = (fontChar: string | undefined): readonly [number, number] | null => {
    if (st.type3 || fontChar === undefined) return null
    const key = `${st.loadedName}_path_${fontChar}`
    let range = outlines.get(key)
    if (range === undefined) {
      let path: ArrayLike<number> | undefined
      try {
        // has() first: get() on an object that was never sent throws.
        if (objs.has(key)) path = (objs.get(key) as { path?: ArrayLike<number> } | null)?.path
      }
      catch { /* no outline: keep the em box */ }
      range = (path && outlineYRange(path)) ?? null
      outlines.set(key, range)
    }
    return range
  }
  const apply = (m: Matrix, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as const
  // Mirrors CanvasGraphics.setFont: a negative size flips the text direction.
  const setFont = (name: string, size: number) => {
    st.font = name
    st.size = Math.abs(size)
    st.direction = size < 0 ? -1 : 1
    let font: { fontMatrix?: number[], vertical?: boolean, loadedName?: string, isType3Font?: boolean } | undefined
    try {
      font = page.commonObjs.get(name)
    }
    catch { /* font not resolved: keep defaults */ }
    st.fontScale = font?.fontMatrix?.[0] ?? 0.001
    st.vertical = Boolean(font?.vertical)
    st.loadedName = font?.loadedName ?? name
    st.type3 = Boolean(font?.isType3Font)
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
        const horizontal = Math.abs(m[1]) <= 1e-6 * Math.abs(m[0]) && Math.abs(m[2]) <= 1e-6 * Math.abs(m[3]) && m[0] * hScale > 0
        let advance = 0
        for (const g of args[0] as (number | { unicode?: string, fontChar?: string, width: number, isSpace?: boolean, vmetric?: number[] } | null)[]) {
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
          // Only horizontal text has meaningful x-extents; rotated or mirrored
          // runs still advance, but their items use the rotated box instead.
          if (horizontal) {
            const gx = st.x + advance * hScale
            const [x0, y] = apply(m, gx, st.y + st.rise)
            const [x1] = apply(m, st.x + (advance + g.width * scale) * hScale, st.y + st.rise)
            // Outline em units → text space: × size, and flipped with a
            // negative Tf size (CanvasGraphics.showText scales y by
            // fontDirection) → PDF space through the same matrix as x.
            const outline = outlineOf(g.fontChar)
            let y0 = Number.NaN
            let y1 = Number.NaN
            if (outline) {
              const [, a] = apply(m, gx, st.y + st.rise + st.direction * outline[0] * st.size)
              const [, b] = apply(m, gx, st.y + st.rise + st.direction * outline[1] * st.size)
              y0 = round2(Math.min(a, b))
              y1 = round2(Math.max(a, b))
            }
            glyphs.push({ unicode: g.unicode ?? '', x0: Math.min(x0, x1), x1: Math.max(x0, x1), y, y0, y1, font: st.font, seq: glyphs.length })
          }
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
 * Glyph lookup by font + baseline + x-range. Buckets glyphs by font and
 * integer baseline, each sorted by x0, so an item scans only nearby glyphs
 * (was O(items × glyphs of the font) per page). Results come back in
 * content-stream order, which the character alignment relies on.
 */
function indexGlyphs(glyphs: Glyph[]) {
  const buckets = new Map<string, Glyph[]>()
  for (const g of glyphs) {
    if (g.unicode.trim() === '') continue
    const key = `${g.font}|${Math.round(g.y)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(g)
    else buckets.set(key, [g])
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.x0 - b.x0)

  return {
    query(font: string, y: number, yTolerance: number, xFrom: number, xTo: number): Glyph[] {
      const found: Glyph[] = []
      for (let row = Math.round(y - yTolerance); row <= Math.round(y + yTolerance); row++) {
        const bucket = buckets.get(`${font}|${row}`)
        if (!bucket) continue
        let lo = 0
        let hi = bucket.length
        while (lo < hi) { // first glyph with x0 >= xFrom
          const mid = (lo + hi) >> 1
          if (bucket[mid]!.x0 < xFrom) lo = mid + 1
          else hi = mid
        }
        for (let k = lo; k < bucket.length && bucket[k]!.x0 <= xTo; k++) {
          if (Math.abs(bucket[k]!.y - y) < yTolerance) found.push(bucket[k]!)
        }
      }
      return found.sort((a, b) => a.seq - b.seq)
    },
  }
}

/**
 * Attaches `charX0`/`charX1` (per character of `item.str`) to every item whose
 * glyphs align exactly, with `charY0`/`charY1` (the glyph outlines' vertical
 * extent, NaN where a glyph has none); other items are left untouched
 * (proportional fallback, em box). Returns the number of items that received
 * exact positions.
 */
export async function attachGlyphPositions(page: PDFPageProxy, items: PositionedItem[], fontNames: string[]): Promise<number> {
  const glyphs = await pageGlyphs(page)
  const index = indexGlyphs(glyphs)
  let aligned = 0

  items.forEach((item, i) => {
    const size = item.fontSize || item.height
    if (!item.str.trim() || size <= 0 || item.width <= 0 || item.rotation) return
    const candidates = index.query(fontNames[i]!, item.y, 0.3 * size, item.x - ALIGN_TOLERANCE, item.x + item.width + ALIGN_TOLERANCE)

    // Expand ligature glyphs ("fi") into per-character slices, in NFKC form so
    // they compare with the text item's characters.
    const sequence = candidates.flatMap((g) => {
      const chars = [...g.unicode.normalize('NFKC')]
      const w = (g.x1 - g.x0) / chars.length
      return chars.map((ch, j) => ({ ch, x0: g.x0 + w * j, x1: g.x0 + w * (j + 1), y0: g.y0, y1: g.y1 }))
    })

    const x0 = new Float64Array(item.str.length).fill(Number.NaN)
    const x1 = new Float64Array(item.str.length).fill(Number.NaN)
    const y0 = new Float64Array(item.str.length).fill(Number.NaN)
    const y1 = new Float64Array(item.str.length).fill(Number.NaN)
    let next = 0
    for (let offset = 0; offset < item.str.length; offset++) {
      const ch = item.str[offset]!
      if (/\s/.test(ch)) continue
      let q = next
      while (q < sequence.length && sequence[q]!.ch !== ch.normalize('NFKC')) q++
      if (q >= sequence.length || q - next >= 3) return // misaligned: keep proportional cut
      x0[offset] = sequence[q]!.x0
      x1[offset] = sequence[q]!.x1
      y0[offset] = sequence[q]!.y0
      y1[offset] = sequence[q]!.y1
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
    item.charY0 = y0
    item.charY1 = y1
    aligned++
  })
  return aligned
}
