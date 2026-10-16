// Visual check for ingestion highlight rects (Phase 3 acceptance, Phase 3.5 spike).
//
//   pnpm render:highlights g-020 g-038        # golden record ids
//   pnpm render:highlights g-020 --out ./tmp  # default: $TMPDIR/truthbase-highlights
//
// For every evidence span of each record it renders the page and draws:
//   blue fill   — the stored chunk that contains the span (what a citation highlights)
//   red outline — rects computed for the exact evidence span
// Coordinates go through viewport.convertToViewportRectangle, exactly like the viewer.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { getDocumentProxy, renderPageAsImage } from 'unpdf'
import type { HighlightRect } from '../shared/types'
import { chunkPage } from '../server/ingest/chunk'
import { extractPages, type PageLayout } from '../server/ingest/extract'
import { chunkHighlight } from '../server/ingest/highlight'

const SCALE = 2
const GOLDEN = resolve(import.meta.dirname, '../docs/golden')

const { values, positionals: ids } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string', default: join(tmpdir(), 'truthbase-highlights') } },
})

interface Evidence { document: string, page: number, text: string }
const golden: { id: string, evidence: Evidence[] }[] = JSON.parse(await readFile(join(GOLDEN, 'golden.json'), 'utf8'))
await mkdir(values.out, { recursive: true })

const layouts = new Map<string, PageLayout[]>()
for (const id of ids) {
  const record = golden.find(r => r.id === id)
  if (!record) throw new Error(`unknown golden id: ${id}`)

  for (const [n, evidence] of record.evidence.entries()) {
    const data = new Uint8Array(await readFile(join(GOLDEN, 'pdfs', evidence.document)))
    if (!layouts.has(evidence.document)) layouts.set(evidence.document, await extractPages(data.slice()))
    const page = layouts.get(evidence.document)![evidence.page - 1]!

    const at = page.text.indexOf(evidence.text)
    if (at === -1) throw new Error(`${id}: evidence not found on page ${evidence.page}`)
    const span = { start: at, end: at + evidence.text.length }
    const chunk = chunkPage(page.text).find(c => c.start <= span.start && span.end <= c.end)

    const pdf = await getDocumentProxy(data.slice())
    const viewport = (await pdf.getPage(evidence.page)).getViewport({ scale: SCALE })
    const png = await renderPageAsImage(pdf, evidence.page, { canvasImport: () => import('@napi-rs/canvas'), scale: SCALE })
    const canvas = createCanvas(viewport.width, viewport.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(await loadImage(Buffer.from(png)), 0, 0)

    // PDF.js 5 dropped convertToViewportRectangle; convert both corners instead
    // (docs/TECH_NOTES.md §7). The viewer must do the same.
    const toViewport = (r: HighlightRect) => {
      const [a, b] = viewport.convertToViewportPoint(r.x1, r.y1) as [number, number]
      const [c, d] = viewport.convertToViewportPoint(r.x2, r.y2) as [number, number]
      return { x: Math.min(a, c), y: Math.min(b, d), w: Math.abs(c - a), h: Math.abs(d - b) }
    }
    const draw = (ctx: SKRSContext2D, rects: HighlightRect[], style: 'fill' | 'stroke') => {
      for (const r of rects.map(toViewport)) {
        if (style === 'fill') ctx.fillRect(r.x, r.y, r.w, r.h)
        else ctx.strokeRect(r.x, r.y, r.w, r.h)
      }
    }

    if (chunk) {
      ctx.fillStyle = 'rgba(37, 99, 235, 0.18)'
      draw(ctx, chunkHighlight(page, chunk).rects, 'fill')
    }
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.95)'
    ctx.lineWidth = 2
    draw(ctx, chunkHighlight(page, span).rects, 'stroke')

    const file = join(values.out, `${id}-${n + 1}-${evidence.document.replace(/\.pdf$/, '')}-p${evidence.page}.png`)
    await writeFile(file, canvas.toBuffer('image/png'))
    console.log(`${file}${chunk ? '' : '  (span not inside a single chunk)'}`)
  }
}
