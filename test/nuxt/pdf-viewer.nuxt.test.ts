import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { SourceRef } from '#shared/types/chat'
import PdfViewer from '~/components/PdfViewer.vue'

const { loadDocument } = vi.hoisted(() => ({ loadDocument: vi.fn() }))
mockNuxtImport('loadDocument', () => loadDocument)
// Pages never finish rendering: these tests cover the viewer chrome, not PDF.js.
mockNuxtImport('renderPage', () => () => new Promise(() => {}))

const fakePage = (pageNumber: number) => ({
  pageNumber,
  getViewport: ({ scale }: { scale: number }) => ({
    width: 612 * scale,
    height: 792 * scale,
    convertToViewportPoint: (x: number, y: number) => [x * scale, (792 - y) * scale],
  }),
  cleanup: () => {},
})

const documents = [{ id: 'a', filename: 'a.pdf' }, { id: 'b', filename: 'b.pdf' }]
const target: SourceRef = { index: 1, chunkId: 'c1', documentId: 'a', filename: 'a.pdf', pageNumber: 2, content: 'The cited passage.', highlight: null }
const live = (w: { find: (s: string) => { text: () => string } }) => w.find('[aria-live]').text()

beforeAll(() => {
  globalThis.IntersectionObserver ??= class { observe() {} disconnect() {} } as unknown as typeof IntersectionObserver
})
afterEach(() => loadDocument.mockReset())

describe('PdfViewer', () => {
  it('shows an empty state without a document and does not load one', async () => {
    const viewer = await mountSuspended(PdfViewer, { props: { documents } })
    expect(viewer.text()).toContain('Click a citation to see the exact passage here.')
    expect(viewer.find('button[aria-label="Zoom in"]').exists()).toBe(false)
    expect(viewer.find('[role="region"]').exists()).toBe(false)
    expect(loadDocument).not.toHaveBeenCalled()
  })

  it('emits select-document from the switcher, but not for the open document', async () => {
    loadDocument.mockResolvedValue({ documentId: 'a', pages: [fakePage(1)] })
    const viewer = await mountSuspended(PdfViewer, { props: { documents, documentId: 'a', filename: 'a.pdf' } })
    const select = viewer.findComponent({ name: 'USelect' }).exists()
      ? viewer.findComponent({ name: 'USelect' })
      : viewer.findComponent({ name: 'Select' })
    select.vm.$emit('update:modelValue', 'a')
    select.vm.$emit('update:modelValue', 'b')
    expect(viewer.emitted('select-document')).toEqual([['b']])
    expect(viewer.find('h2').text()).toContain('a.pdf')
  })

  it('keeps zoom buttons focusable at the limits and announces zoom changes', async () => {
    loadDocument.mockResolvedValue({ documentId: 'a', pages: [fakePage(1), fakePage(2)] })
    const viewer = await mountSuspended(PdfViewer, { props: { documentId: 'a', filename: 'a.pdf', initialScale: 3 } })
    await flushPromises()
    const zoomIn = viewer.find('button[aria-label="Zoom in"]')
    expect(zoomIn.attributes('aria-disabled')).toBe('true')
    expect(zoomIn.attributes('disabled')).toBeUndefined()
    await zoomIn.trigger('click')
    expect(viewer.emitted('update:zoom')).toBeUndefined()

    await viewer.find('button[aria-label="Zoom out"]').trigger('click')
    await flushPromises()
    expect(viewer.emitted('update:zoom')).toEqual([[2]])
    expect(live(viewer)).toBe('Zoom 200%')
    expect(viewer.find('button[aria-label="Fit to width (zoom 200%)"]').attributes('aria-pressed')).toBe('false')
  })

  it('moves one page with the page buttons and announces it', async () => {
    loadDocument.mockResolvedValue({ documentId: 'a', pages: [fakePage(1), fakePage(2), fakePage(3)] })
    const viewer = await mountSuspended(PdfViewer, { props: { documentId: 'a', filename: 'a.pdf' } })
    await flushPromises()
    expect(viewer.find('button[aria-label="Previous page"]').attributes('aria-disabled')).toBe('true')
    await viewer.find('button[aria-label="Next page"]').trigger('click')
    await flushPromises()
    expect(live(viewer)).toBe('Page 2 of 3')
    expect((viewer.find('input[aria-label^="Page number"]').element as HTMLInputElement).value).toBe('2')
  })

  it('announces a load error instead of the citation, shows the quote, and retries', async () => {
    loadDocument.mockRejectedValueOnce(new Error('500'))
    const viewer = await mountSuspended(PdfViewer, { props: { documentId: 'a', filename: 'a.pdf', target, citationLabel: 'Citation 1 of 3' } })
    await flushPromises()
    expect(live(viewer)).toBe('Couldn\'t load a.pdf. Retry available.')
    expect(viewer.text()).toContain('The cited passage.')
    expect(viewer.find('button[aria-label="Zoom in"]').attributes('aria-disabled')).toBe('true')

    loadDocument.mockResolvedValueOnce({ documentId: 'a', pages: [fakePage(1), fakePage(2)] })
    const retry = viewer.findAll('button').find(b => b.text() === 'Retry')!
    await retry.trigger('click')
    await flushPromises()
    expect(loadDocument).toHaveBeenCalledTimes(2)
    expect(live(viewer)).toBe('Page 2, Citation 1 of 3')
  })

  it('sheet layout: close in the header, citation stepper at the bottom', async () => {
    loadDocument.mockResolvedValue({ documentId: 'a', pages: [fakePage(1), fakePage(2)] })
    const viewer = await mountSuspended(PdfViewer, {
      props: { documentId: 'a', filename: 'a.pdf', layout: 'sheet', target, citationLabel: 'Citation 1 of 3', canStep: true },
    })
    await flushPromises()
    await viewer.find('header button[aria-label="Close document"]').trigger('click')
    expect(viewer.emitted('close')).toHaveLength(1)
    const next = viewer.find('button[aria-label="Next citation"]')
    expect(next.text()).toBe('Next')
    expect(next.element.closest('header')).toBeNull()
    await next.trigger('click')
    expect(viewer.emitted('next')).toHaveLength(1)
  })
})
