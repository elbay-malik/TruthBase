import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import Page from '~/pages/index.vue'
import type { SourceRef } from '#shared/types/chat'
import { loadDocument } from '~/utils/pdf-documents'
import { loadPdfjs } from '~/utils/pdf-highlight'

vi.mock('~/utils/pdf-highlight', () => ({ loadPdfjs: vi.fn(() => new Promise(() => {})) }))
vi.mock('~/utils/pdf-documents', () => ({ loadDocument: vi.fn(() => new Promise(() => {})) }))

registerEndpoint('/api/documents', () => [
  { id: '0b2a3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', filename: 'nist-csf-2.0.pdf', pageCount: 32 },
])

const DOC = '0b2a3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'
const source = (index: number, pageNumber: number | null, content = `Passage ${index}.`): SourceRef =>
  ({ index, chunkId: `c${index}`, documentId: DOC, filename: 'nist-csf-2.0.pdf', pageNumber, content, highlight: null })

/** A UI message stream as /api/chat sends it. */
function sse(sources: SourceRef[], text: string, { finish = true } = {}): string {
  const parts: object[] = [
    { type: 'start', messageId: 'a1' },
    { type: 'data-sources', data: { sources } },
    { type: 'text-start', id: 't' },
    ...[...text].map(delta => ({ type: 'text-delta', id: 't', delta })),
  ]
  if (finish) parts.push({ type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop' })
  return parts.map(p => `data: ${JSON.stringify(p)}\n\n`).join('') + (finish ? 'data: [DONE]\n\n' : '')
}

/** Serves /api/chat from `respond`; everything else goes to the real fetch. */
function mockChat(respond: (init?: RequestInit) => Response | Promise<Response>) {
  const calls: unknown[] = []
  const real = globalThis.fetch
  vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/api/chat')) {
      calls.push(JSON.parse(String(init?.body)))
      return Promise.resolve(respond(init))
    }
    return real(url, init)
  })
  return calls
}

const stream = (body: string) => () => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
const conversation = (page: Awaited<ReturnType<typeof mountPage>>) => page.find('section[aria-label="Conversation"]')
/** The desktop viewer pane (PdfViewer is stubbed), where the viewer's keys are handled. */
const viewerPane = (page: Awaited<ReturnType<typeof mountPage>>) => page.find('main + div')
const json = (status: number, body: object) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function settle() {
  for (let i = 0; i < 10; i++) {
    await flushPromises()
    await new Promise(r => setTimeout(r, 10))
  }
}

async function askQuestion(page: Awaited<ReturnType<typeof mountPage>>, question = 'Are backups verified?') {
  await page.find('textarea').setValue(question)
  await page.find('form').trigger('submit')
  await settle()
}

const ViewerStub = defineComponent({
  name: 'PdfViewer',
  props: ['documentId', 'documents', 'target', 'layout'],
  emits: ['select-document', 'close', 'prev', 'next', 'update:zoom'],
  methods: { focus() {} },
  template: '<div tabindex="-1" :data-document-id="documentId" />',
})
const viewer = (page: Awaited<ReturnType<typeof mountPage>>) => page.findComponent(ViewerStub)

const mounted: { unmount: () => void }[] = []
async function mountPage(route?: string) {
  // Tooltips need UApp's provider (app.vue); the page alone renders their trigger.
  const page = await mountSuspended(Page, {
    attachTo: document.body,
    route,
    global: { stubs: { UTooltip: { template: '<slot />' }, PdfViewer: ViewerStub } },
  })
  mounted.push(page)
  return page
}

/** A stream that sends `head` and then stays open until the request is aborted. */
function openStream(head: string) {
  return (init?: RequestInit) => new Response(new ReadableStream({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(head))
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
    },
  }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
}

registerEndpoint('/api/chunks/c9', () => source(9, 4))

