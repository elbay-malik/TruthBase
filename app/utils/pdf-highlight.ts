import type { PDFPageProxy, PageViewport, TextLayer as TextLayerT } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import type { HighlightRect } from '#shared/types'
import { itemRanges, normalizePageText, type PageText } from '#shared/utils/page-text'

/** Axis-aligned box in CSS px relative to the page container. */
export interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

// Client-side PDF.js helpers for rendering a page and placing highlights
// (Phase 5 viewer). Browser only: import pdfjs-dist lazily so
// it never enters the SSR bundle (it warns and needs canvas under Node).

// The legacy build: the modern one needs very recent browser APIs (e.g.
// Uint8Array.fromBase64) and fails outright on older Safari / Firefox ESR.
type Pdfjs = typeof import('pdfjs-dist')
let pdfjsPromise: Promise<Pdfjs> | undefined

/** pdfjs-dist with the same-origin module worker configured (once). */
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<Pdfjs>,
    // A dynamic `?url` import, so the 1.3 MB worker is never modulepreloaded
    // with the page. Same-origin URL: no blob: wrapper, and the worker script
    // is served without the page CSP (nuxt-security sets CSP on HTML only).
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    return pdfjs
  }).catch((error) => {
    pdfjsPromise = undefined // a failed import (network blip) is retried on the next load
    throw error
  })
  return pdfjsPromise
}

/**
 * PDF.js data files, copied from pdfjs-dist and served same-origin
 * (nuxt.config.ts `nitro.publicAssets`): CMaps for CJK / CID fonts, standard
 * fonts for PDFs that don't embed them, wasm decoders (JPX, JBIG2) and ICC
 * profiles. Without them such pages render blank or with fallback glyphs.
 */
export const PDFJS_ASSET_OPTIONS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
} as const

/** Browsers cap canvas area (iOS Safari ≈ 16.7 M px) and blank anything above. */
const MAX_CANVAS_PIXELS = 16_000_000

/** Frees a canvas's backing store now instead of at GC (matters on mobile). */
export function releaseCanvases(root: ParentNode | undefined) {
  root?.querySelectorAll('canvas').forEach((canvas) => {
    canvas.width = 0
    canvas.height = 0
  })
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

/**
 * Renders `page` at `scale` (canvas at device resolution + text layer) into
 * `mount`. Aborting `signal` cancels the canvas render (RenderingCancelledException).
 */
export async function renderPage(page: PDFPageProxy, scale: number, mount: HTMLElement, signal?: AbortSignal): Promise<RenderedPage> {
  const pdfjs = await loadPdfjs()
  signal?.throwIfAborted()
  const viewport = page.getViewport({ scale })

  const container = document.createElement('div')
  container.className = 'pdf-page'
  container.style.width = `${viewport.width}px`
  container.style.height = `${viewport.height}px`
  container.style.setProperty('--scale-factor', String(scale))
  container.style.setProperty('--user-unit', String(viewport.userUnit))

  // Device resolution, reduced when the canvas would exceed the pixel cap
  // (high zoom on a large page): softer, but never blank.
  const cap = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
  const dpr = Math.min(window.devicePixelRatio || 1, cap)
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

  const task = page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] })
  const cancel = () => task.cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    await task.promise
  }
  finally {
    signal?.removeEventListener('abort', cancel)
  }

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
 * Share of the page height at the top and bottom where running headers,
 * footers and page numbers sit. A chunk's lines there are layout noise, not
 * the cited passage (ingestion keeps them in the chunk text and rects).
 */
export const RUNNING_MARGIN = 0.075

/**
 * Drops boxes whose vertical centre lies in the top or bottom running margin
 * band, so the highlight shows the passage only. Kept as they are when every
 * box is in the band (a passage that really is a header or footnote).
 */
export function dropRunningMargins(boxes: Box[], pageHeight: number): Box[] {
  const band = RUNNING_MARGIN * pageHeight
  const body = boxes.filter((b) => {
    const centre = (b.y1 + b.y2) / 2
    return centre >= band && centre <= pageHeight - band
  })
  return body.length ? body : boxes
}

/**
 * Text-layer boxes for [start, end) grouped into lines the way the server
 * groups stored rects: consecutive items on the same baseline (±0.5·size) and
 * not across a column gap (3·size) form one line; each line is the hull of
 * its boxes. Order-independent of box geometry, unlike a geometric merge.
 * Compared in PDF space, so lines on a /Rotate page group the same way.
 */
export function textLayerLines(rendered: RenderedPage, start: number, end: number): Box[] {
  const { textLayer, container, pageText, items, viewport } = rendered
  const origin = container.getBoundingClientRect()
  const lines: { box: Box, baseline: number, right: number }[] = []
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
    const [ax] = viewport.convertToPdfPoint(box.x1, box.y1) as [number, number]
    const [bx] = viewport.convertToPdfPoint(box.x2, box.y2) as [number, number]
    const left = Math.min(ax, bx)
    const right = Math.max(ax, bx)
    const size = Math.hypot(item.transform[2], item.transform[3])
    const baseline = item.transform[5]
    const line = lines.at(-1)
    if (line && Math.abs(baseline - line.baseline) < 0.5 * size && left >= line.right - size && left - line.right < 3 * size) {
      line.box = { x1: Math.min(line.box.x1, box.x1), y1: Math.min(line.box.y1, box.y1), x2: Math.max(line.box.x2, box.x2), y2: Math.max(line.box.y2, box.y2) }
      line.right = Math.max(line.right, right) // running max, like the server's line.x2
    }
    else {
      lines.push({ box, baseline, right })
    }
  }
  return lines.map(l => l.box)
}
