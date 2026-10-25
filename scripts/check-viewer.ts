// Phase 5 acceptance: "every golden citation highlights the correct passage at
// multiple zoom levels" — checked against the real app in headless Chromium.
//
//   pnpm exec playwright-core install chromium   # once: the headless browser
//   NUXT_DISABLE_RATE_LIMIT=1 pnpm dev            # many page loads; dev only, see nuxt.config.ts
//   pnpm check:viewer [--base http://localhost:3000] [--zooms 0.5,1,2] [--only g-020#1]
//   pnpm check:viewer --mutate down2|up2|shrink2  # self-test: every check must fail
//
// For each golden evidence span: find the stored chunk containing it, open the
// citation deep link /?chunk=<id>&zoom=<z>, and assert
//   1. the viewer loaded the right document (data-document-id, plus the name
//      the reader sees: the short title in the header and the page region's
//      label, app/utils/corpus.ts) and the highlight is on the right page,
//      not marked approximate
//   2. the highlight is scrolled into the visible part of the viewer
//   3. every overlay box sits within 0.5 CSS px (sub-pixel, unrounded) of where
//      the PDF-space rect in test/fixtures/highlight-spans.json says, using an
//      independent conversion (x·z, (pageHeight − y)·z — the golden pages have
//      no rotation or offset origin, checked in the Phase 3.5 spike). The
//      fixture is computed from the PDFs, so stored highlights that predate a
//      highlight-math change fail here until `pnpm ingest:golden
//      --highlights-only` refreshes them.
//   4. every overlay box covers its glyph ink on the rendered canvas
//      (≥ 0.99 at zoom ≥ 1 per SPEC, ≥ 0.9 at 0.5). Ink is text ink only: a
//      dark canvas pixel that a graphics-only reference render of the same
//      page (text-showing operators skipped) does not also have. Rules,
//      frames and images are in both renders and drop out, so a vector frame
//      around a word no longer counts as that line's ink (ADR-0004). And
//      at most 0.2% of the text ink connected to highlighted ink may lie
//      outside every box (a glyph hanging out of its box, e.g. a big operator).
//   5. PDF.js ran in a real worker (no main-thread "fake worker" fallback,
//      e.g. when COEP or CSP blocks the worker script)
//
// The reference renders use the same Chromium and pdfjs-dist build the app
// bundles, at the app canvas's size, scale and device-pixel transform. The
// unfiltered one must reproduce the app canvas, or the text mask would be
// meaningless and the check fails with the reason: a size difference, or any
// differing pixel that could change the mask (a text pixel of the reference,
// or a graphics pixel off by more than GFX_TOLERANCE). The app canvas is not
// always bit-identical: on self-rag.pdf p. 5 (g-045), a few anti-aliased
// vector-path pixels come out 1–4 levels off now and then, also after a
// reload; those cannot move a pixel across the mask's threshold, so they are
// only reported (referenceNoise).
//
// --mutate moves (down2, up2) or shrinks (shrink2: 1 px off top and bottom)
// every overlay box by 2 CSS px in the DOM before measuring. The run then
// succeeds only if every span × zoom check fails. It also reports how many
// fail the ink gate alone (with the position check set aside): boxes leave
// ~1.3 pt above and 0.5–1 pt below the ink, so a 2 px shift at 200% (1 pt) can
// stay within them; the 0.5 px position check is what catches every one.

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { chromium, type Page } from 'playwright-core'
import { documentInfo } from '../app/utils/corpus'
import type { ChunkHighlight, HighlightRect } from '../shared/types'

const ROOT = resolve(import.meta.dirname, '..')
const MUTATIONS = ['none', 'down2', 'up2', 'shrink2'] as const
type Mutation = typeof MUTATIONS[number]
const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    zooms: { type: 'string', default: '0.5,1,2' },
    only: { type: 'string' },
    mutate: { type: 'string', default: 'none' },
  },
})
const zooms = values.zooms.split(',').map(Number)
if (!(MUTATIONS as readonly string[]).includes(values.mutate)) throw new Error(`--mutate must be one of ${MUTATIONS.join(', ')}`)
const mutate = values.mutate as Mutation
/** Mirrors RUNNING_MARGIN in app/utils/pdf-highlight.ts. */
const RUNNING_MARGIN = 0.075