afterEach(() => {
  mounted.splice(0).forEach(page => page.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('index page', () => {
  it('renders the chat landmarks, example questions and the question box', async () => {
    const page = await mountPage()
    expect(page.text()).toContain('TruthBase')
    expect(page.text()).toContain('What are the six Functions of the NIST CSF 2.0?')
    expect(page.find('main[aria-label="Chat"]').exists()).toBe(true)
    expect(page.find('form[aria-label="Ask a question"]').exists()).toBe(true)
    expect(page.find('h2').text()).toBe('Conversation')
    const box = page.find('textarea[aria-label="Question"]')
    expect(box.attributes('aria-keyshortcuts')).toBe('/')
    expect(box.attributes('maxlength')).toBe('1000')
  })

  it('focuses the question on "/" unless typing elsewhere', async () => {
    const page = await mountPage()
    const box = page.find('textarea').element as HTMLTextAreaElement
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(box)
    box.blur()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))
    expect(document.activeElement).not.toBe(box)
  })

  it('renders chips with short labels, no floating space, and a Sources list', async () => {
    mockChat(stream(sse([source(1, 28), source(2, null)], 'Backups are verified before restoration [1]. They are tested [2].')))
    const page = await mountPage()
    await askQuestion(page)

    const chips = page.findAll('button[data-cite]')
    expect(chips.map(c => c.attributes('aria-label'))).toEqual([
      'Citation 1: nist-csf-2.0.pdf, page 28',
      'Citation 2: nist-csf-2.0.pdf, page unknown',
    ])
    expect(chips[0]!.attributes('aria-pressed')).toBeUndefined()
    expect(page.find('article p.leading-relaxed').text()).toContain('restoration1.')
    expect(page.text()).toContain('Sources')
    const cards = page.findAll('button[aria-label^="Source "]')
    expect(cards.map(c => c.attributes('aria-label'))).toEqual([
      'Source 1: nist-csf-2.0.pdf, page 28',
      'Source 2: nist-csf-2.0.pdf, page unknown',
    ])
    expect(page.html()).not.toMatch(/undefined|null/)
    expect(page.find('[role="status"]').text()).toBe('Answer ready, 2 sources.')
    expect(document.activeElement).toBe(page.find('textarea').element)

    await chips[1]!.trigger('click')
    expect(chips[1]!.attributes('aria-current')).toBe('true')
    expect(cards[1]!.attributes('aria-current')).toBe('true')
  })

  it('lists possibly related pages of a refusal once per page', async () => {
    mockChat(stream(sse([source(1, 31), source(2, 31), source(3, 7)], 'NO_ANSWER')))
    const page = await mountPage()
    await askQuestion(page)
    const related = page.findAll('button[aria-label*="possibly related"]')
    expect(related.map(b => b.text())).toEqual(['nist-csf-2.0.pdf · p. 31', 'nist-csf-2.0.pdf · p. 7'])
  })

  it('marks a cut stream as interrupted and offers Regenerate', async () => {
    mockChat(stream(sse([source(1, 28)], 'Backups are verified [1] and [', { finish: false })))
    const page = await mountPage()
    await askQuestion(page)
    expect(page.text()).toContain('Answer interrupted.')
    expect(page.find('[role="status"]').text()).toBe('Answer interrupted.')
    expect(page.find('article p.leading-relaxed').text()).not.toContain('[')
    expect(conversation(page).findAll('button').some(b => b.text() === 'Regenerate')).toBe(true)
    expect(page.findAll('button[data-cite]')).toHaveLength(1)
  })

  it('shows the daily cap without Retry and does not send again', async () => {
    const calls = mockChat(json(429, {
      statusCode: 429,
      message: 'You\'ve reached today\'s demo limit of 30 questions. It resets at midnight UTC.',
      data: { quota: 'client', resource: 'chat', retryAfter: 3 * 3600 },
    }))
    const page = await mountPage()
    await askQuestion(page)
    expect(page.text()).toContain('Daily demo limit reached')
    expect(page.text()).toMatch(/Back in about 3 h 0 min, at /)
    expect(conversation(page).findAll('button').some(b => b.text() === 'Retry')).toBe(false)
    const box = page.find('textarea')
    expect(box.attributes('readonly')).toBeDefined()
    expect(box.attributes('placeholder')).toMatch(/^Back at /)

    await box.setValue('Another question')
    await box.trigger('keydown', { key: 'Enter' })
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('titles a per-minute 429 and a provider failure differently', async () => {
    mockChat(json(429, { statusCode: 429, message: 'Too Many Requests' }))
    let page = await mountPage()
    await askQuestion(page)
    expect(page.text()).toContain('Slow down a moment')
    expect(conversation(page).findAll('button').some(b => b.text() === 'Retry')).toBe(true)

    vi.unstubAllGlobals()
    mockChat(json(503, { statusCode: 503, message: 'Query embeddings are not configured.' }))
    page = await mountPage()
    await askQuestion(page)
    expect(page.text()).toContain('The answer service is unavailable right now.')
    expect(page.text()).not.toContain('TruthBaseThe answer')
    expect(page.findAll('article')).toHaveLength(1) // the question; no empty answer turn
  })

  it('points the question box at the error for a too-long question', async () => {
    mockChat(json(400, { statusCode: 400, message: 'Bad Request' }))
    const page = await mountPage()
    await askQuestion(page)
    const box = page.find('textarea')
    expect(box.attributes('aria-describedby')).toBe('ask-error')
    expect(box.attributes('aria-invalid')).toBe('true')
    expect(page.find('#ask-error').text()).toContain('Questions must be 1–1000 characters.')
  })

  it('shows the pending row, then a streaming answer without Sources', async () => {
    let release!: (response: Response) => void
    mockChat(() => new Promise(resolve => (release = resolve)))
    const page = await mountPage()
    await askQuestion(page)
    expect(page.text()).toContain('Searching the documents…')
    expect(page.find('[role="status"]').text()).toBe('Searching the documents…')

    release(openStream(sse([source(1, 28)], 'Backups are verified [1]', { finish: false }))())
    await settle()
    expect(page.text()).not.toContain('Searching the documents…')
    expect(page.text()).toContain('Writing the answer…')
    expect(page.find('h4').exists()).toBe(false) // no Sources while streaming
    expect(page.find('[role="status"]').text()).toBe('Answering…')
  })

  it('stops an answer on Stop and offers Regenerate', async () => {
    mockChat(openStream(sse([source(1, 28)], 'Backups are verified [1]', { finish: false })))
    const page = await mountPage()
    await askQuestion(page)
    const stopButton = page.find('form button')
    expect(stopButton.text()).toBe('Stop')
    await stopButton.trigger('click')
    await settle()
    expect(page.text()).toContain('Stopped.')
    expect(page.find('[role="status"]').text()).toBe('Stopped.')
    expect(conversation(page).findAll('button').some(b => b.text() === 'Regenerate')).toBe(true)
    expect(page.find('form button').text()).toBe('Ask')
  })

  it('keeps the cap announcement fixed and lifts the cap at its reset', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    mockChat(json(429, {
      statusCode: 429,
      message: 'You\'ve reached today\'s demo limit of 30 questions.',
      data: { quota: 'client', resource: 'chat', retryAfter: 90 },
    }))
    const page = await mountPage()
    await askQuestion(page)
    const announced = page.find('[role="status"]').text()
    expect(announced).toMatch(/^Daily demo limit reached\. .* Back at /)
    expect(announced).not.toContain('Back in about')

    vi.advanceTimersByTime(60_000)
    await settle()
    expect(page.find('[role="status"]').text()).toBe(announced)
    expect(page.text()).toContain('Daily demo limit reached')

    vi.advanceTimersByTime(60_000)
    await settle()
    expect(page.text()).not.toContain('Daily demo limit reached')
    const box = page.find('textarea')
    expect(box.attributes('readonly')).toBeUndefined()
    expect((box.element as HTMLTextAreaElement).value).toBe('Are backups verified?')
    expect(page.findAll('article')).toHaveLength(0) // the unanswered turn is dropped
  })

  it('returns focus to the chip of the citation shown, on Esc', async () => {
    mockChat(stream(sse([source(1, 28), source(2, 30)], 'Verified [1]. Tested [2].')))
    const page = await mountPage()
    await askQuestion(page)
    const chips = page.findAll('button[data-cite]')
    await chips[0]!.trigger('click')
    const viewerHost = viewerPane(page)
    await viewerHost.trigger('keydown', { key: ']' })
    expect(chips[1]!.attributes('aria-current')).toBe('true')
    await viewerHost.trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(chips[1]!.element)
  })

  it('falls back to the question box on Esc after a deep link', async () => {
    const page = await mountPage('/?chunk=c9')
    await settle()
    await viewerPane(page).trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(page.find('textarea').element)
  })

  it('starts with an empty viewer and passes the documents for its switcher', async () => {
    const page = await mountPage()
    expect(viewer(page).props('documentId')).toBeUndefined()
    expect(viewer(page).props('documents')).toEqual([expect.objectContaining({ id: DOC, filename: 'nist-csf-2.0.pdf' })])
    expect(loadPdfjs).not.toHaveBeenCalled()
  })

  it('warms PDF.js and the first cited document once sources arrive', async () => {
    mockChat(stream(sse([source(1, 28)], 'Verified [1].')))
    const page = await mountPage()
    await askQuestion(page)
    expect(loadPdfjs).toHaveBeenCalled()
    expect(loadDocument).toHaveBeenCalledWith(DOC)
  })

  it('shows a document picked in the viewer from page 1, with no citation', async () => {
    mockChat(stream(sse([source(1, 28)], 'Verified [1].')))
    const page = await mountPage()
    await askQuestion(page)
    const chip = page.find('button[data-cite]')
    await chip.trigger('click')
    expect(viewer(page).props('target')).toBeDefined()
    viewer(page).vm.$emit('select-document', 'other-doc')
    await nextTick()
    expect(viewer(page).props('documentId')).toBe('other-doc')
    expect(viewer(page).props('target')).toBeUndefined()
    expect(chip.attributes('aria-current')).toBeUndefined()
  })
})
