// Phase 3.5 spike runner: drives /spike/highlight in headless Chromium and
// summarizes how well stored highlight rects match the PDF.js text layer.
//
//   pnpm dev                                      # or: pnpm build && pnpm preview
//   pnpm spike:highlight                          # full run against http://localhost:3000
//   pnpm spike:highlight --base http://localhost:3123 --shot g-006#2 --shot g-032#1
//
// Writes <out>/spike-results.json (raw) and <out>/<span>@<zoom>.png screenshots.

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    out: { type: 'string', default: join(tmpdir(), 'truthbase-spike') },
    shot: { type: 'string', multiple: true, default: [] },
    dpr: { type: 'string', default: '2' },
  },
})

interface Metrics { iou: number, coverage: number, precision: number }
interface Edge { delta: number, atItemBoundary: boolean }
interface Result {
  id: string
  zoom: number
  textMatches: boolean
  start?: Edge
  end?: Edge
  ink: { noInk: boolean, coverage: number, topSlack: number, bottomSlack: number }[]
  hull: Metrics
  chunkHull: Metrics
  storedLines: number
  truthLines: number
}
interface PageCheck { document: string, page: number, rotate: number, viewOrigin: [number, number], sizeDelta: number, wholePixelSizes: boolean }
interface Spike {
  status: 'running' | 'done' | 'error'
  error?: string
  fakeWorker: boolean
  warnings: string[]
  pageChecks: PageCheck[]
  results: Result[]
  userAgent: string
  devicePixelRatio: number
}

await mkdir(values.out, { recursive: true })
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ deviceScaleFactor: Number(values.dpr), viewport: { width: 1400, height: 2000 } })
  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('console', m => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', e => consoleErrors.push(String(e)))

  const response = await page.goto(`${values.base}/spike/highlight`)
  const csp = response?.headers()['content-security-policy'] ?? '(none)'
  await page.waitForFunction(() => ['done', 'error'].includes((window as unknown as { __spike?: { status: string } }).__spike?.status ?? ''), null, { timeout: 300_000 })
  const spike = await page.evaluate(() => (window as unknown as { __spike: Spike }).__spike)
  await writeFile(join(values.out, 'spike-results.json'), JSON.stringify({ csp, consoleErrors, ...spike }, null, 1))

  if (spike.status !== 'done') {
    console.error('spike failed:', spike.error, '\nconsole errors:', consoleErrors)
    process.exitCode = 1
  }
  else {
    const results: Result[] = spike.results
    const q = (xs: number[], p: number) => {
      const sorted = [...xs].sort((a, b) => a - b)
      return sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))]! : Number.NaN
    }
    const stats = (xs: number[]) => `median ${q(xs, 0.5).toFixed(2)}  p10 ${q(xs, 0.1).toFixed(2)}  p90 ${q(xs, 0.9).toFixed(2)}  max|·| ${Math.max(...xs.map(Math.abs)).toFixed(2)}  (n=${xs.length})`

    console.log(`browser: ${/Chrome\/[\d.]+/.exec(spike.userAgent)?.[0]}  dpr ${spike.devicePixelRatio}  fake worker: ${spike.fakeWorker}`)
    console.log(`CSP worker-src: ${/worker-src [^;]+/.exec(csp)?.[0] ?? '(not set)'}`)
    const odd = spike.pageChecks.filter(c => c.rotate !== 0 || c.viewOrigin[0] !== 0 || c.viewOrigin[1] !== 0 || c.sizeDelta > 0.01 || !c.wholePixelSizes)
    console.log(`pages: ${spike.pageChecks.length} checked, ${odd.length} rotated / offset / size-mismatched / fractional-px${odd.length ? `: ${JSON.stringify(odd)}` : ''}`)
    console.log(`text-layer text matches golden quote: ${results.filter(r => r.textMatches).length}/${results.length}`)

    for (const zoom of [...new Set(results.map(r => r.zoom))]) {
      const rs = results.filter(r => r.zoom === zoom)
      const edges = rs.flatMap(r => [r.start, r.end]).filter((e): e is Edge => e !== undefined)
      const allInk = rs.flatMap(r => r.ink)
      const ink = allInk.filter(i => !i.noInk)
      console.log(`\n── zoom ${zoom}`)
      console.log(`  lines with NO ink inside the highlight: ${allInk.length - ink.length}/${allInk.length}`)
      console.log(`  edge Δ at item boundaries (pt, signed): ${stats(edges.filter(e => e.atItemBoundary).map(e => e.delta))}`)
      console.log(`  edge Δ mid-item vs text layer (pt):    ${stats(edges.filter(e => !e.atItemBoundary).map(e => e.delta))}   ← text-layer substitute-font error`)
      console.log(`  ink coverage per line: min ${Math.min(...ink.map(i => i.coverage)).toFixed(3)}  mean ${(ink.reduce((s, i) => s + i.coverage, 0) / ink.length).toFixed(3)}  lines <0.99: ${ink.filter(i => i.coverage < 0.99).length}/${ink.length}`)
      console.log(`  ink top slack (pt):    ${stats(ink.map(i => i.topSlack))}`)
      console.log(`  ink bottom slack (pt): ${stats(ink.map(i => i.bottomSlack))}`)
      console.log(`  hull IoU (info): mean ${(rs.reduce((s, r) => s + r.hull.iou, 0) / rs.length).toFixed(3)}  chunk ${(rs.reduce((s, r) => s + r.chunkHull.iou, 0) / rs.length).toFixed(3)}  line-count mismatches ${rs.filter(r => r.storedLines !== r.truthLines).length}`)
    }
    const low = results.flatMap(r => r.ink.map((i, n) => ({ id: `${r.id}@${r.zoom} line ${n + 1}`, ...i }))).filter(i => i.noInk || i.coverage < 0.99)
    if (low.length) console.log(`\nlines with ink outside the highlight: ${low.slice(0, 8).map(i => `${i.id} cov ${i.coverage} top ${i.topSlack} bottom ${i.bottomSlack}`).join(' | ')}`)
    if (consoleErrors.length) console.log(`\nconsole errors: ${consoleErrors.join(' | ')}`)
  }

  for (const shot of values.shot) {
    for (const zoom of [1, 2]) {
      await page.goto(`${values.base}/spike/highlight?span=${encodeURIComponent(shot)}&zoom=${zoom}`)
      await page.waitForFunction(() => ['done', 'error'].includes((window as unknown as { __spike?: { status: string } }).__spike?.status ?? ''), null, { timeout: 120_000 })
      const file = join(values.out, `${shot.replace('#', '-')}@${zoom}.png`)
      await page.locator('.pdf-page').screenshot({ path: file })
      console.log(`screenshot ${file}`)
    }
  }
  console.log(`\nraw results: ${join(values.out, 'spike-results.json')}`)
}
finally {
  await browser.close()
}
