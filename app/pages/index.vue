<script setup lang="ts">
import type { ChatMessage, SourceRef } from '#shared/types/chat'
import { claimSentence, isRefusal, looksLikeRefusalPrefix, splitCitations, stripEmphasis } from '#shared/utils/citations'
import type { AnswerSegment } from '#shared/utils/citations'
import { MAX_QUESTION_LENGTH } from '#shared/limits'
import { documentInfo, pageName, passageText, sourceName } from '~/utils/corpus'
import { loadDocument } from '~/utils/pdf-documents'
import { loadPdfjs } from '~/utils/pdf-highlight'

// Chat + PDF viewer (docs/WIREFRAMES.md §1–7). A citation chip (or source
// card) opens the cited chunk in the viewer: scrolled to the page, passage
// highlighted from its stored rects. Desktop: split pane; small screens: the
// viewer opens as a full-height sheet. Deep link: /?chunk=<id>[&zoom=<scale>].

useSeoMeta({
  title: 'TruthBase',
  description: 'Ask the documents. Every answer cites its source.',
})

const EXAMPLES = [
  'What are the six Functions of the NIST CSF 2.0?',
  'How does RAPTOR cluster text chunks?',
  'What is residual risk?',
]

const { data: documents } = await useFetch('/api/documents', { default: () => [] })
const documentId = ref<string>('all')
const documentItems = computed(() => [
  { label: 'All documents', value: 'all' },
  ...documents.value.map(d => ({ label: documentInfo(d.filename).short, value: d.id })),
])

/** The active scope, as the composer chip names it ("NIST CSF 2.0"); undefined: all documents. */
const scopeName = computed(() => {
  if (documentId.value === 'all') return undefined
  const doc = documents.value.find(d => d.id === documentId.value)
  return doc ? documentInfo(doc.filename).short : undefined
})

function clearScope() {
  documentId.value = 'all'
  void announceNotice('Searching all documents.')
  focusQuestion()
}

const input = ref('')
const lastQuestion = ref('')
const questionBox = ref<{ textareaRef?: HTMLTextAreaElement | null }>()
/** The scrolling conversation column: each new question is scrolled to its top. */
const chatScroller = ref<HTMLElement>()
/** The scope each question was asked in, by user message id (shown under "You" when it was one document). */
const askedIn = shallowReactive(new Map<string, string>())
/** A short status of the page's own (no answer state to report): "New conversation.", "Searching all documents.". */
const notice = ref('')
/** How the last answer ended early, if it did: cut off by the network, or by Stop. */
const ending = ref<'interrupted' | 'stopped'>()
const { messages, sendMessage, regenerate, status, stop, error, clearError, warm: warmChat } = useLazyChat<ChatMessage>(ai => ({
  transport: new ai.DefaultChatTransport({
    api: '/api/chat',
    // Single-turn by design: send only the latest question (server/api/chat.post.ts).
    prepareSendMessagesRequest: ({ messages }) => {
      const last = messages.at(-1)
      const question = last?.parts.map(p => (p.type === 'text' ? p.text : '')).join('') ?? ''
      return { body: { question, documentId: documentId.value === 'all' ? undefined : documentId.value } }
    },
  }),
  onFinish: ({ message, isAbort, isDisconnect, isError, finishReason }) => {
    if (isAbort) ending.value = 'stopped'
    // A dropped connection mid-answer, or a stream that just stops: the route
    // ends every model answer with a finish reason (the no-sources refusal is
    // written directly and has none).
    else if ((isDisconnect && textOf(message).trim()) || (!isError && !finishReason && !refused(message))) ending.value = 'interrupted'
  },
}))

// Off the first paint, but ready by the time a question is typed.
onNuxtReady(warmChat)

const busy = computed(() => status.value === 'submitted' || status.value === 'streaming')

/** The examples not yet asked, offered again below the conversation. */
const moreExamples = computed(() => {
  const asked = new Set(messages.value.filter(m => m.role === 'user').map(m => textOf(m).trim()))
  return EXAMPLES.filter(example => !asked.has(example))
})

function focusQuestion() {
  nextTick(() => questionBox.value?.textareaRef?.focus())
}

async function announceNotice(text: string) {
  // Cleared first: the same text again would not be announced.
  notice.value = ''
  await nextTick()
  notice.value = text
}

function ask(question: string) {
  const text = question.trim()
  if (!text || busy.value || capped.value) return
  // Re-sending after a failure replaces the failed turn instead of leaving
  // it unanswered above the new one.
  if (error.value || messages.value.at(-1)?.role === 'user') {
    const failed = messages.value.findLastIndex(m => m.role === 'user')
    if (failed >= 0) messages.value = messages.value.slice(0, failed)
  }
  input.value = ''
  lastQuestion.value = text
  ending.value = undefined
  notice.value = ''
  clearError()
  sendMessage({ text })
  focusQuestion()
}

function retry() {
  if (busy.value || capped.value) return
  if (input.value === lastQuestion.value) input.value = ''
  ending.value = undefined
  notice.value = ''
  clearError()
  // Asked again in the scope set now, so its label follows.
  const question = messages.value.findLast(m => m.role === 'user')
  if (question) setAskedIn(question.id)
  void regenerate()
  focusQuestion()
}