interface Fixture { id: string, document: string, page: number, pageHeight: number, chunk: { start: number, end: number, rects: HighlightRect[] } }
let fixtures: Fixture[] = JSON.parse(await readFile(join(ROOT, 'test/fixtures/highlight-spans.json'), 'utf8'))
if (values.only) fixtures = fixtures.filter(f => values.only!.split(',').includes(f.id))

const POSITION_TOLERANCE_PX = 0.5
/**
 * Share of a line's glyph ink its overlay box must cover (boxes ≥ 2 CSS px
 * wide): SPEC's ≥ 0.99 at zoom ≥ 100%; at 50% a line is ~5 px tall and one
 * device pixel of anti-aliasing is already ~10%.
 */
const minInkCoverage = (zoom: number) => (zoom >= 1 ? 0.99 : 0.9)
/**
 * Max channel difference at which an app-canvas pixel still counts as the
 * graphics-only render's pixel (not text ink). Text over a white or tinted
 * background differs by far more; identical renders differ by 0.
 */
const GFX_TOLERANCE = 8
/**
 * Share of the text ink connected to highlighted ink that may lie outside
 * every box (anti-aliased fringes, a kerned neighbour touching the first or
 * last glyph). Correct highlights measured ≤ 0.0010 on all 180 checks;
 * g-035 before its big-operator glyph rects measured 0.0077–0.0082.
 */
const MAX_STRAY_INK = 0.002

// Stored chunk for each fixture: same document + page + chunk start offset.
const supabase = createClient(process.env.NUXT_SUPABASE_URL!, process.env.NUXT_SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } })
const { data: docs, error } = await supabase.from('documents').select('id, filename')
if (error || !docs) throw new Error(`document lookup failed: ${error?.message}`)
const docId = new Map(docs.map(d => [d.filename as string, d.id as string]))

/** One query per fixture (page-scoped), so no global row limit can hide a chunk. */
async function chunkFor(f: Fixture): Promise<string | undefined> {
  const documentId = docId.get(f.document)
  if (!documentId) return undefined
  const { data, error } = await supabase.from('chunks').select('id, highlight')
    .eq('document_id', documentId).eq('page_number', f.page)
  if (error) throw new Error(`chunk lookup failed: ${error.message}`)
  return data.find(c => (c.highlight as ChunkHighlight | null)?.startOffset === f.chunk.start)?.id as string | undefined
}

interface MeasureArgs {
  pageNumber: number
  /** Base64 PNGs of the reference renders: everything, and graphics only. */
  fullPng: string
  graphicsPng: string
  mutate: Mutation
  gfxTolerance: number
}

interface Measure {
  /** The viewer header's document name (the selected item or the plain title). */
  header: string
  /** aria-label of the scrolling page region ("<short title>, PDF pages"). */
  regionLabel: string
  documentId: string | undefined
  approximate: boolean
  pageNumbers: number[]
  inView: boolean
  boxes: { x: number, y: number, w: number, h: number }[]
  ink: { coverage: number, noInk: boolean }[]
  /** Text-ink pixels connected to ink inside a box, and how many of them lie outside every box. */
  stray: { connected: number, outside: number }
  /** Canvas size, and the reference renders' (full, graphics-only; all must be equal). */
  canvasSize: [number, number]
  referenceSizes: [[number, number], [number, number]]
  /** App-canvas pixels that differ from the full reference render at all. */
  refMismatch: number
  /** Of those, the ones that could change the text mask (must be 0). */
  refUnsafe: number
}

