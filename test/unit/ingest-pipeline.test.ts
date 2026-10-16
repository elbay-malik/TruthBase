import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ingestPdf, type IngestProgress } from '../../server/ingest/pipeline'
import type { ChunkInsert } from '../../server/ingest/store'

const PDF = resolve(__dirname, '../../docs/golden/pdfs/nist-csf-2.0.pdf')

describe('ingestPdf (offline: fake embedder and store)', () => {
  it('parses, chunks, embeds and stores a golden PDF with progress per stage', async () => {
    const pdf = new Uint8Array(await readFile(PDF))
    const stored: ChunkInsert[] = []
    const progress: IngestProgress[] = []
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]))

    const result = await ingestPdf(pdf, 'nist-csf-2.0.pdf', {
      embed,
      store: async (document, bytes, chunks, onBatch) => {
        expect(document.pageCount).toBe(32)
        expect(bytes.byteLength).toBe(pdf.byteLength) // original bytes, not a detached buffer
        stored.push(...chunks)
        onBatch(chunks.length)
      },
      onProgress: p => progress.push(p),
      embedBatchSize: 40,
    })

    expect(result.pageCount).toBe(32)
    expect(result.chunkCount).toBe(stored.length)
    expect(embed).toHaveBeenCalledTimes(Math.ceil(stored.length / 40))
    expect(new Set(progress.map(p => p.stage))).toEqual(new Set(['parse', 'chunk', 'embed', 'store']))
    expect(progress.at(-1)).toEqual({ stage: 'store', done: stored.length, total: stored.length })

    // The RC.RP-03 subcategory (golden g-020) lands in a chunk on page 28 with rects.
    const chunk = stored.find(c => c.content.includes('RC.RP-03: The integrity of backups'))!
    expect(chunk.pageNumber).toBe(28)
    expect(chunk.highlight.pageNumber).toBe(28)
    expect(chunk.highlight.rects.length).toBeGreaterThan(0)
    for (const r of chunk.highlight.rects) {
      expect(r.x2).toBeGreaterThan(r.x1)
      expect(r.y2).toBeGreaterThan(r.y1)
      expect(r.x2).toBeLessThanOrEqual(chunk.highlight.pageWidth)
      expect(r.y2).toBeLessThanOrEqual(chunk.highlight.pageHeight)
    }
  }, 30_000)

  it('rejects a PDF without a text layer before spending embedding calls', async () => {
    const embed = vi.fn()
    // A valid one-page PDF with no text content.
    const blank = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj '
      + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    )
    await expect(ingestPdf(blank, 'scan.pdf', { embed, store: vi.fn() }))
      .rejects.toMatchObject({ stage: 'parse' })
    expect(embed).not.toHaveBeenCalled()
  })
})
