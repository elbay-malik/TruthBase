/**
 * Core data model for the citation-to-highlight pipeline
 * (docs/EXECUTION_PLAN.md, Phases 2–5).
 *
 * Coordinates are scale-independent: PDF-space (bottom-left origin) at
 * scale 1, converted at view time by passing both corners through
 * `viewport.convertToViewportPoint` (PDF.js 6 has no convertToViewportRectangle)
 * and re-drawn as overlay divs on zoom/rotation. Never store pixels.
 */

/** One rectangle in PDF-space coordinates. */
export interface HighlightRect {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Position metadata captured per chunk at ingestion (Phase 3). */
export interface ChunkHighlight {
  pageNumber: number
  boundingRect: HighlightRect
  /** One rect per rendered line; drawn as stacked overlay divs. */
  rects: HighlightRect[]
  /** From `page.getViewport({ scale: 1 })`. */
  pageWidth: number
  pageHeight: number
  /** True while coordinates are PDF-space (bottom-left origin). */
  usePdfCoordinates: boolean
  /** Character offsets of the chunk within the page's extracted text. */
  startOffset: number
  endOffset: number
}

