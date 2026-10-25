import { getDocumentProxy } from 'unpdf'
import type { PDFPageProxy } from 'unpdf/pdfjs'
import { normalizePageText } from '../../shared/utils/page-text'
import { attachGlyphPositions } from './glyphs'
import { nodeAssetReader, pdfjsAssetOptions, type PdfAssetReader } from './pdf-assets'

// Phase 3, step 1: PDF → per-page normalized text with a character→item map.
//
// Page text comes from shared/utils/page-text.ts (the golden matching
// contract), which also records, for every normalized character, which text
// item (and which character inside it) it came from. That map is what turns a
// chunk's character range into highlight rects (./highlight.ts), and the
// browser viewer rebuilds the same map over the PDF.js text layer.

type TextItem = Extract<Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number], { str: string }>

/** One PDF.js text item, positioned in PDF space (bottom-left origin, scale 1). */
export interface PositionedItem {
  str: string
  /** Baseline origin, from `transform[4]` / `transform[5]`. */
  x: number
  y: number
  width: number
  /** Often 0 or unreliable in PDF.js; prefer `fontSize` for line height. */
  height: number
  fontSize: number
  hasEOL: boolean
  /**
   * Exact x-extent of each character of `str` (PDF space), when the glyph
   * replay aligned this item (./glyphs.ts). NaN for whitespace. Absent →
   * highlights cut the item proportionally by character count.
   */
  charX0?: Float64Array
  charX1?: Float64Array
  /**
   * Vertical extent of each character's glyph outline (PDF space, 0.01 pt),
   * set together with `charX0`/`charX1`. NaN for whitespace and glyphs
   * without an outline. Highlights stay on the fixed em box and use this only
   * for glyphs that leave it (big operators, ./highlight.ts).
   */
  charY0?: Float64Array
  charY1?: Float64Array
  /**
   * Text direction when the item is not horizontal (rotated stamps, rotated
   * figure captions): unit vector along the baseline (u) and towards the
   * ascender (n), in PDF space. Highlights then follow the transform instead
   * of drawing a horizontal bar (./highlight.ts).
   */
  rotation?: { ux: number, uy: number, nx: number, ny: number }
}

export interface PageLayout {
  /** 1-based physical page index (what PDF.js uses). */
  pageNumber: number
  /** Page size from `page.getViewport({ scale: 1 })`. */
  width: number
  height: number
  /** Normalized page text (whitespace collapsed, trimmed). */
  text: string
  items: PositionedItem[]
  /**
   * For each character of `text`: index into `items`, or -1 for a space that
   * stands in for an item boundary / line break rather than a character.
   */
  charItem: Int32Array
  /** For each character of `text`: offset inside `items[charItem[i]].str`. */
  charOffset: Int32Array
  /** Items with exact per-character positions (the rest use the proportional cut). */
  glyphAlignedItems: number
}

export interface ExtractOptions {
  /** PDF.js CMap / standard-font files (default: from node_modules). */
  assets?: PdfAssetReader
}

export async function extractPages(data: Uint8Array, options: ExtractOptions = {}): Promise<PageLayout[]> {
  // fontExtraProperties exposes each font's fontMatrix/vertical to the glyph
  // replay and keeps the glyph outlines PDF.js sends with the operator list.
  // disableFontFace makes the worker compile those outlines at all (it does so
  // only for fonts it can't hand to the platform as a FontFace): unpdf already
  // sets it under Node, but the outline extents (./glyphs.ts, ADR-0004) depend
  // on it, so it is explicit rather than an environment default.
  const pdf = await getDocumentProxy(data, {
    fontExtraProperties: true,
    disableFontFace: true,
    ...pdfjsAssetOptions(options.assets ?? nodeAssetReader()),
  })
  try {
    const pages: PageLayout[] = []
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1)
      const viewport = page.getViewport({ scale: 1 })
      // Same call, order and filter (`str` present) as unpdf's extractTextItems,
      // plus fontName, which the glyph alignment needs.
      const textItems = (await page.getTextContent()).items.filter((item): item is TextItem => 'str' in item)
      const pageItems: PositionedItem[] = textItems.map(({ str, transform, width, height, hasEOL }) => ({
        str,
        x: transform[4],
        y: transform[5],
        width,
        height,
        fontSize: Math.hypot(transform[2], transform[3]),
        hasEOL: Boolean(hasEOL),
        rotation: rotationOf(transform),
      }))
      // The replay needs the operator list, which also decodes every image on
      // the page: skip it on pages without text (e.g. scans, rejected later).
      const glyphAlignedItems = pageItems.some(item => item.str.trim())
        ? await attachGlyphPositions(page, pageItems, textItems.map(item => item.fontName))
        : 0
      pages.push({ pageNumber: i + 1, width: viewport.width, height: viewport.height, ...normalizePage(pageItems), glyphAlignedItems })
      page.cleanup()
    }
    return pages
  }
  finally {
    // The serverless PDF.js build has no PDFDocumentProxy#destroy; unpdf
    // itself releases documents through the loading task.
    await pdf.loadingTask.destroy()
  }
}

/** Baseline/ascender directions for a non-horizontal text transform. */
function rotationOf(transform: number[]): PositionedItem['rotation'] {
  const [a, b, c, d] = transform as [number, number, number, number]
  const along = Math.hypot(a, b)
  const up = Math.hypot(c, d)
  // Horizontal (incl. scaled/skew-free) text: the common, exact case.
  if (along === 0 || up === 0 || (Math.abs(b) <= 1e-6 * along && Math.abs(c) <= 1e-6 * up && a > 0)) return undefined
  return { ux: a / along, uy: b / along, nx: c / up, ny: d / up }
}

/** Builds normalized text plus the char→item maps from a page's items. */
export function normalizePage(items: PositionedItem[]): Pick<PageLayout, 'items' | 'text' | 'charItem' | 'charOffset'> {
  return { items, ...normalizePageText(items) }
}
