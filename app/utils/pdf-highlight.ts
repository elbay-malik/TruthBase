import type { PDFPageProxy, PageViewport, TextLayer as TextLayerT } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { HighlightRect } from '#shared/types'
import { itemRanges, normalizePageText, type PageText } from '#shared/utils/page-text'
import type { Box } from '#shared/utils/rect-overlap'

// Client-side PDF.js helpers for rendering a page and placing highlights
// (Phase 3.5 spike → Phase 5 viewer). Browser only: import pdfjs-dist lazily so
// it never enters the SSR bundle (it warns and needs canvas under Node).

type Pdfjs = typeof import('pdfjs-dist')
let pdfjsPromise: Promise<Pdfjs> | undefined

/** pdfjs-dist with the same-origin module worker configured (once). */
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    // Same-origin asset URL: no blob: wrapper, and the worker script is served
    // without the page CSP (nuxt-security only sets CSP on HTML responses).
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    return pdfjs
  })
  return pdfjsPromise
}

export interface RenderedPage {
  /** `.pdf-page` element: canvas + `.textLayer`, sized to the viewport in CSS px. */
  container: HTMLDivElement
  viewport: PageViewport
  textLayer: TextLayerT
  /** Text items in getTextContent() order — the order ingestion used. */
  items: TextItem[]
  /** Normalized page text + char→item map over `items` (same as the server). */
  pageText: PageText
  /** Device pixels per CSS pixel the canvas was rendered with. */
  dpr: number
}

/** Renders `page` at `scale` (canvas at device resolution + text layer) into `mount`. */
export async function renderPage(page: PDFPageProxy, scale: number, mount: HTMLElement): Promise<RenderedPage> {
  const pdfjs = await loadPdfjs()
  const viewport = page.getViewport({ scale })

  const container = document.createElement('div')
  container.className = 'pdf-page'
  container.style.width = `${viewport.width}px`
  container.style.height = `${viewport.height}px`
  container.style.setProperty('--scale-factor', String(scale))
  container.style.setProperty('--user-unit', String(viewport.userUnit))

  const dpr = window.devicePixelRatio || 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  canvas.style.display = 'block'

  const textLayerDiv = document.createElement('div')
  textLayerDiv.className = 'textLayer'
  container.append(canvas, textLayerDiv)
  mount.append(container)

  await page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise

  const textContent = await page.getTextContent()
  const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport })
  await textLayer.render()

  // Same filter as unpdf's extractTextItems (`item.str != null`): drops marked content.
  const items = textContent.items.filter((item): item is TextItem => 'str' in item)
  return { container, viewport, textLayer, items, pageText: normalizePageText(items), dpr }
}

/** Stored PDF-space rects → CSS px boxes relative to the page container. */
export function toViewportBoxes(viewport: PageViewport, rects: HighlightRect[]): Box[] {
  return rects.map((r) => {
    // PDF.js 6 has no convertToViewportRectangle: convert both corners.
    const [ax, ay] = viewport.convertToViewportPoint(r.x1, r.y1) as [number, number]
    const [bx, by] = viewport.convertToViewportPoint(r.x2, r.y2) as [number, number]
    return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) }
  })
}

/**
 * Text-layer boxes for a character range, one DOM Range per covered item.
 * Item ends follow the PDF advance widths (spans are scaled to them), but
 * positions inside an item follow a substitute font, and the vertical extent
 * is that font's whole-pixel em box — a visual approximation, not glyph truth.
 */
export function textLayerBoxes(rendered: RenderedPage, start: number, end: number): Box[] {
  const { textLayer, container, pageText } = rendered
  const origin = container.getBoundingClientRect()
  const boxes: Box[] = []
  for (const [itemIndex, { from, to }] of itemRanges(pageText, start, end)) {
    const node = textLayer.textDivs[itemIndex]?.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) continue
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to + 1)
    for (const r of range.getClientRects()) {
      if (r.width === 0 || r.height === 0) continue
      boxes.push({ x1: r.left - origin.left, y1: r.top - origin.top, x2: r.right - origin.left, y2: r.bottom - origin.top })
    }
  }
  return boxes
}

/**
 * Text-layer boxes for [start, end) grouped into lines the way the server
 * groups stored rects: consecutive items on the same baseline (±0.5·size) and
 * not across a column gap (3·size) form one line; each line is the hull of
 * its boxes. Order-independent of box geometry, unlike a geometric merge.
 */
export function textLayerLines(rendered: RenderedPage, start: number, end: number): Box[] {
  const { textLayer, container, pageText, items, viewport } = rendered
  const origin = container.getBoundingClientRect()
  const lines: { box: Box, baseline: number, size: number, right: number }[] = []
  for (const [itemIndex, { from, to }] of itemRanges(pageText, start, end)) {
    const node = textLayer.textDivs[itemIndex]?.firstChild
    const item = items[itemIndex]!
    if (!node || node.nodeType !== Node.TEXT_NODE) continue
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to + 1)
    const r = range.getBoundingClientRect()
    if (r.width === 0) continue
    const box = { x1: r.left - origin.left, y1: r.top - origin.top, x2: r.right - origin.left, y2: r.bottom - origin.top }
    const size = Math.hypot(item.transform[2], item.transform[3]) * viewport.scale
    const baseline = item.transform[5]
    const line = lines.at(-1)
    if (line && Math.abs(baseline - line.baseline) * viewport.scale < 0.5 * size && box.x1 >= line.right - size && box.x1 - line.right < 3 * size) {
      line.box = { x1: Math.min(line.box.x1, box.x1), y1: Math.min(line.box.y1, box.y1), x2: Math.max(line.box.x2, box.x2), y2: Math.max(line.box.y2, box.y2) }
      line.right = Math.max(line.right, box.x2) // running max, like the server's line.x2
    }
    else {
      lines.push({ box, baseline, size, right: box.x2 })
    }
  }
  return lines.map(l => l.box)
}

