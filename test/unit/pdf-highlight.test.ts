import type { PageViewport } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { textLayerLines, toViewportBoxes, type RenderedPage } from '../../app/utils/pdf-highlight'
import type { PageLayout, PositionedItem } from '../../server/ingest/extract'
import { chunkHighlight } from '../../server/ingest/highlight'
import { normalizePageText } from '../../shared/utils/page-text'

// The viewer's pure placement helpers under Node, with a fake viewport and
// text layer: textLayerLines must group lines exactly like the server's
// chunkHighlight, or the drawn overlay and the stored rects disagree.

const PAGE_HEIGHT = 800
const SCALE = 1.5

/** PDF space (bottom-left origin) ↔ CSS px (top-left origin) at SCALE. */
const viewport = {
  convertToViewportPoint: (x: number, y: number) => [x * SCALE, (PAGE_HEIGHT - y) * SCALE],
  convertToPdfPoint: (x: number, y: number) => [x / SCALE, PAGE_HEIGHT - y / SCALE],
} as unknown as PageViewport

interface Spec { str: string, x: number, y: number, size?: number, hasEOL?: boolean }

interface FakeText { nodeType: number, rect: (from: number, to: number) => DOMRectReadOnly }

/** A fake rendered page: a text node's range box is the em box of its characters, cut proportionally. */
function rendered(specs: Spec[], options: { missing?: number[], zeroWidth?: number[] } = {}): RenderedPage {
  const items = specs.map(({ str, x, y, size = 10, hasEOL = false }) =>
    ({ str, transform: [size, 0, 0, size, x, y], width: 5 * str.length * size / 10, height: size, hasEOL }) as unknown as TextItem)
  const textDivs = items.map((item, index) => {
    if (options.missing?.includes(index)) return {}
    const [size, , , , x, y] = item.transform as number[]
    const node: FakeText = {
      nodeType: 3,
      rect: (from, to) => {
        const left = (x! + item.width * from / item.str.length) * SCALE
        const right = options.zeroWidth?.includes(index) ? left : (x! + item.width * to / item.str.length) * SCALE
        const top = (PAGE_HEIGHT - (y! + 0.8 * size!)) * SCALE
        const bottom = (PAGE_HEIGHT - (y! - 0.25 * size!)) * SCALE
        return { left, right, top, bottom, width: right - left } as DOMRectReadOnly
      },
    }
    return { firstChild: node }
  })
  return {
    container: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    textLayer: { textDivs },
    items,
    pageText: normalizePageText(items),
    viewport,
  } as unknown as RenderedPage
}

