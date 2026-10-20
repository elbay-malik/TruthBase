import type { Page } from '@playwright/test'
import type { SourceRef } from '../../shared/types/chat'
import { expect, type SpanFixture } from './fixtures'

// Page helpers and the highlight geometry check shared by the specs.

/** Mirrors RUNNING_MARGIN in app/utils/pdf-highlight.ts. */
const RUNNING_MARGIN = 0.075
/** Sub-pixel: overlay boxes vs the stored rects converted independently (as in check:viewer). */
export const POSITION_TOLERANCE_PX = 0.5
/**
 * Share of a line's glyph ink its box must cover (check:viewer's
 * minInkCoverage): SPEC's ≥ 0.99 from 100%; at 50% one device pixel of
 * anti-aliasing is already ~10% of a line.
 */
export const minInkCoverage = (zoom: number) => (zoom >= 1 ? 0.99 : 0.9)
/**
 * Share of a highlight's lines that must meet it. A few lines carry ink that
 * isn't glyphs of the line (Self-RAG's framed "Critique" token, sub-pixel math
 * subscripts at 50%); a canvas drawn out of register with the overlay misses
 * on nearly every line. Every line must have some ink under it.
 */
const MIN_COVERED_SHARE = 0.9

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024

/** Waits until Vue has hydrated, so typing and key shortcuts reach the app. */
export async function open(page: Page, path = '/') {
  await page.goto(path)
  await page.waitForFunction(() => {
    const app = (window as { useNuxtApp?: () => { isHydrating?: boolean } }).useNuxtApp?.()
    return app !== undefined && app.isHydrating === false
  })
}

export const questionBox = (page: Page) => page.getByRole('textbox', { name: 'Question' })
export const liveStatus = (page: Page) => page.locator('main p[role="status"]')
export const viewer = (page: Page) => page.getByRole('region', { name: 'Document viewer' })

export async function ask(page: Page, question: string) {
  await questionBox(page).fill(question)
  await questionBox(page).press('Enter')
}

/** What the helpers need of a source. */
export type Cited = Pick<SourceRef, 'index' | 'documentId' | 'filename' | 'pageNumber'>

/** The answer's chip for `source` (the first, when it is cited more than once). */
export const chip = (page: Page, source: Cited) =>
  page.getByRole('button', { name: `Citation ${source.index}: ${source.filename}, page ${source.pageNumber}`, exact: true }).first()

/** The zoom shown on the viewer's fit button ("Fit to width (zoom 50%)"), as a scale. */
export async function viewerZoom(page: Page): Promise<number> {
  const name = await viewer(page).getByRole('button', { name: /^Fit to width/ }).getAttribute('aria-label')
  return Number(/zoom (\d+)%/.exec(name ?? '')?.[1]) / 100
}

/** Steps the viewer's zoom buttons to `zoom` (one of its steps). */
export async function setZoom(page: Page, zoom: number) {
  const fit = viewer(page).getByRole('button', { name: /^Fit to width/ })
  for (let current = await viewerZoom(page); Math.abs(current - zoom) > 1e-6; current = await viewerZoom(page)) {
    const before = `Fit to width (zoom ${Math.round(current * 100)}%)`
    await viewer(page).getByRole('button', { name: current < zoom ? 'Zoom in' : 'Zoom out', exact: true }).click()
    await expect(fit).not.toHaveAttribute('aria-label', before)
  }
}

/** Opens a citation from its chip; on phones that opens the sheet. */
export async function openCitation(page: Page, source: Cited) {
  await chip(page, source).click()
  await expect(viewer(page)).toHaveAttribute('data-document-id', source.documentId)
}

/**
 * Phones: closes the sheet so the answer's chips can be tapped again. Focus
 * returns to the chip, which opens its tooltip; that can cover the chip next
 * to it, so it is dismissed (Escape) like a keyboard user would.
 */