/** Runs in the browser: reads the viewer DOM and scans the target page's canvas. */
async function measure({ pageNumber, fullPng, graphicsPng, mutate, gfxTolerance }: MeasureArgs): Promise<Measure> {
  const viewerEl = document.querySelector('[aria-label="Document viewer"]')!
  const scroller = viewerEl.querySelector<HTMLElement>('[role="region"][tabindex]')!
  const highlights = [...viewerEl.querySelectorAll<HTMLElement>('.pdf-highlight')]

  // Self-test: perturb the overlay boxes before anything is measured.
  for (const el of highlights) {
    const top = Number.parseFloat(el.style.top)
    const height = Number.parseFloat(el.style.height)
    if (mutate === 'down2') el.style.top = `${top + 2}px`
    if (mutate === 'up2') el.style.top = `${top - 2}px`
    if (mutate === 'shrink2') {
      el.style.top = `${top + 1}px`
      el.style.height = `${height - 2}px`
    }
  }

  const decode = async (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    const scratch = new OffscreenCanvas(bitmap.width, bitmap.height)
    const scratchCtx = scratch.getContext('2d')!
    scratchCtx.drawImage(bitmap, 0, 0)
    return scratchCtx.getImageData(0, 0, bitmap.width, bitmap.height)
  }
  const full = await decode(fullPng)
  const graphics = await decode(graphicsPng)

  const slot = viewerEl.querySelector<HTMLElement>(`.pdf-page-slot[data-page-number="${pageNumber}"]`)!
  const canvas = slot.querySelector('canvas')!
  const dpr = canvas.width / canvas.getBoundingClientRect().width
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const view = scroller.getBoundingClientRect()
  const first = highlights[0]?.getBoundingClientRect()

  // The text mask is only valid if the reference renders what the app drew.
  const sameSize = full.width === canvas.width && full.height === canvas.height
    && graphics.width === canvas.width && graphics.height === canvas.height
  let refMismatch = 0
  let refUnsafe = 0
  if (sameSize) {
    const all = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const f = full.data
    const g = graphics.data
    for (let i = 0; i < all.length; i += 4) {
      if (all[i] === f[i] && all[i + 1] === f[i + 1] && all[i + 2] === f[i + 2] && all[i + 3] === f[i + 3]) continue
      refMismatch++
      // Safe only on a pure graphics pixel (no text drawn there in the
      // reference) whose colour stays within the mask's graphics tolerance.
      const textPixel = f[i] !== g[i] || f[i + 1] !== g[i + 1] || f[i + 2] !== g[i + 2] || f[i + 3] !== g[i + 3]
      const off = Math.max(Math.abs(all[i]! - f[i]!), Math.abs(all[i + 1]! - f[i + 1]!), Math.abs(all[i + 2]! - f[i + 2]!))
      if (textPixel || off > gfxTolerance || all[i + 3] !== f[i + 3]) refUnsafe++
    }
  }

  // Sub-pixel boxes relative to the page slot (offsetLeft/Top round to integers).
  const origin = slot.getBoundingClientRect()
  const boxes = highlights.map((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
  })

  // A box's ink run must not run into a neighbouring highlighted box: with
  // tight leading there is no blank pixel row between two lines, and the run
  // would take in both (≈ 0.5 coverage for a perfect box). Stop at the nearest
  // horizontally overlapping box above / below; its ink is that box's. This
  // also splits a big operator's glyph rect from its line rect (ADR-0004).
  const overlapsX = (a: typeof boxes[number], b: typeof boxes[number]) => a.x < b.x + b.w && b.x < a.x + a.w
  const ink = boxes.map((box) => {
    const above = Math.max(-Infinity, ...boxes.filter(o => o !== box && overlapsX(o, box) && o.y + o.h <= box.y + box.h / 2).map(o => o.y + o.h))
    const below = Math.min(Infinity, ...boxes.filter(o => o !== box && overlapsX(o, box) && o.y >= box.y + box.h / 2).map(o => o.y))
    const x = Math.floor(box.x * dpr)
    const w = Math.max(1, Math.ceil((box.x + box.w) * dpr) - x)
    const h = box.h
    const y = Math.max(0, Math.floor((box.y - h) * dpr))
    const rows = Math.min(canvas.height - y, Math.ceil(3 * h * dpr))
    const { data } = ctx.getImageData(x, y, w, rows)
    const hasInk = (r: number) => {
      let dark = 0
      for (let c = 0; c < w; c++) {
        const i = (r * w + c) * 4
        // < 200, not < 160: at zoom 0.5 a dash is a sub-pixel stroke whose
        // anti-aliased pixels are light grey (page background is 255).
        // min(2, w): a lone punctuation item can be 1 CSS px (2 device px) wide.
        if (data[i + 3]! === 0 || (data[i]! + data[i + 1]! + data[i + 2]!) / 3 >= 200) continue
        // Text ink only: the graphics-only render has a different pixel here.
        const g = ((y + r) * graphics.width + x + c) * 4
        const graphic = Math.max(Math.abs(data[i]! - graphics.data[g]!), Math.abs(data[i + 1]! - graphics.data[g + 1]!), Math.abs(data[i + 2]! - graphics.data[g + 2]!)) <= gfxTolerance
        if (!graphic && ++dark >= Math.min(2, w)) return true
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
    const inside = Math.max(0, Math.min(bottom, b + 1) - Math.max(top, a))
    return { coverage: inside / (b + 1 - a), noInk: false }
  })

  // Stray ink: the run above starts from one seed row and stops at gaps and
  // at neighbouring boxes, so a glyph part hanging below its box into the
  // next line's box goes unseen (g-035's display ∑ before its glyph rect).
  // Here every text-ink pixel 8-connected to text ink inside a box must be
  // inside a box too. Searched within the boxes' hull, widened by one box
  // height sideways and two up and down (∑ hangs ≤ 1.4 em).
  const maxH = Math.max(0, ...boxes.map(b => b.h))
  const rx0 = Math.max(0, Math.floor((Math.min(...boxes.map(b => b.x)) - maxH) * dpr))
  const rx1 = Math.min(canvas.width, Math.ceil((Math.max(...boxes.map(b => b.x + b.w)) + maxH) * dpr))
  const ry0 = Math.max(0, Math.floor((Math.min(...boxes.map(b => b.y)) - 2 * maxH) * dpr))
  const ry1 = Math.min(canvas.height, Math.ceil((Math.max(...boxes.map(b => b.y + b.h)) + 2 * maxH) * dpr))
  const stray = { connected: 0, outside: 0 }
  if (boxes.length && rx1 > rx0 && ry1 > ry0) {
    const W = rx1 - rx0
    const H = ry1 - ry0
    const px = ctx.getImageData(rx0, ry0, W, H).data
    const text = new Uint8Array(W * H)
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = (r * W + c) * 4
        if (px[i + 3]! === 0 || (px[i]! + px[i + 1]! + px[i + 2]!) / 3 >= 200) continue
        const g = ((ry0 + r) * graphics.width + rx0 + c) * 4
        if (Math.max(Math.abs(px[i]! - graphics.data[g]!), Math.abs(px[i + 1]! - graphics.data[g + 1]!), Math.abs(px[i + 2]! - graphics.data[g + 2]!)) > gfxTolerance) text[r * W + c] = 1
      }
    }
    // Device-pixel centre inside a box (CSS px)?
    const inBox = (k: number) => {
      const cx = (rx0 + (k % W) + 0.5) / dpr
      const cy = (ry0 + Math.floor(k / W) + 0.5) / dpr
      return boxes.some(b => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h)
    }
    const seen = new Uint8Array(W * H)
    const stack: number[] = []
    for (let k = 0; k < W * H; k++) {
      if (text[k] && inBox(k)) {
        seen[k] = 1
        stack.push(k)
      }
    }
    while (stack.length) {
      const k = stack.pop()!
      stray.connected++
      if (!inBox(k)) stray.outside++
      const r = Math.floor(k / W)
      const c = k % W
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (r + dr < 0 || r + dr >= H || c + dc < 0 || c + dc >= W) continue
          const n = k + dr * W + dc
          if (text[n] && !seen[n]) {
            seen[n] = 1
            stack.push(n)
          }
        }
      }
    }
  }

  return {
    header: viewerEl.querySelector('header h2')?.textContent?.trim() ?? '',
    regionLabel: scroller.getAttribute('aria-label') ?? '',
    documentId: (viewerEl as HTMLElement).dataset.documentId,
    approximate: viewerEl.textContent?.includes('Approximate highlight') ?? false,
    pageNumbers: highlights.map(el => Number(el.closest<HTMLElement>('.pdf-page-slot')?.dataset.pageNumber)),
    inView: !!first && first.top >= view.top && first.bottom <= view.bottom,
    boxes,
    ink,
    stray,
    canvasSize: [canvas.width, canvas.height],
    referenceSizes: [[full.width, full.height], [graphics.width, graphics.height]],
    refMismatch,
    refUnsafe,
  }
}

