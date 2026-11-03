import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test as base, expect, type Page, type Route } from '@playwright/test'
import type { ChunkHighlight, HighlightRect } from '../../shared/types'
import type { SourceRef } from '../../shared/types/chat'
import { STUB_ORIGIN } from './ports'

// Hermetic API for the E2E suite: every /api/* request the browser makes is
// answered here from repo fixtures (page.route), so no Supabase, Groq or
// Cloudflare key is needed. The server renders the page and serves the corpus
// PDFs from /pdfs, as in production; its SSR call to GET /api/documents, and
// the signed PDF URLs a stalled download uses, reach ./supabase-stub.ts.

const ROOT = resolve(import.meta.dirname, '../..')
const fixture = (path: string) => readFileSync(join(ROOT, 'test/fixtures', path))

export interface DocumentFixture { id: string, filename: string, pageCount: number }

/** test/fixtures/highlight-spans.json (scripts/build-highlight-fixtures.ts). */
export interface SpanFixture {
  id: string
  document: string
  page: number
  text: string
  start: number
  end: number
  pageWidth: number
  pageHeight: number
  spanRects: HighlightRect[]
  chunk: { start: number, end: number, rects: HighlightRect[] }
}

/** The ids the recorded stream (chat-g020.sse) uses, so it replays as is. */
export const DOCUMENTS: DocumentFixture[] = JSON.parse(fixture('e2e/documents.json').toString())
export const SPANS: SpanFixture[] = JSON.parse(fixture('highlight-spans.json').toString())
/** Chunk text per span id (test/e2e/build-fixtures.ts). */
const CHUNK_TEXT: Record<string, string> = JSON.parse(fixture('e2e/chunks.json').toString())

export const documentOf = (filename: string) => DOCUMENTS.find(d => d.filename === filename)!

