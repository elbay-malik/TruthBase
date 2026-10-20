// Phase 5 acceptance: "every golden citation highlights the correct passage at
// multiple zoom levels" — checked against the real app in headless Chromium.
//
//   pnpm exec playwright-core install chromium   # once: the headless browser
//   NUXT_DISABLE_RATE_LIMIT=1 pnpm dev            # many page loads; dev only, see nuxt.config.ts
//   pnpm check:viewer [--base http://localhost:3000] [--zooms 0.5,1,2] [--only g-020#1]
//
// For each golden evidence span: find the stored chunk containing it, open the
// citation deep link /?chunk=<id>&zoom=<z>, and assert
//   1. the viewer loaded the right document (its id, not just the filename)
//      and the highlight is on the right page, not marked approximate
//   2. the highlight is scrolled into the visible part of the viewer
//   3. every overlay box sits within 0.5 CSS px (sub-pixel, unrounded) of where
//      the stored PDF-space rect says, using an independent conversion
//      (x·z, (pageHeight − y)·z — the golden pages have no rotation or offset
//      origin, checked in the Phase 3.5 spike)
//   4. every overlay line covers its glyph ink on the rendered canvas
//      (≥ 0.99 at zoom ≥ 1 per SPEC, ≥ 0.9 at 0.5)
//   5. PDF.js ran in a real worker (no main-thread "fake worker" fallback,
//      e.g. when COEP or CSP blocks the worker script)

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { chromium, type Page } from 'playwright-core'
import type { ChunkHighlight, HighlightRect } from '../shared/types'

const ROOT = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    zooms: { type: 'string', default: '0.5,1,2' },
    only: { type: 'string' },
  },
})
const zooms = values.zooms.split(',').map(Number)
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

interface Measure {
  header: string
  documentId: string | undefined
  approximate: boolean
  pageNumbers: number[]
  inView: boolean
  boxes: { x: number, y: number, w: number, h: number }[]
  ink: { coverage: number, noInk: boolean }[]
}

/** Runs in the browser: reads the viewer DOM and scans the target page's canvas. */
function measure(pageNumber: number): Measure {
  const viewerEl = document.querySelector('[aria-label="Document viewer"]')!
  const scroller = viewerEl.querySelector<HTMLElement>('.overflow-auto')!
  const highlights = [...viewerEl.querySelectorAll<HTMLElement>('.pdf-highlight')]
  const slot = viewerEl.querySelector<HTMLElement>(`.pdf-page-slot[data-page-number="${pageNumber}"]`)!
  const canvas = slot.querySelector('canvas')!
  const dpr = canvas.width / canvas.getBoundingClientRect().width
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const view = scroller.getBoundingClientRect()
  const first = highlights[0]?.getBoundingClientRect()

  // Sub-pixel boxes relative to the page slot (offsetLeft/Top round to integers).
  const origin = slot.getBoundingClientRect()
  const boxes = highlights.map((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
  })

  // A line's ink run must not run into a neighbouring highlighted line: with
  // tight leading there is no blank pixel row between two lines, and the run
  // would take in both (≈ 0.5 coverage for a perfect box). Stop at the nearest
  // horizontally overlapping box above / below; its ink is that line's.
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
    const inside = Math.max(0, Math.min(bottom, b + 1) - Math.max(top, a))
    return { coverage: inside / (b + 1 - a), noInk: false }
  })

  return {
    header: viewerEl.querySelector('header')?.textContent ?? '',
    documentId: (viewerEl as HTMLElement).dataset.documentId,
    approximate: viewerEl.textContent?.includes('Approximate highlight') ?? false,
    pageNumbers: highlights.map(el => Number(el.closest<HTMLElement>('.pdf-page-slot')?.dataset.pageNumber)),
    inView: !!first && first.top >= view.top && first.bottom <= view.bottom,
    boxes,
    ink,
  }
}