async function check(page: Page, f: Fixture, chunkId: string, zoom: number) {
  fakeWorker = false
  await page.goto(`${values.base}/?chunk=${chunkId}&zoom=${zoom}`, { waitUntil: 'networkidle', timeout: 120_000 })
  await page.waitForSelector(`.pdf-page-slot[data-page-number="${f.page}"] canvas`, { timeout: 60_000 })
  await page.waitForSelector('.pdf-highlight', { timeout: 30_000 })
  // Wait for scrolling to settle: the same scrollTop across 300 ms.
  await page.waitForFunction(async () => {
    const el = document.querySelector('[aria-label="Document viewer"] [role="region"][tabindex]')
    const before = el?.scrollTop
    await new Promise(r => setTimeout(r, 300))
    return el?.scrollTop === before
  }, null, { timeout: 30_000 })
  const canvas = await page.evaluate((n) => {
    const el = document.querySelector<HTMLCanvasElement>(`.pdf-page-slot[data-page-number="${n}"] canvas`)!
    return { width: el.width, height: el.height, dpr: el.width / el.getBoundingClientRect().width }
  }, f.page)
  const reference = await referenceRenders(docId.get(f.document)!, f.page, zoom, canvas)
  const m = await page.evaluate(measure, { pageNumber: f.page, fullPng: reference.full, graphicsPng: reference.graphics, mutate, gfxTolerance: GFX_TOLERANCE } satisfies MeasureArgs)

  // The viewer drops lines in the running header/footer band (dropRunningMargins
  // in app/utils/pdf-highlight.ts, which tsx can't import: '#shared' aliases);
  // the band is symmetric, so PDF-space centres select the same lines.
  const band = RUNNING_MARGIN * f.pageHeight
  const body = f.chunk.rects.filter(r => (r.y1 + r.y2) / 2 >= band && (r.y1 + r.y2) / 2 <= f.pageHeight - band)
  const expected = (body.length ? body : f.chunk.rects).map(r => ({ x: r.x1 * zoom, y: (f.pageHeight - r.y2) * zoom, w: (r.x2 - r.x1) * zoom, h: (r.y2 - r.y1) * zoom }))
  const posError = m.boxes.length === expected.length
    ? Math.max(...m.boxes.map((b, i) => Math.max(Math.abs(b.x - expected[i]!.x), Math.abs(b.y - expected[i]!.y), Math.abs(b.w - expected[i]!.w), Math.abs(b.h - expected[i]!.h))))
    : Number.POSITIVE_INFINITY
  // The name the reader sees for this document (it was the filename until
  // b01075e; now the short title from app/utils/corpus.ts).
  const label = documentInfo(f.document).short
  return {
    id: f.id,
    zoom,
    rightDocument: m.documentId === docId.get(f.document) && m.header === label && m.regionLabel === `${label}, PDF pages`,
    exact: !m.approximate,
    realWorker: !fakeWorker,
    rightPage: m.pageNumbers.length > 0 && m.pageNumbers.every(n => n === f.page),
    inView: m.inView,
    boxes: `${m.boxes.length}/${expected.length}`,
    posError,
    minInk: Math.min(...m.ink.filter((_, n) => m.boxes[n]!.w >= 2).map(i => i.coverage)),
    lowInkBoxes: m.ink.flatMap((i, n) => (i.noInk || i.coverage < minInkCoverage(zoom) ? [{ box: n, ...m.boxes[n], coverage: +i.coverage.toFixed(3) }] : [])),
    // A box under 2 CSS px wide is a lone punctuation item (",", "-") at low
    // zoom: its anti-aliased stroke is too faint to verify, so it is counted
    // separately instead of failing the check.
    noInk: m.ink.filter((i, n) => i.noInk && m.boxes[n]!.w >= 2).length,
    tooSmall: m.boxes.filter(b => b.w < 2).length,
    strayInk: m.stray.connected ? +(m.stray.outside / m.stray.connected).toFixed(4) : 0,
    // Why the text-ink mask can't be trusted, if it can't (fails the check).
    reference: m.referenceSizes.some(size => size.join('×') !== m.canvasSize.join('×'))
      ? `reference renders are ${m.referenceSizes.map(size => size.join('×')).join(' / ')} px, app canvas ${m.canvasSize.join('×')} px`
      : m.refUnsafe > 0 ? `reference render differs from the app canvas in ${m.refUnsafe} px that could change the text mask` : 'ok',
    referenceNoise: m.refMismatch - m.refUnsafe,
    ...(m.documentId === docId.get(f.document) && m.header === label ? {} : { header: m.header, documentId: m.documentId }),
  }
}