export async function closeSheet(page: Page, opener: Cited) {
  if (!isPhone(page)) return
  await viewer(page).getByRole('button', { name: 'Close document' }).click()
  await expect(viewer(page)).toBeHidden()
  await expect(chip(page, opener)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
}

interface Measure {
  /** The target page has painted its canvas and text layer (the stored text is verified then). */
  rendered: boolean
  approximate: boolean
  pageNumbers: number[]
  inView: boolean
  boxes: { x: number, y: number, w: number, h: number }[]
  /** Per box: the share of its line's glyph ink on the canvas it covers vertically. */
  ink: { coverage: number, noInk: boolean }[]
  devicePixelRatio: number
}

/**
 * Runs in the browser: the overlay boxes relative to their page slot,
 * sub-pixel, and how much of each line's ink on the rendered canvas they
 * cover (the same scan as check:viewer assertion 4). The overlay and the
 * canvas are placed independently, so this ties the highlight to what is drawn.
 */
function measure(pageNumber: number): Measure {
  const viewerEl = document.querySelector('[aria-label="Document viewer"]')!
  const scroller = viewerEl.querySelector<HTMLElement>('[role="region"][tabindex]')!
  const slot = viewerEl.querySelector<HTMLElement>(`.pdf-page-slot[data-page-number="${pageNumber}"]`)
  const highlights = [...viewerEl.querySelectorAll<HTMLElement>('.pdf-highlight')]
  const origin = slot?.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  const first = highlights[0]?.getBoundingClientRect()
  const boxes = origin
    ? highlights.map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
      })
    : []

  const canvas = slot?.querySelector<HTMLCanvasElement>('.pdf-page canvas')
  const ctx = canvas?.width ? canvas.getContext('2d', { willReadFrequently: true }) : null
  const dpr = canvas && ctx ? canvas.width / canvas.getBoundingClientRect().width : 0
  // A line's ink run stops at the nearest horizontally overlapping box above /
  // below: with tight leading there is no blank pixel row between two lines.
  const overlapsX = (a: typeof boxes[number], b: typeof boxes[number]) => a.x < b.x + b.w && b.x < a.x + a.w
  const ink = boxes.map((box) => {
    if (!canvas || !ctx) return { coverage: 0, noInk: true }
    const above = Math.max(-Infinity, ...boxes.filter(o => o !== box && overlapsX(o, box) && o.y + o.h <= box.y + box.h / 2).map(o => o.y + o.h))
    const below = Math.min(Infinity, ...boxes.filter(o => o !== box && overlapsX(o, box) && o.y >= box.y + box.h / 2).map(o => o.y))
    const x = Math.floor(box.x * dpr)
    const w = Math.max(1, Math.ceil((box.x + box.w) * dpr) - x)
    const h = box.h
    const y = Math.max(0, Math.floor((box.y - h) * dpr))
    const rows = Math.min(canvas.height - y, Math.ceil(3 * h * dpr))
    if (rows <= 0) return { coverage: 0, noInk: true }
    const { data } = ctx.getImageData(x, y, w, rows)
    // < 200: at zoom 0.5 a dash is a light grey anti-aliased stroke (page is 255).
    const hasInk = (r: number) => {
      let dark = 0
      for (let c = 0; c < w; c++) {
        const i = (r * w + c) * 4
        if (data[i + 3]! > 0 && (data[i]! + data[i + 1]! + data[i + 2]!) / 3 < 200 && ++dark >= Math.min(2, w)) return true
      }
      return false
    }
    const top = Math.floor(box.y * dpr) - y
    const bottom = Math.ceil((box.y + h) * dpr) - y
    let seed = -1
    for (let r = Math.round((top + bottom) / 2), d = 0; seed === -1 && r - d >= top; d++) {
      if (r + d < bottom && hasInk(r + d)) seed = r + d
      else if (hasInk(r - d)) seed = r - d
    }
    if (seed === -1) return { coverage: 0, noInk: true }
    const minRow = Number.isFinite(above) ? Math.max(0, Math.ceil(above * dpr) - y) : 0
    const maxRow = Number.isFinite(below) ? Math.min(rows - 1, Math.floor(below * dpr) - y - 1) : rows - 1
    let a = seed
    while (a > minRow && hasInk(a - 1)) a--
    let b = seed
    while (b < maxRow && hasInk(b + 1)) b++
    return { coverage: Math.max(0, Math.min(bottom, b + 1) - Math.max(top, a)) / (b + 1 - a), noInk: false }
  })

  return {
    rendered: !!canvas && !!slot!.querySelector('.pdf-page .textLayer'),
    approximate: /Approximate highlight|Passage not located/.test(viewerEl.textContent ?? ''),
    pageNumbers: highlights.map(el => Number(el.closest<HTMLElement>('.pdf-page-slot')?.dataset.pageNumber)),
    inView: !!first && first.top >= view.top && first.bottom <= view.bottom,
    boxes,
    ink,
    devicePixelRatio: window.devicePixelRatio,
  }
}