function setAskedIn(messageId: string) {
  if (scopeName.value) askedIn.set(messageId, scopeName.value)
  else askedIn.delete(messageId)
}

// A new question: record its scope (the request reads the same `documentId`)
// and bring it to the top of the conversation, so its answer streams in below
// it instead of out of sight under the earlier ones. While the answer is too
// short for the question to reach the top, the column follows it as it grows,
// until it gets there, the answer ends, or the reader scrolls themselves.
const conversationEl = ref<HTMLElement>()
let following: string | undefined

/** Scrolls question `id` toward the top (24 px below it); true once it is there or can't get closer. */
function scrollToQuestion(id: string): boolean {
  const el = chatScroller.value
  const article = el?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
  if (!el || !article) return true
  const top = Math.max(0, el.scrollTop + article.getBoundingClientRect().top - el.getBoundingClientRect().top - 24)
  const target = Math.min(top, el.scrollHeight - el.clientHeight)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (Math.abs(el.scrollTop - target) > 1) el.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' })
  return target >= top
}

watch(() => messages.value.findLast(m => m.role === 'user')?.id, (id, previous) => {
  if (!id || id === previous) return
  setAskedIn(id)
  following = id
  nextTick(() => {
    if (following === id && scrollToQuestion(id)) following = undefined
  })
})
useResizeObserver(conversationEl, () => {
  if (following && scrollToQuestion(following)) following = undefined
})
watch(busy, (now) => {
  if (now || !following) return
  const id = following
  following = undefined
  nextTick(() => scrollToQuestion(id))
})
// The reader takes over: no more following.
const stopFollowing = () => (following = undefined)
useEventListener(chatScroller, ['wheel', 'touchstart', 'pointerdown'], stopFollowing, { passive: true })
useEventListener(chatScroller, 'keydown', (event: KeyboardEvent) => {
  if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) stopFollowing()
})

/**
 * Starts over: the conversation, its open citation and the URL's passage are
 * cleared; the scope and an unsent draft stay. Offered only while nothing is
 * being answered (Stop comes first), so no stream writes into the new one.
 */
function newConversation() {
  if (busy.value) return
  messages.value = []
  askedIn.clear()
  clearError()
  ending.value = undefined
  lastQuestion.value = ''
  active.value = undefined
  viewerTarget.value = undefined
  targetKind.value = undefined
  viewerDocumentId.value = documentId.value === 'all' ? undefined : documentId.value
  returnFocusTo = null
  following = undefined
  chatScroller.value?.scrollTo({ top: 0 })
  void announceNotice('New conversation.')
  focusQuestion()
}

// ── errors and limits ──────────────────────────────────────────────────────
/** Error bodies arrive as the raw response text; JSON for h3 errors. */
function errorBody(raw: string): { statusCode?: number, message?: string, data?: { quota?: string, retryAfter?: number } } | undefined {
  if (!raw.trimStart().startsWith('{')) return undefined
  try {
    return JSON.parse(raw)
  }
  catch {
    return undefined
  }
}

/** A daily-quota 429 ({ data: { quota, retryAfter } }, server/utils/quota.ts): its message and reset time. */
function dailyCapOf(raw: string): { message: string, resetAt: number } | undefined {
  const body = errorBody(raw)
  if (!body?.data?.quota || !body.message) return undefined
  const seconds = Number(body.data.retryAfter)
  // Without Retry-After, the cap resets at the next UTC midnight (ADR-0010).
  const resetAt = Number.isFinite(seconds) && seconds > 0
    ? Date.now() + seconds * 1000
    : new Date().setUTCHours(24, 0, 0, 0)
  return { message: body.message, resetAt }
}