type Result = Awaited<ReturnType<typeof check>>
const inkPasses = (r: Result) => r.reference === 'ok' && r.noInk === 0 && r.minInk >= minInkCoverage(r.zoom) && r.strayInk <= MAX_STRAY_INK
const passes = (r: Result) =>
  r.rightDocument && r.rightPage && r.exact && r.realWorker && r.inView && r.posError <= POSITION_TOLERANCE_PX && inkPasses(r)

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage()

// Reference renders for the text-ink mask, in a separate browser context so
// nothing here touches the app page being checked (the routed page below has
// no CSP and its own PDF.js instance). The PDF and the PDF.js data files come
// from the app's origin, like the viewer's.
const reference = await (await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 })).newPage()
const PDFJS = join(ROOT, 'node_modules/pdfjs-dist/legacy/build')
const REFERENCE_PREFIX = '/__ink-reference/'
await reference.route(`${values.base}${REFERENCE_PREFIX}**`, async (route) => {
  const name = new URL(route.request().url()).pathname.slice(REFERENCE_PREFIX.length)
  if (name === 'index.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body>' })
  // The legacy build, as the app loads it (app/utils/pdf-highlight.ts loadPdfjs).
  if (name === 'pdf.mjs' || name === 'pdf.worker.min.mjs') return route.fulfill({ contentType: 'text/javascript', body: await readFile(join(PDFJS, name)) })
  return route.fulfill({ status: 404 })
})
// tsx compiles with esbuild keepNames, which wraps functions in a __name()
// helper; functions passed to evaluate() run in the page, where it does not exist.
await reference.addInitScript({ content: 'globalThis.__name = (fn) => fn' })
await reference.goto(`${values.base}${REFERENCE_PREFIX}index.html`)

