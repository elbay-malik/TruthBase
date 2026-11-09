import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { HighlightRect } from '../../shared/types'
import { itemRanges } from '../../shared/utils/page-text'
import { chunkPage as chunkWith, DEFAULT_CHUNK_OPTIONS, type ChunkSpan } from '../../server/ingest/chunk'
import { extractPages, type PageLayout } from '../../server/ingest/extract'
import { chunkHighlight } from '../../server/ingest/highlight'

// Highlight edges vs an independent PDF engine. test/fixtures/glyph-edges.json
// holds MuPDF's x-position of each golden span's first and last character
// (scripts/glyph_edges.py); the stored rects must start and end there. Before
// the glyph replay (server/ingest/glyphs.ts) the proportional cut was off by
// up to 15.6 pt (3 glyphs) on mid-item edges.

const ROOT = resolve(__dirname, '../..')

// The rect lists below name chunks by start offset, so they are pinned to the
// chunking they were recorded with (overlap 120); the geometry they guard does
// not depend on where a chunk starts.
const RECORDED_CHUNKING = { ...DEFAULT_CHUNK_OPTIONS, overlapChars: 120 }
const chunkPage = (text: string) => chunkWith(text, RECORDED_CHUNKING)

interface Fixture { id: string, document: string, page: number, start: number, end: number, chunk: { start: number, end: number } }
interface Edge { id: string, startX: number, endX: number, startBaseline: number, endBaseline: number }