async function check(page: Page, f: Fixture, chunkId: string, zoom: number) {
  fakeWorker = false
  await page.goto(`${values.base}/?chunk=${chunkId}&zoom=${zoom}`, { waitUntil: 'networkidle', timeout: 120_000 })
  await page.waitForSelector(`.pdf-page-slot[data-page-number="${f.page}"] canvas`, { timeout: 60_000 })
  await page.waitForSelector('.pdf-highlight', { timeout: 30_000 })
  // Wait for scrolling to settle: the same scrollTop across 300 ms.
  await page.waitForFunction(async () => {
    const el = document.querySelector('[aria-label="Document viewer"] .overflow-auto')
    const before = el?.scrollTop
    await new Promise(r => setTimeout(r, 300))
    return el?.scrollTop === before
  }, null, { timeout: 30_000 })
  const m = await page.evaluate(measure, f.page)

  // The viewer drops lines in the running header/footer band (dropRunningMargins
  // in app/utils/pdf-highlight.ts, which tsx can't import: '#shared' aliases);
  // the band is symmetric, so PDF-space centres select the same lines.
  const band = RUNNING_MARGIN * f.pageHeight
  const body = f.chunk.rects.filter(r => (r.y1 + r.y2) / 2 >= band && (r.y1 + r.y2) / 2 <= f.pageHeight - band)
  const expected = (body.length ? body : f.chunk.rects).map(r => ({ x: r.x1 * zoom, y: (f.pageHeight - r.y2) * zoom, w: (r.x2 - r.x1) * zoom, h: (r.y2 - r.y1) * zoom }))
  const posError = m.boxes.length === expected.length
    ? Math.max(...m.boxes.map((b, i) => Math.max(Math.abs(b.x - expected[i]!.x), Math.abs(b.y - expected[i]!.y), Math.abs(b.w - expected[i]!.w), Math.abs(b.h - expected[i]!.h))))
    : Number.POSITIVE_INFINITY
  return {
    id: f.id,
    zoom,
    rightDocument: m.header.includes(f.document) && m.documentId === docId.get(f.document),
    exact: !m.approximate,
    realWorker: !fakeWorker,
    rightPage: m.pageNumbers.length > 0 && m.pageNumbers.every(n => n === f.page),
    inView: m.inView,
    posError,
    minInk: Math.min(...m.ink.filter((_, n) => m.boxes[n]!.w >= 2).map(i => i.coverage)),
    lowInkBoxes: m.ink.flatMap((i, n) => (i.noInk || i.coverage < minInkCoverage(zoom) ? [{ box: n, ...m.boxes[n], coverage: +i.coverage.toFixed(3) }] : [])),
    // A box under 2 CSS px wide is a lone punctuation item (",", "-") at low
    // zoom: its anti-aliased stroke is too faint to verify, so it is counted
    // separately instead of failing the check.
    noInk: m.ink.filter((i, n) => i.noInk && m.boxes[n]!.w >= 2).length,
    tooSmall: m.boxes.filter(b => b.w < 2).length,
  }
}

const passes = (r: Awaited<ReturnType<typeof check>>) =>
  r.rightDocument && r.rightPage && r.exact && r.realWorker && r.inView && r.posError <= POSITION_TOLERANCE_PX && r.noInk === 0 && r.minInk >= minInkCoverage(r.zoom)

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage()
// PDF.js warns "Setting up fake worker." when the worker script can't start.
let fakeWorker = false
page.on('console', (message) => {
  if (/fake worker/i.test(message.text())) fakeWorker = true
})
// tsx compiles with esbuild keepNames, which wraps functions in a __name()
// helper; `measure` runs in the page, where that helper does not exist.
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
      if (!('rightPage' in r) || !passes(r)) console.log(`✗ ${JSON.stringify(r)}`)
    }
    process.stdout.write('.')
  }
}
finally {
  await browser.close()
}

const done = results.filter((r): r is Awaited<ReturnType<typeof check>> => 'rightPage' in r)
const pass = done.filter(passes)
console.log(`\n\n${pass.length}/${results.length} span×zoom checks pass (${fixtures.length} spans × ${zooms.length} zooms)`)
for (const zoom of zooms) {
  const z = done.filter(r => r.zoom === zoom)
  const pos = z.map(r => r.posError).sort((a, b) => a - b)
  console.log(`  zoom ${zoom}: right doc ${z.filter(r => r.rightDocument).length}/${z.length} · right page ${z.filter(r => r.rightPage).length}/${z.length} · exact ${z.filter(r => r.exact).length}/${z.length} · real worker ${z.filter(r => r.realWorker).length}/${z.length} · in view ${z.filter(r => r.inView).length}/${z.length} · max box error ${pos.at(-1)?.toFixed(2)} px · min ink coverage ${Math.min(...z.map(r => r.minInk)).toFixed(3)} · boxes without ink ${z.reduce((s, r) => s + r.noInk, 0)} · too small to verify ${z.reduce((s, r) => s + r.tooSmall, 0)}`)
}
if (pass.length !== results.length) process.exitCode = 1
