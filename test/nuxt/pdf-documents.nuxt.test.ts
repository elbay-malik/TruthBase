import { describe, expect, it, vi } from 'vitest'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { loadDocument } from '~/utils/pdf-documents'

// Fake PDF.js: each getDocument() returns a task whose load the test settles.
const { tasks } = vi.hoisted(() => ({ tasks: [] as FakeTask[] }))
interface FakeTask {
  url: string
  promise: Promise<unknown>
  resolve: (pdf: unknown) => void
  destroy: ReturnType<typeof vi.fn>
}

vi.mock('~/utils/pdf-highlight', () => ({
  PDFJS_ASSET_OPTIONS: {},
  loadPdfjs: async () => ({
    getDocument: ({ url }: { url: string }) => {
      const { promise, resolve, reject } = Promise.withResolvers<unknown>()
      const task: FakeTask = { url, promise, resolve, destroy: vi.fn(async () => reject(Object.assign(new Error('aborted'), { name: 'AbortException' }))) }
      tasks.push(task)
      return task
    },
  }),
}))

registerEndpoint('/api/documents/a/file', () => ({ url: 'blob:a' }))
registerEndpoint('/api/documents/b/file', () => ({ url: 'blob:b' }))

const fakePdf = { numPages: 1, getPage: async (n: number) => ({ pageNumber: n }) }

describe('loadDocument', () => {
  it('destroys a superseded load while it is still downloading', async () => {
    const a = loadDocument('a')
    await vi.waitFor(() => expect(tasks.at(-1)?.url).toBe('blob:a'))
    const taskA = tasks.at(-1)!

    const b = loadDocument('b')
    expect(taskA.destroy).toHaveBeenCalled()
    await expect(a).rejects.toThrow()

    await vi.waitFor(() => expect(tasks.at(-1)?.url).toBe('blob:b'))
    tasks.at(-1)!.resolve(fakePdf)
    expect((await b).pages).toHaveLength(1)
    // Still the open document: served from the cache.
    expect(loadDocument('b')).toBe(b)
  })
})