/** A stable, valid v4 uuid per stored chunk (document + page + start offset). */
export function chunkIdOf(span: SpanFixture): string {
  const hex = createHash('sha256').update(`${span.document}:${span.page}:${span.chunk.start}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The source the chat route would send for the chunk containing `span`. */
export function sourceOf(span: SpanFixture, index = 1): SourceRef {
  const rects = span.chunk.rects
  const highlight: ChunkHighlight = {
    pageNumber: span.page,
    boundingRect: {
      x1: Math.min(...rects.map(r => r.x1)),
      y1: Math.min(...rects.map(r => r.y1)),
      x2: Math.max(...rects.map(r => r.x2)),
      y2: Math.max(...rects.map(r => r.y2)),
    },
    rects,
    pageWidth: span.pageWidth,
    pageHeight: span.pageHeight,
    usePdfCoordinates: true,
    startOffset: span.chunk.start,
    endOffset: span.chunk.end,
  }
  const content = CHUNK_TEXT[span.id]
  if (content === undefined) throw new Error(`${span.id}: no chunk text (run pnpm fixtures:e2e)`)
  const document = documentOf(span.document)
  return { index, chunkId: chunkIdOf(span), documentId: document.id, filename: document.filename, pageNumber: span.page, content, highlight }
}

/** One golden question with its spans and the deduplicated sources an answer cites. */
export interface Answerable {
  id: string
  question: string
  spans: SpanFixture[]
  sources: SourceRef[]
  /** Source index per span. */
  cites: number[]
}

const GOLDEN: { id: string, question: string }[] = JSON.parse(readFileSync(join(ROOT, 'docs/golden/golden.json'), 'utf8'))

export const RECORDS: Answerable[] = [...Map.groupBy(SPANS, s => s.id.split('#')[0]!)].map(([id, spans]) => {
  const sources: SourceRef[] = []
  const cites = spans.map((span) => {
    const chunkId = chunkIdOf(span)
    const known = sources.find(s => s.chunkId === chunkId)
    if (known) return known.index
    sources.push(sourceOf(span, sources.length + 1))
    return sources.length
  })
  return { id, question: GOLDEN.find(g => g.id === id)!.question, spans, sources, cites }
})

// ── UI message stream (AI SDK v7), as POST /api/chat sends it ───────────────
/** Response headers of the recorded stream, minus hop-by-hop and per-response ones. */
export const STREAM_HEADERS: Record<string, string> = Object.fromEntries(fixture('e2e/chat-g020.headers').toString()
  .split(/\r?\n/).slice(1).map(line => line.split(/:\s*/, 2) as [string, string])
  .filter(([name, value]) => value !== undefined && !/^(date|transfer-encoding|connection)$/i.test(name))
  .map(([name, value]) => [name.toLowerCase(), value]))

/** The recorded answer to g-020 (one source, nist-csf-2.0.pdf p. 28), byte for byte. */
export const RECORDED_G020 = fixture('e2e/chat-g020.sse')

const event = (part: unknown) => `data: ${JSON.stringify(part)}\n\n`

/**
 * A grounded answer citing `sources`: the same parts, in the same order, as
 * the recorded stream. `cut` stops after that many text deltas, without
 * text-end, finish or [DONE] (a dropped connection).
 */
export function answerStream(sources: SourceRef[], answer: string, options: { cut?: number } = {}): string {
  const deltas = answer.match(/\S+\s*|\s+/g) ?? []
  const parts = [
    event({ type: 'data-sources', data: { sources } }),
    event({ type: 'start', messageId: `e2e-${createHash('sha256').update(answer).digest('hex').slice(0, 12)}` }),
    event({ type: 'start-step' }),
    event({ type: 'text-start', id: 'txt-0' }),
    ...deltas.slice(0, options.cut).map(delta => event({ type: 'text-delta', id: 'txt-0', delta })),
  ]
  if (options.cut !== undefined) return parts.join('')
  return [...parts, event({ type: 'text-end', id: 'txt-0' }), event({ type: 'finish-step' }), event({ type: 'finish', finishReason: 'stop' }), 'data: [DONE]\n\n'].join('')
}

/** The chat route's refusal: sources (shown as "possibly related"), then exactly NO_ANSWER. */
export function refusalStream(sources: SourceRef[]): string {
  return [
    event({ type: 'data-sources', data: { sources } }),
    event({ type: 'text-start', id: 'refusal' }),
    event({ type: 'text-delta', id: 'refusal', delta: 'NO_ANSWER' }),
    event({ type: 'text-end', id: 'refusal' }),
    'data: [DONE]\n\n',
  ].join('')
}

/**
 * The chat route's onError: sources, then an `error` part with its
 * reader-facing text instead of an answer (server/api/chat.post.ts).
 */
export function errorStream(sources: SourceRef[], errorText: string): string {
  return [
    event({ type: 'data-sources', data: { sources } }),
    event({ type: 'start', messageId: 'e2e-error' }),
    event({ type: 'start-step' }),
    event({ type: 'error', errorText }),
    'data: [DONE]\n\n',
  ].join('')
}

/** An answer that quotes each span and cites its source: "“…” [1] “…” [2]". */
export function answerFor(record: Answerable): string {
  return record.spans.map((span, i) => `“${span.text.replace(/[[\]【】]/g, '')}” [${record.cites[i]}]`).join(' ')
}

// ── routes ──────────────────────────────────────────────────────────────────
export type ChatHandler = (route: Route, body: { question: string, documentId?: string }) => Promise<void>

export interface MockApi {
  /** Answers POST /api/chat; replace per test. */
  chat: ChatHandler
  /** PDF downloads fail with a 500 while set. */
  pdfDown: boolean
  /**
   * PDFs come from the stub's signed Storage URLs (cross-origin, as for a
   * document outside the corpus), and the full download stalls after 64 KB,
   * so PDF.js loads by range. Otherwise they come from the build's /pdfs.
   */
  pdfStall: boolean
  /** Requests to /api/* no fixture answers (each one fails the test). */
  unexpected: string[]
  /** Questions sent to /api/chat. */
  questions: string[]
  /** Status of each PDF response, from /pdfs or the signed URLs (200 the stream, 206 a range). */
  pdfStatuses: number[]
}

/** Supabase Storage's signed-URL path, on the stub's origin (cross-origin, ranged). */
const SIGNED_PDF = '/storage/v1/object/sign/pdfs/'
/** Where the build serves the corpus PDFs (server/utils/static-pdfs.ts). */
const STATIC_PDF = '/pdfs/'
const isPdf = (url: URL) =>
  (url.origin === STUB_ORIGIN && url.pathname.startsWith(SIGNED_PDF)) || (url.origin !== STUB_ORIGIN && url.pathname.startsWith(STATIC_PDF))

async function installApi(page: Page, api: MockApi) {
  // Registered first, so every more specific route below takes precedence.
  // Icons are in the client bundle, so an icon request counts as unexpected too.
  await page.route(url => url.pathname.startsWith('/api/'), (route) => {
    api.unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.fulfill({ status: 500, json: { statusCode: 500, message: 'No E2E fixture for this request.' } })
  })
  await page.route(url => url.pathname === '/api/documents', route =>
    route.fulfill({ json: DOCUMENTS.map(d => ({ id: d.id, filename: d.filename, pageCount: d.pageCount })) }))
  await page.route(url => /^\/api\/documents\/[^/]+\/file$/.test(url.pathname), (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const document = DOCUMENTS.find(d => d.id === id)
    if (!document) return route.fulfill({ status: 404, json: { statusCode: 404, message: 'No such document.' } })
    const headers = { 'cache-control': 'no-store' }
    // As the route answers for the corpus: a static file on the page's origin.
    if (!api.pdfStall) return route.fulfill({ json: { url: `${STATIC_PDF}${encodeURIComponent(document.filename)}` }, headers })
    const url = `${STUB_ORIGIN}${SIGNED_PDF}${encodeURIComponent(document.filename)}?token=e2e&stall=1`
    return route.fulfill({ json: { url, expiresAt: new Date(Date.now() + 12 * 60_000).toISOString() }, headers })
  })
  // The PDF bytes come from the build or the stub (Accept-Ranges, CORS); only an outage is simulated here.
  await page.route(isPdf, (route) => {
    if (api.pdfDown) return route.fulfill({ status: 500, body: 'PDF unavailable', headers: { 'access-control-allow-origin': '*' } })
    return route.fallback()
  })
  await page.route(url => /^\/api\/chunks\/[^/]+$/.test(url.pathname), (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const span = SPANS.find(s => chunkIdOf(s) === id)
    if (!span) return route.fulfill({ status: 404, json: { statusCode: 404, message: 'No such chunk.' } })
    return route.fulfill({ json: sourceOf(span) })
  })
  await page.route(url => url.pathname === '/api/chat', (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON() as { question: string, documentId?: string }
    api.questions.push(body.question)
    return api.chat(route, body)
  })
}

/** Fulfils a chat request with a UI message stream body. */
export const streamReply = (route: Route, body: string | Buffer) =>
  route.fulfill({ status: 200, headers: STREAM_HEADERS, body })

// ── fixtures ────────────────────────────────────────────────────────────────
export const test = base.extend<{ api: MockApi, fakeWorker: { used: boolean } }>({
  // A client IP of its own per test (NUXT_TRUSTED_IP_HEADER in
  // playwright.config.ts): the production build keeps its per-IP limiter
  // (150 requests / 5 min), which a whole run from one IP would exceed.
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    const [a, b, c] = createHash('sha256').update(`${testInfo.testId}:${testInfo.retry}`).digest()
    await use({ ...extraHTTPHeaders, 'x-e2e-client-ip': `10.${a}.${b}.${c}` })
  },
  api: async ({ page }, use) => {
    const api: MockApi = {
      chat: route => route.fulfill({ status: 500, json: { statusCode: 500, message: 'No chat reply set for this test.' } }),
      pdfDown: false,
      pdfStall: false,
      unexpected: [],
      questions: [],
      pdfStatuses: [],
    }
    await installApi(page, api)
    page.on('response', (response) => {
      if (isPdf(new URL(response.url()))) api.pdfStatuses.push(response.status())
    })
    await use(api)
    expect(api.unexpected, 'requests to /api/* without a fixture').toEqual([])
    // The server's own calls (SSR) that the stub doesn't answer: kept for the whole run.
    const stubbed = await (await fetch(`${STUB_ORIGIN}/__unexpected`)).json()
    expect(stubbed, 'requests to the Supabase stub it does not answer').toEqual([])
  },
  // PDF.js logs "Setting up fake worker." when its worker can't start (e.g.
  // blocked by COEP or CSP) and runs on the main thread instead.
  fakeWorker: async ({ page }, use) => {
    const state = { used: false }
    page.on('console', (message) => {
      if (/fake worker/i.test(message.text())) state.used = true
    })
    await use(state)
  },
})

export { expect }