/** Kept apart from `error`, so the block survives clearError until the reset. */
const cap = ref<{ message: string, resetAt: number }>()
const now = ref(Date.now())
const capTimer = useIntervalFn(() => (now.value = Date.now()), 60_000, { immediate: false })
const capped = computed(() => !!cap.value && now.value < cap.value.resetAt)
const capResetTime = computed(() => cap.value
  ? new Date(cap.value.resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : '')
const capDescription = computed(() => {
  if (!cap.value) return ''
  const minutes = Math.max(1, Math.ceil((cap.value.resetAt - now.value) / 60_000))
  const wait = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  return `${cap.value.message} Back in about ${wait}, at ${capResetTime.value}.`
})

watch(error, (failed) => {
  const daily = dailyCapOf(failed?.message ?? '')
  if (daily) {
    cap.value = daily
    now.value = Date.now()
    capTimer.resume()
    return
  }
  // A failed question goes back into the box, so it can be edited or re-sent.
  if (failed && !input.value && ending.value !== 'interrupted') input.value = lastQuestion.value
})

// The cap lifts at its reset: drop the unanswered turn and offer the question again.
watch(now, () => {
  if (!cap.value || capped.value) return
  cap.value = undefined
  capTimer.pause()
  if (messages.value.at(-1)?.role === 'user') messages.value = messages.value.slice(0, -1)
  clearError()
  if (!input.value) input.value = lastQuestion.value
})

type ErrorKind = 'rate' | 'length' | 'provider' | 'network' | 'other'
const errorKind = computed((): ErrorKind => {
  const raw = error.value?.message ?? ''
  const code = errorBody(raw)?.statusCode
  if (code === 429 || /\b429\b|too many requests/i.test(raw)) return 'rate'
  if (code === 400 || /\b400\b|bad request/i.test(raw)) return 'length'
  if ((code && code >= 500) || /\b50[234]\b|service unavailable|answer service/i.test(raw)) return 'provider'
  if (error.value?.name === 'TypeError' || /network ?error|failed to fetch|load failed/i.test(raw)) return 'network'
  return 'other'
})

/** What the reader sees for a failed request; server detail stays in the console. */
const errorMessage = computed(() => {
  const raw = error.value?.message ?? ''
  switch (errorKind.value) {
    // The quota's own message states the limit ("… (5 a minute) …"); nuxt-security's has none.
    case 'rate': {
      const quota = errorBody(raw)?.message
      return quota?.startsWith('Too many') ? quota : 'Too many questions in a short time. Wait a minute, then try again.'
    }
    case 'length': return `Questions must be 1–${MAX_QUESTION_LENGTH} characters.`
    case 'network': return 'The connection dropped. Check your network, then try again.'
  }
  // Messages written by the chat route's onError are already meant for readers.
  if (raw && raw.length < 200 && !raw.trimStart().startsWith('{') && !/<html/i.test(raw)) return raw
  return 'Please try again in a moment.'
})

/** Status titles name the state in a few words, without a full stop (DESIGN.md "Status messages"). */
const errorTitle = computed(() => {
  switch (errorKind.value) {
    case 'rate': return 'Per-minute limit reached'
    case 'length': return 'Question not accepted'
    case 'provider': return 'Answer service unavailable'
    case 'network': return 'Connection lost'
    default: return 'Answer failed'
  }
})

/** Shown as an alert; a cut stream gets the quieter "Answer interrupted." notice instead. */
const showError = computed(() => !!error.value && !cap.value && ending.value !== 'interrupted')
const lengthError = computed(() => showError.value && errorKind.value === 'length')

function onKeydown(event: KeyboardEvent) {
  // Enter while an IME is composing (Japanese, Chinese, …) confirms the candidate.
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    ask(input.value)
  }
}

function onAskButton() {
  if (busy.value) stop()
}

// "/" focuses the question from anywhere but a text field or an open menu.
useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="listbox"], [role="combobox"], [role="menu"]')) return
  event.preventDefault()
  focusAfterViewer(questionBox.value?.textareaRef)
})

// ── answers ────────────────────────────────────────────────────────────────
type SourcesPart = Extract<ChatMessage['parts'][number], { type: 'data-sources' }>
const sourcesOf = (message: ChatMessage): SourceRef[] =>
  message.parts.find((p): p is SourcesPart => p.type === 'data-sources')?.data.sources ?? []
const textOf = (message: ChatMessage) =>
  message.parts.map(p => (p.type === 'text' ? p.text : '')).join('')
/** Answer text as shown: plain text (the prompt asks for it; stray **bold** is unwrapped). */
const answerOf = (message: ChatMessage) => stripEmphasis(textOf(message))
const refused = (message: ChatMessage) => isRefusal(textOf(message), sourcesOf(message).length)
const segmentsOf = (message: ChatMessage) => splitCitations(answerOf(message), sourcesOf(message).length)

/** The message still being written. */
const isStreaming = (message: ChatMessage) => busy.value && messages.value.at(-1)?.id === message.id

/**
 * Segments as rendered: the space before a chip is dropped ("restoration [1]."
 * reads "restoration¹."), and so is a marker still streaming in ("[1", "【2†").
 */
