<script setup lang="ts">
import type { ChatMessage, SourceRef } from '#shared/types/chat'
import { isRefusal, looksLikeRefusalPrefix, splitCitations, stripEmphasis } from '#shared/utils/citations'
import type { AnswerSegment } from '#shared/utils/citations'
import { MAX_QUESTION_LENGTH } from '#shared/limits'
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
  ...documents.value.map(d => ({ label: d.filename, value: d.id })),
])

const input = ref('')
const lastQuestion = ref('')
const questionBox = ref<{ textareaRef?: HTMLTextAreaElement | null }>()
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

function focusQuestion() {
  nextTick(() => questionBox.value?.textareaRef?.focus())
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
  clearError()
  sendMessage({ text })
  focusQuestion()
}

function retry() {
  if (busy.value || capped.value) return
  if (input.value === lastQuestion.value) input.value = ''
  ending.value = undefined
  clearError()
  void regenerate()
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
    case 'rate': return 'Too many questions in a short time. Wait a minute, then try again.'
    case 'length': return `Questions must be 1–${MAX_QUESTION_LENGTH} characters.`
    case 'network': return 'The connection dropped. Check your network, then try again.'
  }
  // Messages written by the chat route's onError are already meant for readers.
  if (raw && raw.length < 200 && !raw.trimStart().startsWith('{') && !/<html/i.test(raw)) return raw
  return 'Please try again in a moment.'
})

