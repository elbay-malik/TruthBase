// Builds test/fixtures/highlight-spans.json from the golden set: for every
// evidence span, the PDF-space rects computed for the exact span and for the
// stored chunk that contains it. Consumed by the /spike/highlight page (Phase
// 3.5) and the Phase 13 citation E2E tests.
//
//   pnpm fixtures:highlights

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { HighlightRect } from '../shared/types'
import { chunkPage } from '../server/ingest/chunk'
import { extractPages, type PageLayout } from '../server/ingest/extract'
import { chunkHighlight } from '../server/ingest/highlight'

const ROOT = resolve(import.meta.dirname, '..')
const GOLDEN = join(ROOT, 'docs/golden')
const OUT = join(ROOT, 'test/fixtures/highlight-spans.json')

export interface HighlightFixture {
  /** `${goldenId}#${evidenceIndex}`, e.g. "g-006#2". */
  id: string
  document: string
  page: number
  text: string
  /** Character range of the span in the normalized page text. */
  start: number
  end: number
  pageWidth: number
  pageHeight: number
  spanRects: HighlightRect[]
  chunk: { start: number, end: number, rects: HighlightRect[] }
}

const round = (r: HighlightRect): HighlightRect =>
  ({ x1: +r.x1.toFixed(2), y1: +r.y1.toFixed(2), x2: +r.x2.toFixed(2), y2: +r.y2.toFixed(2) })

const golden: { id: string, evidence: { document: string, page: number, text: string }[] }[]
  = JSON.parse(await readFile(join(GOLDEN, 'golden.json'), 'utf8'))

const layouts = new Map<string, PageLayout[]>()
const fixtures: HighlightFixture[] = []
for (const record of golden) {
  for (const [i, evidence] of record.evidence.entries()) {
    if (!layouts.has(evidence.document)) {
      layouts.set(evidence.document, await extractPages(new Uint8Array(await readFile(join(GOLDEN, 'pdfs', evidence.document)))))
    }
    const page = layouts.get(evidence.document)![evidence.page - 1]!
    const start = page.text.indexOf(evidence.text)
    if (start === -1) throw new Error(`${record.id}#${i + 1}: span not found on page ${evidence.page}`)
    const end = start + evidence.text.length
    const chunk = chunkPage(page.text).find(c => c.start <= start && end <= c.end)
    if (!chunk) throw new Error(`${record.id}#${i + 1}: span not inside a single chunk`)

    fixtures.push({
      id: `${record.id}#${i + 1}`,
      document: evidence.document,
      page: evidence.page,
      text: evidence.text,
      start,
      end,
      pageWidth: page.width,
      pageHeight: page.height,
      spanRects: chunkHighlight(page, { start, end }).rects.map(round),
      chunk: { start: chunk.start, end: chunk.end, rects: chunkHighlight(page, chunk).rects.map(round) },
    })
  }
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, `${JSON.stringify(fixtures, null, 1)}\n`)
console.log(`wrote ${fixtures.length} spans → ${OUT}`)
