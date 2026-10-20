import { describe, expect, it, vi } from 'vitest'
import { dropRunningMargins, loadPdfjs } from '~/utils/pdf-highlight'

const { fail } = vi.hoisted(() => ({ fail: { next: true } }))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {} }))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => {
  // A failed chunk fetch rejects the import once; the module mock itself loads.
  return { get default() { if (fail.next) { fail.next = false; throw new Error('Failed to fetch dynamically imported module') } return '/worker.mjs' } }
})

describe('loadPdfjs', () => {
  it('retries the import after a failed one instead of caching the failure', async () => {
    await expect(loadPdfjs()).rejects.toThrow('Failed to fetch')
    const pdfjs = await loadPdfjs()
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('/worker.mjs')
  })
})

describe('dropRunningMargins', () => {
  const box = (y1: number, y2: number) => ({ x1: 0, y1, x2: 100, y2 })

  it('drops running header and footer lines when the chunk has body lines', () => {
    // Page 1000 px tall: header at 5 %, body, page number at 95 %.
    expect(dropRunningMargins([box(40, 60), box(200, 220), box(240, 260), box(940, 960)], 1000))
      .toEqual([box(200, 220), box(240, 260)])
  })

  it('keeps every box when all of them are in the margins', () => {
    const boxes = [box(40, 60), box(940, 960)]
    expect(dropRunningMargins(boxes, 1000)).toEqual(boxes)
  })
})
