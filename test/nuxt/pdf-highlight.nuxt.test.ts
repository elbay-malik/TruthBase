import { describe, expect, it, vi } from 'vitest'
import { loadPdfjs } from '~/utils/pdf-highlight'

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