describe('highlight edges vs MuPDF glyph positions', () => {
  let fixtures: Fixture[]
  let edges: Map<string, Edge>
  const pages = new Map<string, PageLayout[]>()

  beforeAll(async () => {
    fixtures = JSON.parse(await readFile(resolve(ROOT, 'test/fixtures/highlight-spans.json'), 'utf8'))
    const reference = JSON.parse(await readFile(resolve(ROOT, 'test/fixtures/glyph-edges.json'), 'utf8'))
    edges = new Map(reference.edges.map((e: Edge) => [e.id, e]))
    for (const document of new Set(fixtures.map(f => f.document))) {
      pages.set(document, await extractPages(new Uint8Array(await readFile(resolve(ROOT, 'docs/golden/pdfs', document)))))
    }
  }, 60_000)

  it('has a MuPDF reference for every golden span', () => {
    expect(fixtures.filter(f => !edges.has(f.id)).map(f => f.id)).toEqual([])
  })

  // highlight-spans.json and e2e/chunks.json describe what ingestion stores, so
  // they follow the default chunking, unlike the pinned guards in this file.
  it('records the chunk that default chunking stores for every golden span', async () => {
    const text: Record<string, string> = JSON.parse(await readFile(resolve(ROOT, 'test/fixtures/e2e/chunks.json'), 'utf8'))
    const stale = fixtures.filter((f) => {
      const page = pages.get(f.document)![f.page - 1]!
      const stored = chunkWith(page.text, DEFAULT_CHUNK_OPTIONS).some(c => c.start === f.chunk.start && c.end === f.chunk.end)
      return !stored || text[f.id] !== page.text.slice(f.chunk.start, f.chunk.end)
    })
    expect(stale.map(f => f.id), 'run pnpm fixtures:highlights && pnpm fixtures:e2e').toEqual([])
  })

  it('starts and ends every span highlight on the exact glyph edge (±0.05 pt)', () => {
    const off = fixtures.flatMap((f) => {
      const rects = chunkHighlight(pages.get(f.document)![f.page - 1]!, { start: f.start, end: f.end }).rects
      const edge = edges.get(f.id)!
      return [
        { id: `${f.id} start`, err: rects[0]!.x1 - edge.startX },
        { id: `${f.id} end`, err: rects.at(-1)!.x2 - edge.endX },
      ].filter(e => Math.abs(e.err) > 0.05)
    })
    expect(off).toEqual([])
  })

  // The x checks above can't tell which line a rect is on: the first and last
  // rects must span MuPDF's baseline of the span's first and last character.
  it('puts the first and last line rects on the right baselines', () => {
    const off = fixtures.flatMap((f) => {
      const rects = chunkHighlight(pages.get(f.document)![f.page - 1]!, { start: f.start, end: f.end }).rects
      const edge = edges.get(f.id)!
      return [
        { id: `${f.id} start`, rect: rects[0]!, baseline: edge.startBaseline },
        { id: `${f.id} end`, rect: rects.at(-1)!, baseline: edge.endBaseline },
      ].filter(({ rect, baseline }) => !(rect.y1 < baseline && baseline < rect.y2)).map(e => e.id)
    })
    expect(off).toEqual([])
  })

  it('aligns exact glyph positions for nearly all text items', () => {
    let items = 0
    let aligned = 0
    for (const layouts of pages.values()) {
      for (const page of layouts) {
        items += page.items.filter(item => item.str.trim()).length
        aligned += page.glyphAlignedItems
      }
    }
    expect(aligned / items).toBeGreaterThan(0.99)
  })

  // TeX math-extension sums hang 0.7–1.4 em below their baseline, out of the
  // em box (ADR-0004, "Big operators"). g-035 (self-rag.pdf p. 19) has a
  // display-style ∑ (cmex "X", outline 289.08–303.03 pt) and a text-style one
  // (cmex "P", 267.40–277.36 pt); MuPDF's ink at 8× (289.0–303.0,
  // 267.38–277.38) agrees within 0.1 pt.
  it('reaches the outlines of g-035\'s big operators with glyph rects below their lines', () => {
    const f = fixtures.find(x => x.id === 'g-035#1')!
    const page = pages.get(f.document)![f.page - 1]!
    const chunk = chunkPage(page.text).find(c => c.start <= f.start && f.end <= c.end)!
    const { rects } = chunkHighlight(page, chunk)
    const display = rects.find(r => r.x1 < 290 && r.x2 > 300 && r.y2 < 301 && r.y1 < 290)
    const text = rects.find(r => r.x1 < 155 && r.x2 > 164 && r.y2 < 275.5 && r.y1 < 268)
    expect(display?.y1).toBeLessThanOrEqual(289.1)
    expect(text?.y1).toBeLessThanOrEqual(267.4)
    // Each glyph rect hangs from its line rect (which keeps the em box: the
    // corpus guard below) and covers what the line rect misses, 0.75–1.15 em.
    for (const glyph of [display!, text!]) {
      const line = rects[rects.indexOf(glyph) - 1]!
      expect(line.y1).toBe(glyph.y2)
      expect(line.y1 - glyph.y1).toBeGreaterThan(0.7 * 9.96)
    }
  })

  // Corpus-wide guard for the outline change: against the line model before it
  // (legacyLines, below), every chunk's rects are unchanged except for the
  // glyph rects listed here and two line rects whose left edge the x1 running
  // min fixed. Nothing on the NIST PDFs changes, and no line rect grows.
  it('changes no rect on the corpus except the big-operator glyph rects and two x1 fixes', () => {
    const round = (r: HighlightRect) => [r.x1, r.y1, r.x2, r.y2].map(v => v.toFixed(2)).join(' ')
    const glyphRects: string[] = []
    const x1Fixes: string[] = []
    const other: string[] = []
    for (const [document, layouts] of pages) {
      for (const page of layouts) {
        for (const chunk of chunkPage(page.text)) {
          const where = `${document} p${page.pageNumber} @${chunk.start}`
          const legacy = legacyLines(page, chunk)
          const rects = chunkHighlight(page, chunk).rects
          let j = 0
          for (const [i, old] of legacy.entries()) {
            const line = rects[j++]
            if (!line) {
              other.push(`${where} line ${i} missing`)
              break
            }
            if (round(line) !== round(old)) {
              const onlyX1 = line.x1 < old.x1 && round({ ...line, x1: old.x1 }) === round(old)
              ;(onlyX1 ? x1Fixes : other).push(`${where} line ${i}: ${round(old)} → ${round(line)}`)
            }
            // Glyph rects directly follow their line and hang from its bottom or top edge.
            while (rects[j] && round(rects[j]!) !== round(legacy[i + 1] ?? { x1: -1, y1: -1, x2: -1, y2: -1 })
              && (rects[j]!.y2 === line.y1 || rects[j]!.y1 === line.y2)) {
              glyphRects.push(`${where} line ${i}: ${round(rects[j++]!)}`)
            }
          }
          if (j !== rects.length) other.push(`${where}: ${rects.length - j} unexpected rects`)
        }
      }
    }
    expect(other).toEqual([])
    expect(glyphRects.sort()).toEqual([
      'raptor.pdf p4 @0 line 5: 108.00 662.51 118.52 668.26',
      'self-rag.pdf p19 @1384 line 11: 154.44 267.40 164.95 274.87',
      'self-rag.pdf p19 @1384 line 4: 288.28 289.08 302.67 300.54',
      'self-rag.pdf p19 @862 line 17: 154.67 339.13 165.19 346.60',
      'self-rag.pdf p6 @2312 line 17: 160.56 315.08 168.93 318.35',
      'self-rag.pdf p6 @2312 line 7: 249.53 346.10 263.92 357.56',
    ])
    // Both lines open with a mark set before its base glyph: the display ∑'s
    // upper limit "5" (p. 19; the ∑ starts 5.2 pt further left) and an accent
    // "ˆ" over "r" (p. 6, 0.45 pt).
    expect(x1Fixes.sort()).toEqual([
      'self-rag.pdf p19 @1384 line 4: 293.49 300.54 302.67 311.60 → 288.28 300.54 302.67 311.60',
      'self-rag.pdf p6 @2312 line 20: 108.45 302.72 374.46 313.18 → 108.00 302.72 374.46 313.18',
    ])
  })
})