function displaySegments(message: ChatMessage): AnswerSegment[] {
  const segments = segmentsOf(message)
  return segments.flatMap((segment, i): AnswerSegment[] => {
    if (segment.type !== 'text') return [segment]
    let text = segment.text
    if (segments[i + 1]?.type === 'cite') text = text.trimEnd()
    if (i === segments.length - 1) text = text.replace(/\s*(?:\[[\d\s,，\-–]*|【[^】]*)$/, '')
    return text ? [{ type: 'text', text }] : []
  })
}

/** An assistant turn with nothing to show yet (or ever: a stream that failed first). */
const visibleMessages = computed(() => messages.value.filter(m =>
  m.role === 'user' || isStreaming(m) || textOf(m).trim() !== ''))
/** The question is out, but no answer has started. */
const pending = computed(() => busy.value && messages.value.at(-1)?.role === 'user')

function citedIndexes(message: ChatMessage): Set<number> {
  return new Set(segmentsOf(message).flatMap(s => (s.type === 'cite' ? [s.index] : [])))
}

/** A refusal's "possibly related" passages: one row per page, at most three. */
function relatedOf(message: ChatMessage): SourceRef[] {
  const seen = new Set<string>()
  return sourcesOf(message).filter((s) => {
    const key = `${s.documentId}:${s.pageNumber}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 3)
}

/** Where a source is, as shown: "NIST CSF 2.0 · p. 23 (PDF 28)". */
const shortName = (source: SourceRef) => documentInfo(source.filename).short
const pageText = (source: SourceRef) => pageName(source.filename, source.pageNumber).text

/** The start of the passage, without the running head or folio the chunk picked up. */
function excerpt(source: SourceRef): string {
  const text = passageText(source)
  return text.length > 140 ? `${text.slice(0, 140).trimEnd()}…` : text
}

/** Tooltip for a citation chip: where it points, and the start of the passage. */
function citationTip(source: SourceRef | undefined): { where: string, quote: string } | undefined {
  if (!source) return undefined
  return { where: `${shortName(source)} · ${pageText(source)}`, quote: excerpt(source) }
}

/**
 * Chip tooltips need a hovering pointer. On touch a tap opens the citation, so
 * a tooltip only got stuck open over the answer, and reopened when closing the
 * sheet handed focus back to the chip.
 */
const canHover = useMediaQuery('(hover: hover) and (pointer: fine)')

function citationAriaLabel(message: ChatMessage, index: number): string {
  const source = sourcesOf(message)[index - 1]
  return `Citation ${index}: ${source ? sourceName(source) : 'source'}`
}

// One status line for screen readers instead of announcing every streamed token.
const liveStatus = computed(() => {
  if (status.value === 'submitted') return 'Searching the documents…'
  if (status.value === 'streaming') return 'Answering…'
  if (notice.value) return notice.value
  // No countdown here: the minute tick would re-announce it. The alert shows it.
  if (capped.value) return `Daily demo limit reached. ${cap.value!.message} Back at ${capResetTime.value}.`
  if (ending.value === 'interrupted') return 'Answer interrupted.'
  if (ending.value === 'stopped') return 'Stopped.'
  if (error.value) return `${errorTitle.value}. ${errorMessage.value}`
  const last = messages.value.at(-1)
  if (last?.role !== 'assistant') return ''
  if (refused(last)) return 'Not found in the documents.'
  const n = citedIndexes(last).size
  return `Answer ready, ${n} ${n === 1 ? 'source' : 'sources'}.`
})

// ── viewer ─────────────────────────────────────────────────────────────────
const route = useRoute()
const isDesktop = useMediaQuery('(min-width: 1024px)')
const viewer = ref<{ focus: () => void }>()
const viewerOpen = ref(false) // small screens: the sheet
const viewerDocumentId = ref<string>()
const viewerTarget = ref<SourceRef>()
/** Bumped on each open, so clicking the active citation scrolls back to it. */
const targetNonce = ref(0)
/** What the viewer shows: an answer's citation, a deep link, or a possibly related passage. */
const targetKind = ref<'citation' | 'link' | 'related'>()
const active = ref<{ messageId: string, index: number }>()
const zoomQuery = Number(route.query.zoom)
/** Manual zoom, kept across viewer remounts (the phone sheet unmounts on close); undefined = fit width. */
const viewerZoom = ref(Number.isFinite(zoomQuery) && zoomQuery > 0 ? Math.min(3, Math.max(0.5, zoomQuery)) : undefined)
const viewerFilename = computed(() => documents.value.find(d => d.id === viewerDocumentId.value)?.filename)
/** The sentence of the answer that the open citation backs (the phone sheet shows it with the evidence). */
const viewerClaim = computed(() => targetKind.value === 'citation' && activeMessage.value && active.value
  ? claimSentence(segmentsOf(activeMessage.value), active.value.index) || undefined
  : undefined)
let returnFocusTo: HTMLElement | null = null
/** Where focus goes once the phone sheet has closed (instead of its default: the element that opened it). */
let focusOnSheetClose: HTMLElement | null = null

function focusAfterViewer(target: HTMLElement | null | undefined) {
  if (!viewerOpen.value) return target?.focus()
  focusOnSheetClose = target ?? null
  viewerOpen.value = false
}

function onSheetCloseAutoFocus(event: Event) {
  if (!focusOnSheetClose) return
  event.preventDefault()
  focusOnSheetClose.focus()
  focusOnSheetClose = null
}

// Until a citation is opened, the viewer follows the document filter. With
// "All documents" it starts empty: no PDF is fetched before a question.
watch(documentId, (id) => {
  if (!viewerTarget.value && id !== 'all') viewerDocumentId.value = id
}, { immediate: true })

/** Picked in the viewer's own switcher: the document from page 1, no citation. */
function selectDocument(id: string) {
  viewerDocumentId.value = id
  viewerTarget.value = undefined
  active.value = undefined
  targetKind.value = undefined
}

/** A row of the corpus index: the document from page 1 (on phones, in the sheet). */
function openDocument(id: string, from: HTMLElement | null) {
  returnFocusTo = from
  selectDocument(id)
  if (!isDesktop.value) viewerOpen.value = true
  nextTick(() => viewer.value?.focus())
}

/** Warm PDF.js (and, while the viewer is empty, the first cited document) before a chip is clicked. */
function warmViewer(documentId?: string) {
  if (!import.meta.client) return
  void loadPdfjs().catch(() => {})
  // pdf-documents keeps one document open: never supersede the one shown.
  if (documentId && !viewerDocumentId.value) void loadDocument(documentId).catch(() => {})
}

watch(() => {
  const last = messages.value.at(-1)
  return last?.role === 'assistant' ? sourcesOf(last)[0]?.documentId : undefined
}, (id) => {
  if (id) warmViewer(id)
})

/** Citation numbers of an answer in reading order (for Citation n of m / prev / next). */
function citationOrder(message: ChatMessage): number[] {
  return [...citedIndexes(message)]
}

const activeMessage = computed(() => messages.value.find(m => m.id === active.value?.messageId))
const canStep = computed(() => targetKind.value === 'citation' && !!activeMessage.value && citationOrder(activeMessage.value).length > 1)
const citationLabel = computed(() => {
  if (!viewerTarget.value) return undefined
  if (targetKind.value === 'related') return 'Possibly related, not a source'
  if (targetKind.value !== 'citation' || !activeMessage.value || !active.value) return 'Linked citation'
  const order = citationOrder(activeMessage.value)
  return `Citation ${order.indexOf(active.value.index) + 1} of ${order.length}`
})

function showInViewer(source: SourceRef, kind: 'citation' | 'link' | 'related', from?: EventTarget | null) {
  returnFocusTo = from instanceof HTMLElement ? from : null
  targetKind.value = kind
  viewerDocumentId.value = source.documentId
  viewerTarget.value = source
  targetNonce.value++
  if (!isDesktop.value) viewerOpen.value = true
  nextTick(() => viewer.value?.focus())
}

function openCitation(message: ChatMessage, index: number, from?: EventTarget | null) {
  const source = sourcesOf(message)[index - 1]
  if (!source) return
  active.value = { messageId: message.id, index }
  showInViewer(source, 'citation', from)
}

/** A refusal's "possibly related" passage: its page, but no highlight — it is not evidence. */
function openRelated(source: SourceRef, from?: EventTarget | null) {
  active.value = undefined
  showInViewer({ ...source, highlight: null }, 'related', from)
}

function stepCitation(delta: 1 | -1) {
  if (!activeMessage.value || !active.value) return
  const order = citationOrder(activeMessage.value)
  const next = order[order.indexOf(active.value.index) + delta]
  if (next === undefined) return
  // Esc then returns to the chip of the citation now shown.
  const chip = document.querySelector<HTMLElement>(`[data-cite="${activeMessage.value.id}-${next}"]`)
  openCitation(activeMessage.value, next, chip ?? returnFocusTo)
}

function closeViewer() {
  focusAfterViewer(returnFocusTo?.isConnected ? returnFocusTo : questionBox.value?.textareaRef)
}

function onViewerKeydown(event: KeyboardEvent) {
  if (event.key === '[') stepCitation(-1)
  else if (event.key === ']') stepCitation(1)
  else if (event.key === 'Escape') {
    // A deep link (or a chip that is gone) has nothing to return to.
    closeViewer()
  }
}

/**
 * The passage the viewer shows as evidence (a citation or a deep link; a
 * "possibly related" page is not one), while it is on screen. The address bar
 * carries it as ?chunk=<id>, and "Copy link" copies the same link.
 */
const sharedChunk = computed(() => {
  if (!viewerTarget.value || targetKind.value === 'related') return undefined
  if (!isDesktop.value && !viewerOpen.value) return undefined
  return viewerTarget.value.chunkId
})
const passageLink = computed(() => sharedChunk.value && import.meta.client
  ? new URL(`/?chunk=${encodeURIComponent(sharedChunk.value)}`, window.location.origin).href
  : undefined)

// replaceState, not the router: no navigation, no new history entry per
// citation, and Vue Router's own history.state is kept. Other parameters
// (?zoom=) stay as they are.
watch(sharedChunk, (id) => {
  if (!import.meta.client) return
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('chunk', id)
  else url.searchParams.delete('chunk')
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url)
})

const isActive = (message: ChatMessage, index: number) =>
  active.value?.messageId === message.id && active.value.index === index

onMounted(async () => {
  const chunk = route.query.chunk
  if (typeof chunk !== 'string') return
  try {
    const source = await $fetch(`/api/chunks/${chunk}`)
    targetKind.value = 'link'
    viewerDocumentId.value = source.documentId
    viewerTarget.value = source
    targetNonce.value++
    if (!isDesktop.value) viewerOpen.value = true
  }
  catch {
    // Unknown or malformed chunk id: the viewer stays as it is.
  }
})
</script>

<template>
  <div class="flex h-dvh">
    <main
      class="flex min-w-0 flex-1 flex-col lg:max-w-[42%] lg:border-r lg:border-default"
      aria-label="Chat"
    >
      <div
        ref="chatScroller"
        class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-6"
      >
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="font-serif text-[1.75rem] leading-tight font-semibold tracking-tight text-highlighted">
              TruthBase
            </h1>
            <p class="text-sm text-muted">
              Ask the documents. Every answer cites its source.
            </p>
          </div>
          <USelect
            v-model="documentId"
            :items="documentItems"
            class="w-56"
            aria-label="Documents to search"
          />
        </header>

        <section
          v-if="messages.length === 0"
          class="flex flex-col gap-2"
          aria-label="Example questions"
        >
          <h2 class="text-xs font-semibold tracking-wider uppercase text-muted">
            Try a question
          </h2>
          <UButton
            v-for="example in EXAMPLES"
            :key="example"
            variant="soft"
            color="neutral"
            icon="i-lucide-message-circle-question"
            class="justify-start text-left"
            @click="ask(example)"
          >
            {{ example }}
          </UButton>
          <p class="mt-2 text-sm text-muted">
            Click a citation to see the exact passage highlighted in the PDF.
          </p>
        </section>

        <!-- Phones: the corpus index in short rows (desktop: the empty viewer pane). -->
        <CorpusIndex
          v-if="messages.length === 0"
          class="lg:hidden"
          compact
          :documents="documents"
          @open="openDocument"
        />

        <p
          class="sr-only"
          role="status"
        >
          {{ liveStatus }}
        </p>

        <section
          ref="conversationEl"
          class="flex flex-col gap-6"
          aria-label="Conversation"
          :aria-busy="busy"
        >
          <h2 class="sr-only">
            Conversation
          </h2>
          <article
            v-for="message in visibleMessages"
            :key="message.id"
            class="flex flex-col gap-3"
            :data-message-id="message.id"
          >
            <template v-if="message.role === 'user'">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <h3 class="text-xs font-semibold tracking-wider uppercase text-muted">
                  You
                </h3>
                <!-- A question asked in one document says so, after the scope has moved on. -->
                <span
                  v-if="askedIn.get(message.id)"
                  class="text-xs text-muted"
                >in {{ askedIn.get(message.id) }} only</span>
              </div>
              <p class="break-words">{{ textOf(message) }}</p>
            </template>

            <template v-else>
              <div class="flex items-center gap-2">
                <h3 class="text-xs font-semibold tracking-wider uppercase text-muted">
                  TruthBase
                </h3>
                <span
                  v-if="isStreaming(message)"
                  class="flex items-center gap-1.5 text-xs text-muted"
                  aria-hidden="true"
                >
                  <UIcon
                    name="i-lucide-loader-circle"
                    class="size-3.5 animate-spin motion-reduce:animate-none"
                  />
                  Writing the answer…
                </span>
              </div>

              <!-- Grounded refusal: a correct answer, so neutral and in the
                   document voice, not an alert (WIREFRAMES §4). The dashed
                   rule means "no evidence" (DESIGN.md "The Dashed Line Rule"). -->
              <template v-if="refused(message)">
                <div class="flex gap-3 rounded-md border border-dashed border-accented px-4 py-3">
                  <UIcon
                    name="i-lucide-search-x"
                    class="mt-1 size-5 shrink-0 text-muted"
                    aria-hidden="true"
                  />
                  <div class="flex flex-col gap-1">
                    <p class="font-serif text-[1.0625rem] font-semibold text-highlighted">
                      Not found in the documents.
                    </p>
                    <p class="text-sm text-muted">
                      None of the retrieved passages answers this. TruthBase doesn’t guess.
                    </p>
                  </div>
                </div>
                <div
                  v-if="sourcesOf(message).length"
                  class="text-sm text-muted"
                >
                  <p>Possibly related (not used as sources):</p>
                  <ul class="ml-4 flex list-disc flex-col gap-1">
                    <li
                      v-for="source in relatedOf(message)"
                      :key="source.chunkId"
                    >
                      <button
                        type="button"
                        class="inline-flex min-h-6 cursor-pointer items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-default"
                        :aria-label="`Open ${sourceName(source)}: possibly related, not a source`"
                        @click="openRelated(source, $event.currentTarget)"
                      >
                        {{ shortName(source) }} · {{ pageText(source) }}
                      </button>
                    </li>
                  </ul>
                </div>
              </template>

              <template v-else>
                <p
                  v-if="!looksLikeRefusalPrefix(textOf(message))"
                  class="font-serif text-[1.0625rem] leading-relaxed whitespace-pre-wrap text-highlighted"
                >
                  <template
                    v-for="(segment, i) in displaySegments(message)"
                    :key="i"
                  >
                    <span v-if="segment.type === 'text'">{{ segment.text }}</span>
                    <UTooltip
                      v-else
                      :disabled="!canHover"
                      ignore-non-keyboard-focus
                      :content="{ side: 'top' }"
                      :ui="{ content: 'h-auto max-w-[min(20rem,calc(100vw-1rem))] py-1.5' }"
                    >
                      <template #content>
                        <span
                          v-if="citationTip(sourcesOf(message)[segment.index - 1])"
                          class="flex flex-col gap-0.5"
                        >
                          <span class="font-medium tabular-nums">{{ citationTip(sourcesOf(message)[segment.index - 1])!.where }}</span>
                          <span class="font-serif text-toned">“{{ citationTip(sourcesOf(message)[segment.index - 1])!.quote }}”</span>
                        </span>
                      </template>
                      <UButton
                        size="xs"
                        :variant="isActive(message, segment.index) ? 'solid' : 'soft'"
                        class="ml-0.5 min-w-6 cursor-pointer justify-center align-baseline font-semibold tabular-nums"
                        :data-cite="`${message.id}-${segment.index}`"
                        :aria-current="isActive(message, segment.index) ? 'true' : undefined"
                        :aria-label="citationAriaLabel(message, segment.index)"
                        @click="openCitation(message, segment.index, $event.currentTarget)"
                        @pointerenter="warmViewer()"
                        @focus="warmViewer()"
                      >
                        {{ segment.index }}
                      </UButton>
                    </UTooltip>
                  </template>
                  <span
                    v-if="isStreaming(message)"
                    class="ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-[0.2em] animate-pulse bg-current motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                </p>

                <!-- Rendered once the answer is complete, so it doesn't jump with every line. -->
                <div
                  v-if="citedIndexes(message).size && !isStreaming(message)"
                  class="flex flex-col gap-2"
                >
                  <h4 class="text-xs font-semibold tracking-wider uppercase text-muted">
                    Sources
                  </h4>
                  <ol class="flex flex-col gap-2">
                    <li
                      v-for="source in sourcesOf(message).filter(s => citedIndexes(message).has(s.index))"
                      :key="source.chunkId"
                    >
                      <button
                        type="button"
                        class="w-full cursor-pointer rounded-md border p-3 text-left text-sm transition-colors hover:bg-muted"
                        :class="isActive(message, source.index) ? 'border-primary bg-primary/5' : 'border-default'"
                        :aria-current="isActive(message, source.index) ? 'true' : undefined"
                        :aria-label="`Source ${source.index}: ${sourceName(source)}`"
                        :aria-describedby="`${message.id}-source-${source.index}`"
                        @click="openCitation(message, source.index, $event.currentTarget)"
                      >
                        <span class="mb-1 flex items-center gap-2 font-medium">
                          <span
                            class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm px-1 font-serif text-xs font-semibold tabular-nums"
                            :class="isActive(message, source.index) ? 'bg-primary text-inverted' : 'bg-primary/10 text-primary'"
                          >{{ source.index }}</span>
                          <span class="min-w-0 truncate">{{ shortName(source) }}</span>
                          <span
                            class="ms-auto shrink-0 text-xs font-normal tabular-nums"
                            :class="isActive(message, source.index) ? 'text-toned' : 'text-muted'"
                          >{{ pageText(source) }}</span>
                        </span>
                        <span
                          class="line-clamp-3 font-serif"
                          :class="isActive(message, source.index) ? 'text-toned' : 'text-muted'"
                        >
                          {{ passageText(source) }}
                        </span>
                        <span
                          :id="`${message.id}-source-${source.index}`"
                          class="sr-only"
                        >{{ excerpt(source) }}</span>
                      </button>
                    </li>
                  </ol>
                </div>
              </template>
            </template>
          </article>

          <!-- Same header row as the answer that replaces it, so nothing shifts. -->
          <div
            v-if="pending"
            class="flex items-center gap-2"
            aria-hidden="true"
          >
            <span class="text-xs font-semibold tracking-wider uppercase text-muted">TruthBase</span>
            <span class="flex items-center gap-1.5 text-xs text-muted">
              <UIcon
                name="i-lucide-loader-circle"
                class="size-3.5 animate-spin motion-reduce:animate-none"
              />
              Searching the documents…
            </span>
          </div>

          <!-- Stream cut or stopped (WIREFRAMES §7): partial citations stay clickable. -->
          <div
            v-if="ending && !busy"
            class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted"
          >
            <span class="flex items-center gap-1.5">
              <UIcon
                :name="ending === 'interrupted' ? 'i-lucide-unplug' : 'i-lucide-square'"
                class="size-4 shrink-0"
                aria-hidden="true"
              />
              {{ ending === 'interrupted' ? 'Answer interrupted.' : 'Stopped.' }}
            </span>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              @click="retry"
            >
              Regenerate
            </UButton>
          </div>

          <!-- Daily cap (ADR-0010 §3): no Retry, the box stays readable until the reset. -->
          <UAlert
            v-if="capped"
            id="ask-error"
            color="neutral"
            variant="subtle"
            icon="i-lucide-clock"
            title="Daily demo limit reached"
            :description="capDescription"
            :ui="{ description: 'opacity-100' }"
          />
          <UAlert
            v-else-if="showError"
            id="ask-error"
            :color="errorKind === 'rate' ? 'warning' : 'error'"
            variant="subtle"
            :icon="errorKind === 'rate' ? 'i-lucide-hourglass' : 'i-lucide-circle-alert'"
            :title="errorTitle"
            :description="errorMessage"
            :ui="{ description: 'opacity-100' }"
            :actions="errorKind === 'length' ? [] : [{ label: 'Retry', color: errorKind === 'rate' ? 'warning' : 'error', variant: 'outline', onClick: retry }]"
          />
        </section>

        <!-- The examples stay reachable after the first question. -->
        <section
          v-if="messages.length && !busy && !capped && !showError && moreExamples.length"
          class="flex flex-col gap-1 border-t border-default pt-4"
          aria-labelledby="more-examples"
        >
          <h2
            id="more-examples"
            class="text-xs font-semibold tracking-wider uppercase text-muted"
          >
            Try another question
          </h2>
          <ul class="flex flex-col">
            <li
              v-for="example in moreExamples"
              :key="example"
            >
              <button
                type="button"
                class="inline-flex min-h-8 cursor-pointer items-center gap-2 text-left text-sm text-toned transition-colors hover:text-highlighted"
                @click="ask(example)"
              >
                <UIcon
                  name="i-lucide-message-circle-question"
                  class="size-4 shrink-0 text-muted"
                  aria-hidden="true"
                />
                {{ example }}
              </button>
            </li>
          </ul>
        </section>
      </div>

      <div class="border-t border-default px-4 py-3 sm:px-6">
        <!-- What the next question runs against, and a way to start over: both
             stay beside the box, where the header's select has scrolled away. -->
        <div
          v-if="scopeName || (messages.length && !busy)"
          class="mb-2 flex min-h-8 flex-wrap items-center gap-2"
        >
          <span
            v-if="scopeName"
            class="inline-flex max-w-full min-w-0 items-center rounded-sm border border-default bg-elevated ps-2 text-xs text-toned"
          >
            <UIcon
              name="i-lucide-filter"
              class="me-1.5 size-3.5 shrink-0 text-muted"
              aria-hidden="true"
            />
            <span
              id="ask-scope"
              class="min-w-0 truncate"
            >Searching {{ scopeName }} only</span>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="link"
              size="xs"
              class="-my-px min-h-7 shrink-0 px-1.5 [--focus-ring-offset:-2px]"
              :aria-label="`Search all documents (remove filter ${scopeName})`"
              @click="clearScope"
            />
          </span>
          <UButton
            v-if="messages.length && !busy"
            icon="i-lucide-rotate-ccw"
            color="neutral"
            variant="ghost"
            size="xs"
            class="ms-auto min-h-7 text-muted hover:text-highlighted"
            @click="newConversation"
          >
            New conversation
          </UButton>
        </div>
        <form
          class="flex items-end gap-2"
          aria-label="Ask a question"
          @submit.prevent="ask(input)"
        >
          <UTextarea
            ref="questionBox"
            v-model="input"
            :rows="1"
            :maxrows="6"
            autoresize
            class="flex-1"
            :placeholder="capped ? `Back at ${capResetTime}` : scopeName ? `Ask ${scopeName}…` : 'Ask a question…'"
            aria-label="Question"
            aria-keyshortcuts="/"
            :readonly="capped || undefined"
            :aria-invalid="lengthError || undefined"
            :aria-describedby="[lengthError && 'ask-error', scopeName && 'ask-scope'].filter(Boolean).join(' ') || undefined"
            :maxlength="MAX_QUESTION_LENGTH"
            @keydown="onKeydown"
          >
            <template
              v-if="!input && !capped"
              #trailing
            >
              <UKbd
                value="/"
                class="hidden sm:inline-flex"
                aria-hidden="true"
              />
            </template>
          </UTextarea>
          <!-- One button that turns into Stop, so focus never falls out of the form. -->
          <UButton
            :type="busy ? 'button' : 'submit'"
            :color="busy ? 'neutral' : 'primary'"
            :variant="busy ? 'outline' : 'solid'"
            :icon="busy ? 'i-lucide-square' : 'i-lucide-send'"
            :aria-disabled="!busy && (!input.trim() || capped) ? true : undefined"
            @click="onAskButton"
          >
            {{ busy ? 'Stop' : 'Ask' }}
          </UButton>
        </form>
        <p class="mt-2 text-center text-xs text-muted">
          Answers come only from these documents.
        </p>
      </div>
    </main>

    <!-- The viewer is browser-only (PDF.js), and pane vs. sheet depends on the
         viewport, which the server can't know: decide both inside ClientOnly. -->
    <ClientOnly>
      <!-- Desktop: the viewer pane. -->
      <div
        v-if="isDesktop"
        class="min-w-0 flex-1"
        @keydown="onViewerKeydown"
      >
        <PdfViewer
          ref="viewer"
          :document-id="viewerDocumentId"
          :filename="viewerFilename"
          :target="viewerTarget"
          :target-nonce="targetNonce"
          :citation-label="citationLabel"
          :passage-link="passageLink"
          :can-step="canStep"
          :documents="documents"
          :initial-scale="viewerZoom"
          @update:zoom="viewerZoom = $event"
          @select-document="selectDocument"
          @prev="stepCitation(-1)"
          @next="stepCitation(1)"
        >
          <template #empty>
            <CorpusIndex
              :documents="documents"
              @open="openDocument"
            />
          </template>
        </PdfViewer>
      </div>

      <!-- Small screens: the viewer as a full-height sheet (WIREFRAMES §6). -->
      <USlideover
        v-else
        v-model:open="viewerOpen"
        side="bottom"
        :title="viewerFilename ? documentInfo(viewerFilename).short : 'Document'"
        description="PDF viewer. Press Escape to close."
        :ui="{ content: 'h-dvh max-h-dvh' }"
        :content="{ onCloseAutoFocus: onSheetCloseAutoFocus }"
      >
        <template #content>
          <div
            class="flex h-full min-h-0 flex-col"
            @keydown="onViewerKeydown"
          >
            <PdfViewer
              ref="viewer"
              class="min-h-0 flex-1"
              :document-id="viewerDocumentId"
              :filename="viewerFilename"
              :target="viewerTarget"
              :target-nonce="targetNonce"
              :citation-label="citationLabel"
              :passage-link="passageLink"
              :can-step="canStep"
              :documents="documents"
              :initial-scale="viewerZoom"
              layout="sheet"
              :claim="viewerClaim"
              @update:zoom="viewerZoom = $event"
              @select-document="selectDocument"
              @close="closeViewer"
              @prev="stepCitation(-1)"
              @next="stepCitation(1)"
            />
          </div>
        </template>
      </USlideover>
    </ClientOnly>
  </div>
</template>