const pdfUrls = new Map<string, string>()
/** The page rendered like renderPage() in the app, with and without its text-showing operators. */
async function referenceRenders(documentId: string, pageNumber: number, scale: number, canvas: { width: number, height: number, dpr: number }) {
  if (!pdfUrls.has(documentId)) {
    const res = await fetch(`${values.base}/api/documents/${documentId}/file`)
    if (!res.ok) throw new Error(`file URL for ${documentId}: HTTP ${res.status}`)
    pdfUrls.set(documentId, ((await res.json()) as { url: string }).url)
  }
  return reference.evaluate(async ({ url, pageNumber, scale, canvas, prefix }) => {
    // A runtime URL, not a module specifier TypeScript could resolve.
    const pdfjs = await (import(`${prefix}pdf.mjs`) as Promise<typeof import('pdfjs-dist')>)
    pdfjs.GlobalWorkerOptions.workerSrc = `${prefix}pdf.worker.min.mjs`
    const cache = globalThis as unknown as { referencePdfs?: Record<string, Promise<PDFDocumentProxy>> }
    cache.referencePdfs ??= {}
    // Same data files as the viewer (PDFJS_ASSET_OPTIONS in app/utils/pdf-highlight.ts).
    cache.referencePdfs[url] ??= pdfjs.getDocument({ url, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/', iccUrl: '/pdfjs/iccs/' }).promise
    const pdf = await cache.referencePdfs[url]
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const TEXT_OPS = new Set([pdfjs.OPS.showText, pdfjs.OPS.showSpacedText, pdfjs.OPS.nextLineShowText, pdfjs.OPS.nextLineSetSpacingShowText])
    const draw = async (operationsFilter?: (index: number, ops: { fnArray: number[] }) => boolean) => {
      const el = document.createElement('canvas')
      el.width = canvas.width
      el.height = canvas.height
      await page.render({ canvas: el, viewport, transform: canvas.dpr === 1 ? undefined : [canvas.dpr, 0, 0, canvas.dpr, 0, 0], operationsFilter }).promise
      const png = el.toDataURL('image/png').split(',')[1]!
      el.width = el.height = 0
      return png
    }
    return { full: await draw(), graphics: await draw((index, ops) => !TEXT_OPS.has(ops.fnArray[index]!)) }
  }, { url: pdfUrls.get(documentId)!, pageNumber, scale, canvas, prefix: REFERENCE_PREFIX })
}

// PDF.js warns "Setting up fake worker." when the worker script can't start.
let fakeWorker = false
page.on('console', (message) => {
  if (/fake worker/i.test(message.text())) fakeWorker = true
})
await page.addInitScript({ content: 'globalThis.__name = (fn) => fn' })
const results = []
try {
  for (const f of fixtures) {
    const chunkId = await chunkFor(f)
    if (!chunkId) {
      console.log(`${f.id}: no stored chunk found`)
      results.push({ id: f.id, zoom: 0, missing: true })
      continue
    }
    for (const zoom of zooms) {
      const r = await check(page, f, chunkId, zoom).catch(error => ({ id: f.id, zoom, failed: String(error).slice(0, 160) }))
      results.push(r)
      // Normal run: every failing check; self-test: every check that still passes.
      const shown = !('rightPage' in r) || (mutate === 'none') !== passes(r)
      if (shown) console.log(`✗ ${JSON.stringify(r)}`)
    }
    process.stdout.write('.')
  }
}
finally {
  await browser.close()
}

const done = results.filter((r): r is Result => 'rightPage' in r)
const pass = done.filter(passes)
console.log(`\n\n${pass.length}/${results.length} span×zoom checks pass (${fixtures.length} spans × ${zooms.length} zooms)`)
for (const zoom of zooms) {
  const z = done.filter(r => r.zoom === zoom)
  const pos = z.map(r => r.posError).sort((a, b) => a - b)
  console.log(`  zoom ${zoom}: right doc ${z.filter(r => r.rightDocument).length}/${z.length} · right page ${z.filter(r => r.rightPage).length}/${z.length} · exact ${z.filter(r => r.exact).length}/${z.length} · real worker ${z.filter(r => r.realWorker).length}/${z.length} · in view ${z.filter(r => r.inView).length}/${z.length} · max box error ${pos.at(-1)?.toFixed(2)} px · min ink coverage ${Math.min(...z.map(r => r.minInk)).toFixed(3)} · boxes without ink ${z.reduce((s, r) => s + r.noInk, 0)} · too small to verify ${z.reduce((s, r) => s + r.tooSmall, 0)} · max stray ink ${Math.max(...z.map(r => r.strayInk)).toFixed(4)} · reference mismatches ${z.filter(r => r.reference !== 'ok').length} (harmless pixels in ${z.filter(r => r.referenceNoise > 0).length} checks, max ${Math.max(...z.map(r => r.referenceNoise))})`)
}
if (mutate === 'none') {
  if (pass.length !== results.length) process.exitCode = 1
}
else {
  // Self-test: a 2 px error must fail every check. Ink-gate failures count
  // only where the reference matched (else the mask, not the boxes, failed).
  const failed = done.filter(r => !passes(r))
  const inkCaught = done.filter(r => r.reference === 'ok' && !inkPasses(r))
  console.log(`--mutate ${mutate}: ${failed.length}/${results.length} checks fail (ink gate alone: ${inkCaught.length}/${results.length})`)
  if (failed.length !== results.length) process.exitCode = 1
}