/**
 * The line rects of chunkHighlight before glyph outlines (4a3f5b3): em boxes
 * only, and a merged line keeps its first item's left edge. The reference for
 * the corpus-wide guard above; not used by the app.
 */
function legacyLines(page: PageLayout, span: ChunkSpan): HighlightRect[] {
  const rects: HighlightRect[] = []
  let lineY = Number.NaN
  for (const [itemIndex, { from, to }] of itemRanges(page, span.start, span.end)) {
    const item = page.items[itemIndex]!
    const size = item.fontSize || item.height
    if (item.width <= 0 || size <= 0) continue
    const length = item.str.length
    if (item.rotation) {
      const { ux, uy, nx, ny } = item.rotation
      const corners = [from / length, (to + 1) / length].flatMap(share => [-0.25 * size, 0.8 * size].map(t =>
        [item.x + ux * item.width * share + nx * t, item.y + uy * item.width * share + ny * t] as const))
      const xs = corners.map(c => c[0])
      const ys = corners.map(c => c[1])
      rects.push({ x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) })
      lineY = Number.NaN
      continue
    }
    const exactX1 = item.charX0?.[from]
    const exactX2 = item.charX1?.[to]
    const rect = {
      x1: exactX1 !== undefined && !Number.isNaN(exactX1) ? exactX1 : item.x + item.width * (from / length),
      y1: item.y - 0.25 * size,
      x2: exactX2 !== undefined && !Number.isNaN(exactX2) ? exactX2 : item.x + item.width * ((to + 1) / length),
      y2: item.y + 0.8 * size,
    }
    const line = rects.at(-1)
    if (line && Math.abs(item.y - lineY) < 0.5 * size && rect.x1 >= line.x2 - size && rect.x1 - line.x2 < 3 * size) {
      line.x2 = Math.max(line.x2, rect.x2)
      line.y1 = Math.min(line.y1, rect.y1)
      line.y2 = Math.max(line.y2, rect.y2)
    }
    else {
      rects.push(rect)
      lineY = item.y
    }
  }
  return rects
}