const errorTitle = computed(() => {
  if (errorKind.value === 'rate') return 'Slow down a moment'
  if (errorKind.value === 'provider') return 'The answer service is unavailable right now.'
  return 'The answer didn\'t come through.'
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

/** A source's page for labels: "unknown" when the chunk has none ("?" in visible text). */
function pageLabel(source: SourceRef | undefined, unknown: 'unknown' | '?' = 'unknown'): string {
  return String(source?.pageNumber ?? unknown)
}

function excerpt(source: SourceRef): string {
  return source.content.length > 140 ? `${source.content.slice(0, 140).trimEnd()}…` : source.content
}

/** Tooltip for a citation chip: where it points, and the start of the passage. */
function citationTooltip(source: SourceRef | undefined): string {
  if (!source) return ''
  return `${source.filename} · p. ${pageLabel(source, '?')} — “${excerpt(source)}”`
}

function citationAriaLabel(message: ChatMessage, index: number): string {
  const source = sourcesOf(message)[index - 1]
  return `Citation ${index}: ${source?.filename ?? 'source'}, page ${pageLabel(source)}`
}

// One status line for screen readers instead of announcing every streamed token.
const liveStatus = computed(() => {
  if (status.value === 'submitted') return 'Searching the documents…'
  if (status.value === 'streaming') return 'Answering…'
  // No countdown here: the minute tick would re-announce it. The alert shows it.
  if (capped.value) return `Daily demo limit reached. ${cap.value!.message} Back at ${capResetTime.value}.`
  if (ending.value === 'interrupted') return 'Answer interrupted.'
  if (ending.value === 'stopped') return 'Stopped.'
  if (error.value) return `The answer failed. ${errorMessage.value}`
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
      <div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-6">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="text-2xl font-bold">
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
          <p class="text-sm text-muted">
            Try:
          </p>
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

        <p
          class="sr-only"
          role="status"
        >
          {{ liveStatus }}
        </p>

        <section
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
          >
            <template v-if="message.role === 'user'">
              <h3 class="text-xs font-semibold uppercase text-muted">
                You
              </h3>
              <p>{{ textOf(message) }}</p>
            </template>

            <template v-else>
              <div class="flex items-center gap-2">
                <h3 class="text-xs font-semibold uppercase text-muted">
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

              <!-- Grounded refusal: neutral, not an error (WIREFRAMES §4). -->
              <template v-if="refused(message)">
                <UAlert
                  color="info"
                  variant="subtle"
                  icon="i-lucide-info"
                  title="Not found in the documents."
                  description="None of the retrieved passages answers this, so I won't guess."
                />
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
                        :aria-label="`Open ${source.filename}, page ${pageLabel(source)} (possibly related, not a source)`"
                        @click="openRelated(source, $event.currentTarget)"
                      >
                        {{ source.filename }} · p. {{ pageLabel(source, '?') }}
                        <UIcon
                          name="i-lucide-arrow-up-right"
                          class="size-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  </ul>
                </div>
              </template>

              <template v-else>
                <p
                  v-if="!looksLikeRefusalPrefix(textOf(message))"
                  class="leading-relaxed whitespace-pre-wrap"
                >
                  <template
                    v-for="(segment, i) in displaySegments(message)"
                    :key="i"
                  >
                    <span v-if="segment.type === 'text'">{{ segment.text }}</span>
                    <UTooltip
                      v-else
                      :text="citationTooltip(sourcesOf(message)[segment.index - 1])"
                      :content="{ side: 'top' }"
                    >
                      <UButton
                        size="xs"
                        :variant="isActive(message, segment.index) ? 'solid' : 'soft'"
                        class="ml-0.5 min-w-6 cursor-pointer justify-center align-baseline tabular-nums"
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
                  <h4 class="text-xs font-semibold uppercase text-muted">
                    Sources
                  </h4>
                  <ol class="flex flex-col gap-2">
                    <li
                      v-for="source in sourcesOf(message).filter(s => citedIndexes(message).has(s.index))"
                      :key="source.chunkId"
                    >
                      <button
                        type="button"
                        class="w-full cursor-pointer rounded-md border p-3 text-left text-sm transition-colors hover:bg-elevated"
                        :class="isActive(message, source.index) ? 'border-primary bg-primary/5' : 'border-default'"
                        :aria-current="isActive(message, source.index) ? 'true' : undefined"
                        :aria-label="`Source ${source.index}: ${source.filename}, page ${pageLabel(source)}`"
                        :aria-describedby="`${message.id}-source-${source.index}`"
                        @click="openCitation(message, source.index, $event.currentTarget)"
                      >
                        <span class="mb-1 flex items-center gap-2 font-medium">
                          <span
                            class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm px-1 text-xs tabular-nums"
                            :class="isActive(message, source.index) ? 'bg-primary text-inverted' : 'bg-primary/10 text-primary'"
                          >{{ source.index }}</span>
                          <span class="min-w-0 truncate">{{ source.filename }}</span>
                          <span
                            class="ms-auto shrink-0 text-xs font-normal tabular-nums"
                            :class="isActive(message, source.index) ? 'text-toned' : 'text-muted'"
                          >p. {{ pageLabel(source, '?') }}</span>
                        </span>
                        <span
                          class="line-clamp-3"
                          :class="isActive(message, source.index) ? 'text-toned' : 'text-muted'"
                        >
                          {{ source.content }}
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
            <span class="text-xs font-semibold uppercase text-muted">TruthBase</span>
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
      </div>

      <div class="border-t border-default px-4 py-3 sm:px-6">
        <form
          class="flex items-end gap-2"
          aria-label="Ask a question"
          @submit.prevent="ask(input)"
        >
          <UTextarea
            ref="questionBox"
            v-model="input"
            :rows="1"
            autoresize
            class="flex-1"
            :placeholder="capped ? `Back at ${capResetTime}` : 'Ask a question…'"
            aria-label="Question"
            aria-keyshortcuts="/"
            :readonly="capped || undefined"
            :aria-invalid="lengthError || undefined"
            :aria-describedby="lengthError ? 'ask-error' : undefined"
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
          :can-step="canStep"
          :documents="documents"
          :initial-scale="viewerZoom"
          @update:zoom="viewerZoom = $event"
          @select-document="selectDocument"
          @prev="stepCitation(-1)"
          @next="stepCitation(1)"
        />
      </div>

      <!-- Small screens: the viewer as a full-height sheet (WIREFRAMES §6). -->
      <USlideover
        v-else
        v-model:open="viewerOpen"
        side="bottom"
        :title="viewerFilename ?? 'Document'"
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
              :can-step="canStep"
              :documents="documents"
              :initial-scale="viewerZoom"
              layout="sheet"
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
