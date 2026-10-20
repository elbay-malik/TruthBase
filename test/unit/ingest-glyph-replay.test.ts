import { getResolvedPDFJS } from 'unpdf'
import type { PDFPageProxy } from 'unpdf/pdfjs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PositionedItem } from '../../server/ingest/extract'
import { attachGlyphPositions } from '../../server/ingest/glyphs'

// The showText replay on hand-built operator lists: each advance rule (font
// matrix, Tc, Tw, Tz, TJ kerning, CTM) and each alignment rejection in
// isolation. test/unit/ingest-glyphs.test.ts checks the end result against
// MuPDF on the golden PDFs.

type Ops = Awaited<ReturnType<typeof getResolvedPDFJS>>['OPS']
let OPS: Ops

beforeAll(async () => {
  ({ OPS } = await getResolvedPDFJS())
})

interface Glyph { unicode: string, width: number, isSpace?: boolean }
/** 1000-unit glyph widths: 500 → 5 pt at size 10 with the default 0.001 font matrix. */
const g = (unicode: string, width = 500): Glyph => ({ unicode, width, isSpace: unicode === ' ' })

/** A fake page whose operator list is `ops` ([op name, args] pairs); every font has a 0.001 font matrix. */
function page(ops: [keyof Ops, unknown[]][]): PDFPageProxy {
  return {
    getOperatorList: async () => ({ fnArray: ops.map(([op]) => OPS[op]), argsArray: ops.map(([, args]) => args) }),
    commonObjs: { get: () => ({ fontMatrix: [0.001, 0, 0, 0.001, 0, 0] }) },
  } as unknown as PDFPageProxy
}

/** BT, Tf F1 10, Tm at (x, y), then the given ops. */
const text = (x: number, y: number, ...ops: [keyof Ops, unknown[]][]): [keyof Ops, unknown[]][] => [
  ['beginText', []],
  ['setFont', ['F1', 10]],
  ['setTextMatrix', [1, 0, 0, 1, x, y]],
  ...ops,
]

const item = (str: string, x: number, width: number, extra: Partial<PositionedItem> = {}): PositionedItem =>
  ({ str, x, y: 700, width, height: 10, fontSize: 10, hasEOL: false, ...extra })

async function attach(ops: [keyof Ops, unknown[]][], items: PositionedItem[], font = 'F1') {
  const aligned = await attachGlyphPositions(page(ops), items, items.map(() => font))
  return { aligned, edges: items.map(i => i.charX0 && [[...i.charX0], [...i.charX1!]]) }
}