/**
 * Character-edge position in CSS px from the text layer: left edge of the
 * character at `index` (side 'start') or right edge (side 'end'), and whether
 * that character is the first/last non-space character of its text item —
 * the only positions where the text layer is exact (inside an item it uses a
 * substitute font's advances).
 */
export function textLayerEdge(rendered: RenderedPage, index: number, side: 'start' | 'end'): { x: number, atItemBoundary: boolean } | undefined {
  const { textLayer, container, pageText, items } = rendered
  const itemIndex = pageText.charItem[index]!
  const offset = pageText.charOffset[index]!
  const node = textLayer.textDivs[itemIndex]?.firstChild
  if (itemIndex === -1 || !node || node.nodeType !== Node.TEXT_NODE) return undefined
  const range = document.createRange()
  range.setStart(node, offset)
  range.setEnd(node, offset + 1)
  const r = range.getBoundingClientRect()
  const origin = container.getBoundingClientRect()
  const str = items[itemIndex]!.str
  // The text layer places each span at the item origin and, for multi-character
  // items only, scales it to the item's width (PDF.js skips --scale-x for single
  // characters). So only the very first character's left edge, and the last
  // character's right edge of a multi-character item, are exact.
  const atItemBoundary = side === 'start' ? offset === 0 : str.length > 1 && offset === str.length - 1
  return { x: (side === 'start' ? r.left : r.right) - origin.left, atItemBoundary }
}

/**
 * Vertical ink coverage of `boxes` on the rendered canvas. For each box, scans
 * the canvas within the box's x-range and finds this line's own ink: the
 * contiguous run of rows containing dark pixels that passes through the box's
 * vertical centre, stopping at the first blank row (the gap to the next line),
 * so neighbouring lines are not counted. Reports how much of that ink lies
 * inside the box and the slack between box and ink edges (positive = the box
 * extends beyond the ink; negative = ink sticks out).
 */
export function inkCoverage(rendered: RenderedPage, boxes: Box[]): { coverage: number, topSlack: number, bottomSlack: number, noInk: boolean }[] {
  const canvas = rendered.container.querySelector('canvas')!
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const ratio = rendered.dpr // the render transform; canvas.width is floored and would bias rows
  return boxes.map((b) => {
    const height = b.y2 - b.y1
    const x = Math.max(0, Math.floor(b.x1 * ratio))
    const w = Math.max(1, Math.min(canvas.width, Math.ceil(b.x2 * ratio)) - x)
    const y = Math.max(0, Math.floor((b.y1 - height) * ratio))
    const h = Math.max(1, Math.min(canvas.height, Math.ceil((b.y2 + height) * ratio)) - y)
    const { data } = ctx.getImageData(x, y, w, h)
    const hasInk = (row: number) => {
      let dark = 0
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 4
        if (data[i + 3]! > 0 && (data[i]! + data[i + 1]! + data[i + 2]!) / 3 < 160 && ++dark >= 2) return true
      }
      return false
    }
    // Start at the box centre; if that row is blank, take the nearest ink row inside the box.
    const centre = Math.round(((b.y1 + b.y2) / 2) * ratio) - y
    const boxTop = Math.floor(b.y1 * ratio) - y
    const boxBottom = Math.ceil(b.y2 * ratio) - y
    let seed = -1
    for (let d = 0; seed === -1 && centre - d >= boxTop; d++) {
      if (centre + d < boxBottom && hasInk(centre + d)) seed = centre + d
      else if (hasInk(centre - d)) seed = centre - d
    }
    // No ink inside the box at all: a misplaced highlight, never "perfect coverage".
    if (seed === -1) return { coverage: 0, topSlack: Number.NaN, bottomSlack: Number.NaN, noInk: true }
    let top = seed
    while (top > 0 && hasInk(top - 1)) top--
    let bottom = seed
    while (bottom < h - 1 && hasInk(bottom + 1)) bottom++

    const inkTop = (y + top) / ratio
    const inkBottom = (y + bottom + 1) / ratio
    const inside = Math.max(0, Math.min(b.y2, inkBottom) - Math.max(b.y1, inkTop))
    return { coverage: inside / (inkBottom - inkTop), topSlack: inkTop - b.y1, bottomSlack: b.y2 - inkBottom, noInk: false }
  })
}

/** Absolutely positioned overlay divs for `boxes` inside the page container. */
export function drawBoxes(container: HTMLElement, boxes: Box[], className: string): HTMLElement[] {
  return boxes.map((b) => {
    const div = document.createElement('div')
    div.className = className
    Object.assign(div.style, {
      position: 'absolute',
      left: `${b.x1}px`,
      top: `${b.y1}px`,
      width: `${b.x2 - b.x1}px`,
      height: `${b.y2 - b.y1}px`,
      pointerEvents: 'none',
    })
    container.append(div)
    return div
  })
}
