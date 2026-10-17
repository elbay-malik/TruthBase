import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractPages, type PageLayout } from '../../server/ingest/extract'
import { chunkHighlight } from '../../server/ingest/highlight'

// Highlight edges vs an independent PDF engine. test/fixtures/glyph-edges.json
// holds MuPDF's x-position of each golden span's first and last character
// (scripts/glyph_edges.py); the stored rects must start and end there. Before
// the glyph replay (server/ingest/glyphs.ts) the proportional cut was off by
// up to 15.6 pt (3 glyphs) on mid-item edges.

const ROOT = resolve(__dirname, '../..')

interface Fixture { id: string, document: string, page: number, start: number, end: number }
interface Edge { id: string, startX: number, endX: number }

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
})
