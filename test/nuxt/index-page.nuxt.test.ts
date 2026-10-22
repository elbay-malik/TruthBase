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
function sse(sources: SourceRef[], text: string, { finish = true, messageId = 'a1' } = {}): string {
  const parts: object[] = [
    { type: 'start', messageId },
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
  props: ['documentId', 'documents', 'target', 'layout', 'passageLink'],
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
  // An open citation writes ?chunk= into the address bar.
  window.history.replaceState(window.history.state, '', '/')
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('index page', () => {
  it('renders the chat landmarks, example questions and the question box', async () => {
    const page = await mountPage()
    expect(page.text()).toContain('TruthBase')
    expect(page.text()).toContain('Why is GOVERN placed at the center of the CSF Functions wheel?')
    expect(page.findAll('section[aria-label="Example questions"] button')).toHaveLength(4)
    expect(page.find('main[aria-label="Chat"]').exists()).toBe(true)
    expect(page.find('form[aria-label="Ask a question"]').exists()).toBe(true)
    expect(conversation(page).find('h2').text()).toBe('Conversation')
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

  it('numbers citations in order of first use and lays out a list answer', async () => {
    mockChat(stream(sse([source(1, 26), source(2, 8), source(3, 10)], 'The Functions:\n- GOVERN [2] .\n- DETECT  [3]\n- RESPOND [3]\n- IDENTIFY [1]')))
    const page = await mountPage()
    await askQuestion(page)

    // Retrieval indexes 2, 3, 3, 1 read as footnotes 1, 2, 2, 3.
    const chips = page.findAll('button[data-cite]')
    expect(chips.map(c => c.text())).toEqual(['1', '2', '2', '3'])
    expect(chips[0]!.attributes('aria-label')).toBe('Citation 1: NIST CSF 2.0, page 3 (PDF page 8)')
    const cards = page.findAll('button[aria-label^="Source "]')
    expect(cards.map(c => c.attributes('aria-label'))).toEqual([
      'Source 1: NIST CSF 2.0, page 3 (PDF page 8)',
      'Source 2: NIST CSF 2.0, page 5 (PDF page 10)',
      'Source 3: NIST CSF 2.0, page 21 (PDF page 26)',
    ])
    const answer = page.find('article [data-answer]')
    expect(answer.findAll('ul > li').map(li => li.text())).toEqual(['GOVERN1.', 'DETECT2', 'RESPOND2', 'IDENTIFY3'])
    expect(answer.text()).not.toContain('- ')

    // The finished answer's first citation opens beside it (desktop), focus stays in the box.
    expect(viewer(page).props('target')).toMatchObject({ chunkId: 'c2' })
    expect(document.activeElement).toBe(page.find('textarea').element)
    expect(chips[0]!.attributes('aria-current')).toBe('true')
  })

  it('renders chips with short labels, no floating space, and a Sources list', async () => {
    mockChat(stream(sse([source(1, 28), source(2, null)], 'Backups are verified before restoration [1]. They are tested [2].')))
    const page = await mountPage()
    await askQuestion(page)

    const chips = page.findAll('button[data-cite]')
    expect(chips.map(c => c.attributes('aria-label'))).toEqual([
      'Citation 1: NIST CSF 2.0, page 23 (PDF page 28)',
      'Citation 2: NIST CSF 2.0, page unknown',
    ])
    expect(chips[0]!.attributes('aria-pressed')).toBeUndefined()
    expect(page.find('article [data-answer]').text()).toContain('restoration1.')
    expect(page.text()).toContain('Sources')
    const cards = page.findAll('button[aria-label^="Source "]')
    expect(cards.map(c => c.attributes('aria-label'))).toEqual([
      'Source 1: NIST CSF 2.0, page 23 (PDF page 28)',
      'Source 2: NIST CSF 2.0, page unknown',
    ])
    expect(page.html()).not.toMatch(/undefined|null/)
    expect(page.find('[role="status"]').text()).toBe('Answer ready, 2 sources.')
    expect(document.activeElement).toBe(page.find('textarea').element)

    await chips[1]!.trigger('click')
    expect(chips[1]!.attributes('aria-current')).toBe('true')
    expect(cards[1]!.attributes('aria-current')).toBe('true')
  })

  it('names sources by title and printed page, and leaves the running head out of excerpts', async () => {
    const head = 'NIST CSWP 29 The NIST Cybersecurity Framework (CSF) 2.0 February 26, 2024 23'
    mockChat(stream(sse([source(1, 28, `${head} RC.RP-03: The integrity of backups is verified.`)], 'Backups are verified [1].')))
    const page = await mountPage()
    await askQuestion(page)
    const card = page.find('button[aria-label^="Source 1"]')
    expect(card.text()).toContain('NIST CSF 2.0')
    expect(card.text()).toContain('p. 23 (PDF 28)')
    expect(card.text()).toContain('RC.RP-03: The integrity of backups is verified.')
    expect(card.text()).not.toContain('NIST CSWP 29')
    expect(card.text()).not.toContain('nist-csf-2.0.pdf')
  })

  it('lists possibly related pages of a refusal once per page', async () => {
    mockChat(stream(sse([source(1, 31), source(2, 31), source(3, 7)], 'NO_ANSWER')))
    const page = await mountPage()
    await askQuestion(page)
    const related = page.findAll('button[aria-label*="possibly related"]')
    expect(related.map(b => b.text())).toEqual(['NIST CSF 2.0 · p. 26 (PDF 31)', 'NIST CSF 2.0 · p. 2 (PDF 7)'])
  })

  it('marks a cut stream as interrupted and offers Regenerate', async () => {
    mockChat(stream(sse([source(1, 28)], 'Backups are verified [1] and [', { finish: false })))
    const page = await mountPage()
    await askQuestion(page)
    expect(page.text()).toContain('Answer interrupted.')
    expect(page.find('[role="status"]').text()).toBe('Answer interrupted.')
    expect(page.find('article [data-answer]').text()).not.toContain('[')
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
    expect(page.text()).toContain('Per-minute limit reached')
    expect(conversation(page).findAll('button').some(b => b.text() === 'Retry')).toBe(true)

    vi.unstubAllGlobals()
    mockChat(json(503, { statusCode: 503, message: 'Query embeddings are not configured.' }))
    page = await mountPage()
    await askQuestion(page)
    expect(page.text()).toContain('Answer service unavailable')
    expect(page.text()).not.toContain('TruthBaseAnswer')
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

  it('lists the corpus by title and page count, and opens a document from page 1', async () => {
    const page = await mountPage()
    const row = page.find('button[aria-label="Open The NIST Cybersecurity Framework (CSF) 2.0, 32 pages"]')
    expect(row.text()).toContain('NIST CSF 2.0')
    expect(row.text()).toContain('32 pages')
    expect(page.text()).toContain('Highlight placement: 176/180 checks pass')
    expect(page.find('a[href="https://github.com/EleoXDA/TruthBase#highlight-accuracy"]').exists()).toBe(true)
    expect(page.findAll('nav[aria-label="Project"] a').map(a => a.attributes('href'))).toEqual([
      'https://github.com/EleoXDA/TruthBase',
      'https://github.com/EleoXDA/TruthBase#readme',
      'https://github.com/EleoXDA/TruthBase/tree/main/docs/adr',
      'https://github.com/EleoXDA/TruthBase/tree/main/docs/evals',
    ])
    await row.trigger('click')
    expect(viewer(page).props('documentId')).toBe(DOC)
    expect(viewer(page).props('target')).toBeUndefined()
  })

  it('offers the examples not yet asked below an answer', async () => {
    mockChat(stream(sse([source(1, 28)], 'Six Functions [1].')))
    const page = await mountPage()
    expect(page.find('#more-examples').exists()).toBe(false)
    await askQuestion(page, 'Why is GOVERN placed at the center of the CSF Functions wheel?')
    const more = page.find('section[aria-labelledby="more-examples"]')
    expect(more.findAll('button').map(b => b.text())).toEqual([
      'How does the AI RMF define risk?',
      'How does RAPTOR choose the number of clusters?',
      'What are the four types of reflection tokens in Self-RAG?',
    ])
    expect(page.find('button[aria-label^="Open The NIST"]').exists()).toBe(false)
  })

  it('warms PDF.js and the first cited document once sources arrive', async () => {
    mockChat(stream(sse([source(1, 28)], 'Verified [1].')))
    const page = await mountPage()
    await askQuestion(page)
    expect(loadPdfjs).toHaveBeenCalled()
    expect(loadDocument).toHaveBeenCalledWith(DOC)
  })

  it('shows the scope as a removable chip by the box, and labels each question with its scope', async () => {
    const calls = mockChat(stream(sse([source(1, 28)], 'Verified [1].')))
    const page = await mountPage()
    expect(page.find('#ask-scope').exists()).toBe(false)
    // The header's scope select (the viewer, and its own switcher, is stubbed).
    const select = page.findComponent({ name: 'USelect' }).exists() ? page.findComponent({ name: 'USelect' }) : page.findComponent({ name: 'Select' })
    select.vm.$emit('update:modelValue', DOC)
    await nextTick()
    const box = page.find('textarea')
    expect(page.find('#ask-scope').text()).toBe('Searching NIST CSF 2.0 only')
    expect(box.attributes('aria-describedby')).toBe('ask-scope')
    expect(box.attributes('placeholder')).toBe('Ask NIST CSF 2.0…')

    await askQuestion(page)
    expect(calls).toEqual([{ question: 'Are backups verified?', documentId: DOC }])
    expect(conversation(page).find('article').text()).toContain('in NIST CSF 2.0 only')

    await page.find('button[aria-label="Search all documents (remove filter NIST CSF 2.0)"]').trigger('click')
    await nextTick()
    expect(page.find('#ask-scope').exists()).toBe(false)
    expect(box.attributes('aria-describedby')).toBeUndefined()
    expect(page.find('p[role="status"]').text()).toBe('Searching all documents.')
    // The earlier question keeps the scope it was asked in.
    expect(conversation(page).find('article').text()).toContain('in NIST CSF 2.0 only')
    await askQuestion(page, 'Are backups tested?')
    expect(calls[1]).toEqual({ question: 'Are backups tested?' })
  })

  it('puts an open citation in the URL and starts a new conversation without it', async () => {
    mockChat(stream(sse([source(1, 28)], 'Verified [1].')))
    const page = await mountPage()
    expect(page.findAll('button').some(b => b.text() === 'New conversation')).toBe(false)
    await askQuestion(page)
    await page.find('button[data-cite]').trigger('click')
    await nextTick()
    expect(new URL(window.location.href).searchParams.get('chunk')).toBe('c1')
    // Copy link carries the claim the passage backs; the address bar only the passage.
    expect(viewer(page).props('passageLink')).toBe(`${window.location.origin}/?chunk=c1&claim=Verified.`)
    expect(new URL(window.location.href).searchParams.has('claim')).toBe(false)

    page.find('textarea').setValue('A draft')
    await page.findAll('button').find(b => b.text() === 'New conversation')!.trigger('click')
    await settle()
    expect(page.findAll('article')).toHaveLength(0)
    expect(new URL(window.location.href).searchParams.has('chunk')).toBe(false)
    expect(viewer(page).props('target')).toBeUndefined()
    expect(viewer(page).props('documentId')).toBeUndefined()
    expect(page.find('p[role="status"]').text()).toBe('New conversation.')
    expect((page.find('textarea').element as HTMLTextAreaElement).value).toBe('A draft')
    expect(document.activeElement).toBe(page.find('textarea').element)
    expect(page.text()).toContain('Try a question')
  })

  it('clears the previous answer\'s citation when the next turn is a refusal', async () => {
    let reply = sse([source(1, 28)], 'Verified [1].')
    mockChat(() => stream(reply)())
    const page = await mountPage()
    await askQuestion(page)
    expect(viewer(page).props('target')).toMatchObject({ chunkId: 'c1' })
    expect(new URL(window.location.href).searchParams.get('chunk')).toBe('c1')

    reply = sse([source(2, 30)], 'NO_ANSWER')
    await askQuestion(page, 'What penalties does the EU AI Act set?')
    expect(viewer(page).props('target')).toBeUndefined()
    expect(viewer(page).props('documentId')).toBeUndefined()
    expect(viewer(page).props('passageLink')).toBeUndefined()
    expect(new URL(window.location.href).searchParams.has('chunk')).toBe(false)
    expect(page.findAll('button[data-cite][aria-current="true"]')).toHaveLength(0)
  })

  it('clears the previous answer\'s citation beside a stopped answer that cites its own', async () => {
    let reply: (init?: RequestInit) => Response = stream(sse([source(1, 28)], 'Verified [1].'))
    mockChat(init => reply(init))
    const page = await mountPage()
    await askQuestion(page)
    expect(viewer(page).props('target')).toMatchObject({ chunkId: 'c1' })

    reply = openStream(sse([source(2, 30)], 'Partly [1]', { finish: false, messageId: 'a2' }))
    await page.find('textarea').setValue('Another question?')
    await page.find('form').trigger('submit')
    await settle()
    await page.findAll('button').find(b => b.text() === 'Stop')!.trigger('click')
    await settle()
    expect(viewer(page).props('target')).toBeUndefined()
    expect(new URL(window.location.href).searchParams.has('chunk')).toBe(false)
  })

  it('offers only the example for the document in scope', async () => {
    const page = await mountPage()
    await page.findComponent({ name: 'USelect' }).vm.$emit('update:modelValue', DOC)
    await nextTick()
    expect(page.findAll('section[aria-label="Example questions"] button').map(b => b.text()))
      .toEqual(['Why is GOVERN placed at the center of the CSF Functions wheel?'])
  })

  it('shows a shared passage with the claim it was sent with, as the sender\'s words', async () => {
    const page = await mountPage('/?chunk=c9&claim=Backups%20are%20verified.')
    await settle()
    const shared = page.find('section[aria-labelledby="shared-passage"]')
    expect(shared.text()).toContain('NIST CSF 2.0 · p. iii (PDF 4)')
    expect(shared.text()).toContain('“Backups are verified.”')
    expect(shared.text()).toContain('TruthBase didn’t write or check it')
    // Copy link passes the passage on, not the sender's claim, which the next
    // reader would credit to whoever forwarded the link.
    expect(viewer(page).props('passageLink')).toBe(`${window.location.origin}/?chunk=c9`)
    expect(new URL(window.location.href).searchParams.has('claim')).toBe(false)
  })

  it('offers no link for a possibly related page', async () => {
    mockChat(stream(sse([source(1, 28)], 'NO_ANSWER')))
    const page = await mountPage()
    await askQuestion(page)
    await page.find('button[aria-label$="possibly related, not a source"]').trigger('click')
    await nextTick()
    expect(viewer(page).props('passageLink')).toBeUndefined()
    expect(new URL(window.location.href).searchParams.has('chunk')).toBe(false)
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
