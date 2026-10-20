// Builds test/fixtures/e2e/chunks.json for the Playwright suite: the stored
// text of each golden span's chunk (what ingestion writes as `content`, and
// what the viewer checks against the rendered page text before trusting the
// stored rects). Rects, pages and offsets come from
// test/fixtures/highlight-spans.json; this fails if that file or the page
// counts in test/fixtures/e2e/documents.json are stale.
//
//   pnpm fixtures:e2e

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chunkPage } from '../../server/ingest/chunk'
import { extractPages, type PageLayout } from '../../server/ingest/extract'
import { chunkHighlight } from '../../server/ingest/highlight'
import type { DocumentFixture, SpanFixture } from './fixtures'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'test/fixtures/e2e/chunks.json')

const spans: SpanFixture[] = JSON.parse(await readFile(join(ROOT, 'test/fixtures/highlight-spans.json'), 'utf8'))
const layouts = new Map<string, PageLayout[]>()
const chunks: Record<string, string> = {}
for (const span of spans) {
  if (!layouts.has(span.document)) {
    layouts.set(span.document, await extractPages(new Uint8Array(await readFile(join(ROOT, 'docs/golden/pdfs', span.document)))))
  }
  const page = layouts.get(span.document)![span.page - 1]!
  const chunk = chunkPage(page.text).find(c => c.start === span.chunk.start && c.end === span.chunk.end)
  const rects = chunk && chunkHighlight(page, chunk).rects
  const fresh = rects?.length === span.chunk.rects.length
    && rects.every((r, i) => (['x1', 'y1', 'x2', 'y2'] as const).every(k => Math.abs(r[k] - span.chunk.rects[i]![k]) < 0.01))
  if (!chunk || !fresh) throw new Error(`${span.id}: highlight-spans.json is stale (run pnpm fixtures:highlights)`)
  chunks[span.id] = page.text.slice(chunk.start, chunk.end)
}

const documents: DocumentFixture[] = JSON.parse(await readFile(join(ROOT, 'test/fixtures/e2e/documents.json'), 'utf8'))
for (const [file, pages] of layouts) {
  if (documents.find(d => d.filename === file)?.pageCount !== pages.length) throw new Error(`documents.json: ${file} has ${pages.length} pages`)
}
await writeFile(OUT, `${JSON.stringify(chunks, null, 1)}\n`)
console.log(`wrote ${Object.keys(chunks).length} chunks → ${OUT}`)