describe('attachGlyphPositions (synthetic operator lists)', () => {
  it('places each glyph at its font-matrix advance', async () => {
    const { aligned, edges } = await attach(text(100, 700, ['showText', [[g('a'), g('b', 300), g('c')]]]), [item('abc', 100, 13)])
    expect(aligned).toBe(1)
    expect(edges[0]).toEqual([[100, 105, 108], [105, 108, 113]])
  })

  it('applies char spacing, word spacing (spaces only) and TJ kerning', async () => {
    const ops = text(100, 700,
      ['setCharSpacing', [1]],
      ['setWordSpacing', [2]],
      // a, space, b, then a −100 TJ adjustment (moves right by 1 pt), then c.
      ['showText', [[g('a'), g(' ', 250), g('b'), -100, g('c')]]],
    )
    // a 100–105; space advances 2.5 + Tw 2 + Tc 1; b 111.5–116.5; c after Tc 1 + kern 1.
    const { edges } = await attach(ops, [item('a bc', 100, 123.5 - 100)])
    expect(edges[0]).toEqual([[100, Number.NaN, 111.5, 118.5], [105, Number.NaN, 116.5, 123.5]])
  })

  it('scales advances by horizontal scaling (Tz) and the CTM', async () => {
    const tz = await attach(text(100, 700, ['setHScale', [50]], ['showText', [[g('a'), g('b')]]]), [item('ab', 100, 5)])
    expect(tz.edges[0]).toEqual([[100, 102.5], [102.5, 105]])

    // cm 2 0 0 2 0 0 doubles positions: Tm origin (50, 350) lands at (100, 700).
    const ctm = await attach([['transform', [2, 0, 0, 2, 0, 0]], ...text(50, 350, ['showText', [[g('a'), g('b')]]])], [item('ab', 100, 20, { fontSize: 20 })])
    expect(ctm.edges[0]).toEqual([[100, 110], [110, 120]])
  })

  it('restores the text state after Q', async () => {
    const ops: [keyof Ops, unknown[]][] = [
      ['save', []],
      ['transform', [2, 0, 0, 2, 0, 0]],
      ['restore', []],
      ...text(100, 700, ['showText', [[g('a')]]]),
    ]
    expect((await attach(ops, [item('a', 100, 5)])).edges[0]).toEqual([[100], [105]])
  })

  it('splits a ligature glyph into per-character slices', async () => {
    const { edges } = await attach(text(100, 700, ['showText', [[g('ﬁ'), g('x')]]]), [item('fix', 100, 10)])
    expect(edges[0]).toEqual([[100, 102.5, 105], [102.5, 105, 110]])
  })

  it('aligns each item on a line to its own glyphs', async () => {
    const ops = text(100, 700, ['showText', [[g('a'), g('b'), g(' ', 250), g('c'), g('d')]]])
    const { aligned, edges } = await attach(ops, [item('ab', 100, 10), item('cd', 112.5, 10)])
    expect(aligned).toBe(2)
    expect(edges[1]).toEqual([[112.5, 117.5], [117.5, 122.5]])
  })

  it('leaves an item untouched when the glyphs do not reproduce its extent', async () => {
    const ops = text(100, 700, ['showText', [[g('a'), g('b'), g('c')]]])
    // Item claims 20 pt but its glyphs end at 115: proportional fallback.
    expect(await attach(ops, [item('abc', 100, 20)])).toEqual({ aligned: 0, edges: [undefined] })
    // Glyph text differs from the item's string.
    expect(await attach(ops, [item('xyz', 100, 15)])).toEqual({ aligned: 0, edges: [undefined] })
    // Glyphs drawn in another font.
    expect(await attach(ops, [item('abc', 100, 15)], 'F2')).toEqual({ aligned: 0, edges: [undefined] })
  })

  it('skips rotated, blank and zero-size items', async () => {
    const ops = text(100, 700, ['showText', [[g('a'), g('b')]]])
    const items = [
      item('ab', 100, 10, { rotation: { ux: 0, uy: 1, nx: -1, ny: 0 } }),
      item('  ', 100, 10),
      item('ab', 100, 0),
      item('ab', 100, 10, { fontSize: 0, height: 0 }),
    ]
    expect(await attach(ops, items)).toEqual({ aligned: 0, edges: [undefined, undefined, undefined, undefined] })
  })

  it('gives up when 3 or more unmatched glyphs precede the next character', async () => {
    // Stray glyphs (e.g. overprinted marks) inside the item's extent, under its leading spaces.
    const two = text(100, 700, ['showText', [[g('x'), g('x'), g('a'), g('b')]]])
    expect((await attach(two, [item('  ab', 100, 20)])).edges[0]).toEqual([[Number.NaN, Number.NaN, 110, 115], [Number.NaN, Number.NaN, 115, 120]])
    const three = text(100, 700, ['showText', [[g('x'), g('x'), g('x'), g('a'), g('b')]]])
    expect(await attach(three, [item('   ab', 100, 25)])).toEqual({ aligned: 0, edges: [undefined] })
  })

  // Unguarded, the mirrored glyph "a" would land exactly on the item (105–110)
  // and align; only the horizontal check keeps the fallback.
  it('records no glyphs for mirrored text runs, so their items keep the fallback', async () => {
    const mirroredTm: [keyof Ops, unknown[]][] = [
      ['beginText', []],
      ['setFont', ['F1', 10]],
      ['setTextMatrix', [-1, 0, 0, 1, 110, 700]],
      ['showText', [[g('a')]]],
    ]
    expect((await attach(mirroredTm, [item('a', 105, 5)])).aligned).toBe(0)
    const negativeTz = text(110, 700, ['setHScale', [-100]], ['showText', [[g('a')]]])
    expect((await attach(negativeTz, [item('a', 105, 5)])).aligned).toBe(0)
  })

  // Rotated glyphs collapse to zero width, so the extent check rejects them too.
  it('records no glyphs for rotated text runs, so their items keep the fallback', async () => {
    const ops: [keyof Ops, unknown[]][] = [
      ['beginText', []],
      ['setFont', ['F1', 10]],
      ['setTextMatrix', [0, 1, -1, 0, 100, 700]], // 90°
      ['showText', [[g('a'), g('b')]]],
    ]
    expect((await attach(ops, [item('ab', 100, 10)])).aligned).toBe(0)
  })
})