/**
 * Where the overlay boxes must be at `zoom`: the stored PDF-space rects
 * converted independently of the app (x·z, (pageHeight − y)·z; the golden pages
 * have no rotation or offset origin), minus the lines in the running header /
 * footer band the viewer drops (the band is symmetric, so PDF-space centres
 * select the same lines).
 */
export function expectedBoxes(span: SpanFixture, zoom: number) {
  const band = RUNNING_MARGIN * span.pageHeight
  const body = span.chunk.rects.filter(r => (r.y1 + r.y2) / 2 >= band && (r.y1 + r.y2) / 2 <= span.pageHeight - band)
  return (body.length ? body : span.chunk.rects).map(r => ({ x: r.x1 * zoom, y: (span.pageHeight - r.y2) * zoom, w: (r.x2 - r.x1) * zoom, h: (r.y2 - r.y1) * zoom }))
}

/** Everything wrong with the highlight shown for `span` at `zoom` (empty: correct). */
async function highlightProblems(page: Page, span: SpanFixture, zoom: number): Promise<string[]> {
  const m = await page.evaluate(measure, span.page)
  const expected = expectedBoxes(span, zoom)
  const problems: string[] = []
  if (!m.rendered) problems.push(`page ${span.page} not rendered`)
  if (m.approximate) problems.push('marked approximate')
  if (!m.pageNumbers.length || m.pageNumbers.some(n => n !== span.page)) problems.push(`highlight on page(s) ${[...new Set(m.pageNumbers)].join(', ') || 'none'}, not ${span.page}`)
  if (m.boxes.length !== expected.length) problems.push(`${m.boxes.length} boxes, expected ${expected.length}`)
  else {
    const error = Math.max(...m.boxes.map((b, i) => Math.max(Math.abs(b.x - expected[i]!.x), Math.abs(b.y - expected[i]!.y), Math.abs(b.w - expected[i]!.w), Math.abs(b.h - expected[i]!.h))))
    if (!(error <= POSITION_TOLERANCE_PX)) problems.push(`box off by ${error.toFixed(2)} px`)
  }
  if (!m.inView) problems.push('highlight not scrolled into view')
  // Integer DPR only (desktop runs at 2, like check:viewer): at the phone's
  // 2.625 a glyph edge falls mid device pixel, and anti-aliasing alone costs
  // a line ~4%. Boxes under 2 CSS px wide (a lone "," at 50%) are too faint to verify.
  if (!Number.isInteger(m.devicePixelRatio)) return problems
  const lines = m.ink.filter((_, i) => m.boxes[i]!.w >= 2)
  const covered = lines.filter(ink => !ink.noInk && ink.coverage >= minInkCoverage(zoom)).length
  if (lines.some(ink => ink.noInk) || covered < MIN_COVERED_SHARE * lines.length) {
    const low = m.ink.flatMap((ink, i) => m.boxes[i]!.w >= 2 && (ink.noInk || ink.coverage < minInkCoverage(zoom)) ? [`box ${i} ${ink.noInk ? 'no ink' : ink.coverage.toFixed(3)}`] : [])
    problems.push(`ink covered on ${covered}/${lines.length} lines (min ${minInkCoverage(zoom)}): ${low.join(', ')}`)
  }
  return problems
}

/**
 * The viewer shows `source` (right document, right page) with the overlay
 * where its stored rects say at `zoom`, scrolled into view and exact.
 */
export async function expectHighlight(page: Page, span: SpanFixture, source: Cited, zoom: number) {
  const v = viewer(page)
  await expect(v).toHaveAttribute('data-document-id', source.documentId)
  await expect(v.getByRole('region', { name: `${source.filename}, PDF pages` })).toBeVisible()
  expect(await viewerZoom(page)).toBeCloseTo(zoom, 6)
  await expect.poll(() => highlightProblems(page, span, zoom), {
    message: `${span.id} (${source.filename} p. ${span.page}) at zoom ${zoom}`,
  }).toEqual([])
}