beforeAll(() => {
  vi.stubGlobal('Node', { TEXT_NODE: 3 })
  vi.stubGlobal('document', {
    createRange: () => {
      let node: FakeText
      let from = 0
      let to = 0
      return {
        setStart: (n: FakeText, offset: number) => { node = n; from = offset },
        setEnd: (_: FakeText, offset: number) => { to = offset },
        getBoundingClientRect: () => node.rect(from, to),
      }
    },
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

function lines(specs: Spec[], start: number, end: number | null = null, options: { missing?: number[], zeroWidth?: number[] } = {}) {
  const page = rendered(specs, options)
  return textLayerLines(page, start, end ?? page.pageText.text.length)
}

/** The server's stored rects for the same items, converted the way the viewer draws them. */
function serverBoxes(specs: Spec[], start: number, end: number) {
  const items: PositionedItem[] = specs.map(({ str, x, y, size = 10, hasEOL = false }) =>
    ({ str, x, y, width: 5 * str.length * size / 10, height: size, fontSize: size, hasEOL }))
  const layout: PageLayout = { pageNumber: 1, width: 600, height: PAGE_HEIGHT, items, glyphAlignedItems: 0, ...normalizePageText(items) }
  return toViewportBoxes(viewport, chunkHighlight(layout, { start, end }).rects)
}

describe('toViewportBoxes', () => {
  it('flips PDF-space rects into top-left CSS px boxes with ordered corners', () => {
    expect(toViewportBoxes(viewport, [{ x1: 100, y1: 700, x2: 120, y2: 710 }])).toEqual([{ x1: 150, y1: 135, x2: 180, y2: 150 }])
    expect(toViewportBoxes(viewport, [])).toEqual([])
  })
})

describe('textLayerLines', () => {
  it('merges items on one baseline and splits on a new baseline', () => {
    const boxes = lines([
      { str: 'Risk', x: 100, y: 700, hasEOL: true },
      { str: 'is', x: 125, y: 700, hasEOL: true },
      { str: 'next', x: 100, y: 686 },
    ], 0)
    expect(boxes).toHaveLength(2)
    expect(boxes[0]!.x1).toBe(150)
    expect(boxes[0]!.x2).toBe(202.5)
  })

  it('splits across a column gutter and on a jump back left', () => {
    expect(lines([{ str: 'left', x: 100, y: 700, hasEOL: true }, { str: 'right', x: 150, y: 700 }], 0)).toHaveLength(2)
    expect(lines([{ str: 'left', x: 100, y: 700, hasEOL: true }, { str: 'right', x: 149.9, y: 700 }], 0)).toHaveLength(1)
    expect(lines([{ str: 'two', x: 300, y: 700, hasEOL: true }, { str: 'one', x: 100, y: 700 }], 0)).toHaveLength(2)
  })

  it('skips items without a text node or with an empty range box', () => {
    const specs = [{ str: 'aa', x: 100, y: 700, hasEOL: true }, { str: 'bb', x: 100, y: 680, hasEOL: true }, { str: 'cc', x: 100, y: 660 }]
    expect(lines(specs, 0, null, { missing: [0] })).toHaveLength(2)
    expect(lines(specs, 0, null, { zeroWidth: [1] })).toHaveLength(2)
    expect(lines(specs, 2, 3)).toEqual([]) // only the separator space
  })

  it('keeps the line right edge as a running max, like the server', () => {
    // "x" ends inside "abcdef" (130); "zz" at 158 merges only if the line still ends at 130.
    const specs: Spec[] = [{ str: 'abcdef', x: 100, y: 700, hasEOL: true }, { str: 'x', x: 121, y: 700, hasEOL: true }, { str: 'zz', x: 158, y: 700 }]
    const boxes = lines(specs, 0)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.x2).toBeCloseTo(168 * SCALE, 6)
  })

  // The fake text layer reuses the server's 0.8 / 0.25 em box, so vertical
  // extents agree by construction; this checks line grouping and x extents.
  it('draws the same lines the server stored for the chunk', () => {
    const specs: Spec[] = [
      { str: 'Header text', x: 72, y: 760, hasEOL: true },
      { str: 'The first line of', x: 72, y: 700 },
      { str: ' the body', x: 157, y: 700.5, hasEOL: true },
      { str: 'second line, then', x: 72, y: 686, hasEOL: true },
      { str: 'a far column', x: 400, y: 686, size: 12, hasEOL: true },
      { str: 'back to the left.', x: 72, y: 672, hasEOL: true },
      { str: 'abcdef', x: 100, y: 640, hasEOL: true },
      { str: 'x', x: 121, y: 640, hasEOL: true }, // ends inside "abcdef"
      { str: 'zz', x: 158, y: 640 }, // merges only via the running max
    ]
    const text = normalizePageText(specs.map(s => ({ str: s.str, hasEOL: s.hasEOL ?? false }))).text
    const spans = [
      [0, text.length, 6],
      [text.indexOf('first'), text.indexOf('far') + 3, 3],
      [text.indexOf('line,'), text.indexOf('back'), 2],
      [text.indexOf('abcdef'), text.length, 1],
    ] as const
    for (const [start, end, count] of spans) {
      const viewer = lines(specs, start, end)
      const server = serverBoxes(specs, start, end)
      expect(server).toHaveLength(count)
      expect(viewer).toHaveLength(server.length)
      viewer.forEach((box, i) => {
        for (const key of ['x1', 'y1', 'x2', 'y2'] as const) expect(box[key]).toBeCloseTo(server[i]![key], 6)
      })
    }
  })
})
