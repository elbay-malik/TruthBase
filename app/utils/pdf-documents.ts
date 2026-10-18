import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist'
import { loadPdfjs, PDFJS_ASSET_OPTIONS } from './pdf-highlight'

// Opened PDFs outlive the viewer component: on small screens the viewer sits
// in a sheet that unmounts on close, and reopening it must not download and
// parse the same document again. Only the last document is kept open.

export interface LoadedDocument {
  documentId: string
  task: PDFDocumentLoadingTask
  pages: PDFPageProxy[]
}

// Signed URLs last 15 min. PDF.js normally finishes fetching the whole file in
// the background long before that, but a reopen after 10 min starts afresh
// rather than risk a range request on an expired URL.
const MAX_AGE_MS = 10 * 60_000

let current: { documentId: string, loadedAt: number, promise: Promise<LoadedDocument> } | undefined

/** The document's pages, from the cache when it is the one already open. */
export function loadDocument(documentId: string): Promise<LoadedDocument> {
  if (current?.documentId === documentId && Date.now() - current.loadedAt < MAX_AGE_MS) return current.promise

  const previous = current
  const promise = fetchDocument(documentId)
  current = { documentId, loadedAt: Date.now(), promise }
  // PDF.js 6: no PDFDocumentProxy#destroy — destroy the loading task.
  previous?.promise.then(doc => doc.task.destroy(), () => {})
  promise.catch(() => {
    if (current?.promise === promise) current = undefined // a failed load is never cached
  })
  return promise
}

async function fetchDocument(documentId: string): Promise<LoadedDocument> {
  const pdfjs = await loadPdfjs()
  // Signed URLs expire: on a 4xx from Storage (ResponseException), sign again once.
  for (let attempt = 0; ; attempt++) {
    const { url } = await $fetch(`/api/documents/${documentId}/file`)
    const task = pdfjs.getDocument({ url, ...PDFJS_ASSET_OPTIONS })
    try {
      const pdf = await task.promise
      const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)))
      return { documentId, task, pages: pages.map(page => markRaw(page)) }
    }
    catch (error) {
      await task.destroy()
      if (attempt > 0 || (error as Error)?.name !== 'ResponseException') throw error
    }
  }
}
