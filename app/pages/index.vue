<script setup lang="ts">
import { useChat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import type { ChatMessage, SourceRef } from '#shared/types/chat'
import { isRefusal, looksLikeRefusalPrefix, splitCitations, stripEmphasis } from '#shared/utils/citations'
import { chatRequestSchema } from '#shared/schemas'

// Chat + PDF viewer (docs/WIREFRAMES.md §1–6). A citation chip (or source
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

const MAX_QUESTION = chatRequestSchema.shape.question.maxLength ?? 1000
const input = ref('')
const lastQuestion = ref('')
const { messages, sendMessage, regenerate, status, stop, error, clearError } = useChat<ChatMessage>({
  transport: new DefaultChatTransport({
    api: '/api/chat',
    // Single-turn by design: send only the latest question (server/api/chat.post.ts).
    prepareSendMessagesRequest: ({ messages }) => {
      const last = messages.at(-1)
      const question = last?.parts.map(p => (p.type === 'text' ? p.text : '')).join('') ?? ''
      return { body: { question, documentId: documentId.value === 'all' ? undefined : documentId.value } }
    },
  }),
})

const busy = computed(() => status.value === 'submitted' || status.value === 'streaming')

function ask(question: string) {
  const text = question.trim()
  if (!text || busy.value) return
  if (error.value) {
    // Re-sending after a failure replaces the failed turn instead of leaving
    // it unanswered above the new one.
    const failed = messages.value.findLastIndex(m => m.role === 'user')
    if (failed >= 0) messages.value = messages.value.slice(0, failed)
  }
  input.value = ''
  lastQuestion.value = text
  clearError()
  sendMessage({ text })
}

function retry() {
  if (busy.value) return
  if (input.value === lastQuestion.value) input.value = ''
  clearError()
  void regenerate()
}

// A failed question goes back into the box, so it can be edited or re-sent.
watch(error, (failed) => {
  if (failed && !input.value) input.value = lastQuestion.value
})

/** Set when the failure is a daily quota: retrying won't help until it resets. */
const dailyCap = computed(() => dailyCapMessage(error.value?.message ?? ''))

/** What the reader sees for a failed request; server detail stays in the console. */
const errorMessage = computed(() => {
  const raw = error.value?.message ?? ''
  // A daily cap (server/utils/quota.ts) explains itself; the per-minute limiter doesn't.
  if (dailyCap.value) return dailyCap.value
  if (/\b429\b|too many requests/i.test(raw)) return 'Too many questions in a short time. Wait a minute, then try again.'
  if (/\b400\b|bad request/i.test(raw)) return `Questions must be 1–${MAX_QUESTION} characters.`
  // Messages written by the chat route's onError are already meant for readers.
  if (raw && raw.length < 200 && !raw.trimStart().startsWith('{') && !/<html/i.test(raw)) return raw
  return 'Please try again in a moment.'
})

/** The message of a daily-quota 429 body ({ data: { quota } }), if the error is one. */
function dailyCapMessage(raw: string): string | undefined {
  try {
    const body = JSON.parse(raw) as { message?: string, data?: { quota?: string } }
    return body.data?.quota && body.message ? body.message : undefined
  }
  catch {
    return undefined
  }
}

function onKeydown(event: KeyboardEvent) {
  // Enter while an IME is composing (Japanese, Chinese, …) confirms the candidate.
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    ask(input.value)
  }
}

type SourcesPart = Extract<ChatMessage['parts'][number], { type: 'data-sources' }>
const sourcesOf = (message: ChatMessage): SourceRef[] =>
  message.parts.find((p): p is SourcesPart => p.type === 'data-sources')?.data.sources ?? []
const textOf = (message: ChatMessage) =>
  message.parts.map(p => (p.type === 'text' ? p.text : '')).join('')
/** Answer text as shown: plain text (the prompt asks for it; stray **bold** is unwrapped). */
const answerOf = (message: ChatMessage) => stripEmphasis(textOf(message))
const refused = (message: ChatMessage) => isRefusal(textOf(message), sourcesOf(message).length)
const segmentsOf = (message: ChatMessage) => splitCitations(answerOf(message), sourcesOf(message).length)

function citedIndexes(message: ChatMessage): Set<number> {
  return new Set(segmentsOf(message).flatMap(s => (s.type === 'cite' ? [s.index] : [])))
}

/** Tooltip for a citation chip: where it points, and the start of the passage. */
function citationTooltip(source: SourceRef | undefined): string {
  if (!source) return ''
  const excerpt = source.content.length > 140 ? `${source.content.slice(0, 140).trimEnd()}…` : source.content
  return `${source.filename} · p. ${source.pageNumber ?? '?'} — “${excerpt}”`
}

// One status line for screen readers instead of announcing every streamed token.
const liveStatus = computed(() => {
  if (status.value === 'submitted') return 'Searching the documents…'
  if (status.value === 'streaming') return 'Answering…'
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

watchEffect(() => {
  // Until a citation is opened, the viewer follows the document filter (or
  // shows the first document).
  if (!viewerTarget.value && documents.value.length) {
    viewerDocumentId.value = documentId.value !== 'all' ? documentId.value : documents.value[0]!.id
  }
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
  if (next !== undefined) openCitation(activeMessage.value, next, returnFocusTo)
}

function closeViewer() {
  viewerOpen.value = false
}

function onViewerKeydown(event: KeyboardEvent) {
  if (event.key === '[') stepCitation(-1)
  else if (event.key === ']') stepCitation(1)
  else if (event.key === 'Escape') {
    viewerOpen.value = false
    returnFocusTo?.focus()
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
    // Unknown or malformed chunk id: just show the default document.
  }
})
</script>

<template>
  <div class="flex h-dvh">
    <div class="flex min-w-0 flex-1 flex-col lg:max-w-[42%] lg:border-r lg:border-default">
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
            variant="outline"
            color="neutral"
            class="justify-start"
            @click="ask(example)"
          >
            {{ example }}
          </UButton>
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
          <article
            v-for="message in messages"
            :key="message.id"
            class="flex flex-col gap-3"
          >
            <template v-if="message.role === 'user'">
              <p class="text-xs font-semibold uppercase text-muted">
                You
              </p>
              <p>{{ textOf(message) }}</p>
            </template>

            <template v-else>
              <p class="text-xs font-semibold uppercase text-muted">
                TruthBase
              </p>

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
                  <ul class="ml-4 list-disc">
                    <li
                      v-for="source in sourcesOf(message).slice(0, 3)"
                      :key="source.chunkId"
                    >
                      <button
                        type="button"
                        class="underline decoration-dotted underline-offset-2 hover:text-default"
                        :aria-label="`Open ${source.filename}, page ${source.pageNumber ?? 'unknown'} (possibly related, not a source)`"
                        @click="openRelated(source, $event.currentTarget)"
                      >
                        {{ source.filename }} · p. {{ source.pageNumber }}
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
                    v-for="(segment, i) in segmentsOf(message)"
                    :key="i"
                  >
                    <span v-if="segment.type === 'text'">{{ segment.text }}</span>
                    <UTooltip
                      v-else
                      :text="citationTooltip(sourcesOf(message)[segment.index - 1])"
                    >
                      <UButton
                        size="xs"
                        :variant="isActive(message, segment.index) ? 'solid' : 'soft'"
                        class="mx-0.5 align-baseline"
                        :aria-pressed="isActive(message, segment.index)"
                        :aria-label="`Citation ${segment.index}: ${sourcesOf(message)[segment.index - 1]?.filename}, page ${sourcesOf(message)[segment.index - 1]?.pageNumber}`"
                        @click="openCitation(message, segment.index, $event.currentTarget)"
                      >
                        {{ segment.index }}
                      </UButton>
                    </UTooltip>
                  </template>
                </p>

                <ol
                  v-if="citedIndexes(message).size"
                  class="flex flex-col gap-2"
                  aria-label="Sources"
                >
                  <li
                    v-for="source in sourcesOf(message).filter(s => citedIndexes(message).has(s.index))"
                    :key="source.chunkId"
                  >
                    <button
                      type="button"
                      class="w-full rounded-md border p-3 text-left text-sm transition-colors hover:bg-elevated"
                      :class="isActive(message, source.index) ? 'border-primary bg-primary/5' : 'border-default'"
                      @click="openCitation(message, source.index, $event.currentTarget)"
                    >
                      <span class="mb-1 block font-medium">
                        [{{ source.index }}] {{ source.filename }} · p. {{ source.pageNumber }}
                      </span>
                      <span class="line-clamp-3 text-muted">
                        {{ source.content }}
                      </span>
                    </button>
                  </li>
                </ol>
              </template>
            </template>
          </article>

          <p
            v-if="status === 'submitted'"
            class="text-sm text-muted"
          >
            Searching the documents…
          </p>
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            title="The answer didn't come through."
            :description="errorMessage"
            :actions="dailyCap ? [] : [{ label: 'Retry', color: 'error', variant: 'outline', onClick: retry }]"
          />
        </section>
      </div>

      <div class="border-t border-default px-4 py-3 sm:px-6">
        <form
          class="flex items-end gap-2"
          @submit.prevent="ask(input)"
        >
          <UTextarea
            v-model="input"
            :rows="1"
            autoresize
            class="flex-1"
            placeholder="Ask a question…"
            aria-label="Question"
            :maxlength="MAX_QUESTION"
            @keydown="onKeydown"
          />
          <UButton
            v-if="busy"
            color="neutral"
            variant="outline"
            icon="i-lucide-square"
            @click="stop()"
          >
            Stop
          </UButton>
          <UButton
            v-else
            type="submit"
            icon="i-lucide-send"
            :disabled="!input.trim()"
          >
            Ask
          </UButton>
        </form>
        <p class="mt-2 text-center text-xs text-muted">
          Answers come only from these documents.
        </p>
      </div>
    </div>

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
          :initial-scale="viewerZoom"
          @update:zoom="viewerZoom = $event"
          @prev="stepCitation(-1)"
          @next="stepCitation(1)"
        />
      </div>

      <!-- Small screens: the viewer as a full-height sheet (WIREFRAMES §6). -->
      <USlideover
        v-else
        v-model:open="viewerOpen"
        side="bottom"
        title="Document"
        :ui="{ content: 'h-dvh max-h-dvh' }"
      >
        <template #content>
          <div
            class="flex h-full min-h-0 flex-col"
            @keydown="onViewerKeydown"
          >
            <div class="flex justify-end border-b border-default bg-default p-1">
              <UButton
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                aria-label="Close document"
                @click="closeViewer"
              />
            </div>
            <PdfViewer
              ref="viewer"
              class="min-h-0 flex-1"
              :document-id="viewerDocumentId"
              :filename="viewerFilename"
              :target="viewerTarget"
              :target-nonce="targetNonce"
              :citation-label="citationLabel"
              :can-step="canStep"
              :initial-scale="viewerZoom"
              @update:zoom="viewerZoom = $event"
              @prev="stepCitation(-1)"
              @next="stepCitation(1)"
            />
          </div>
        </template>
      </USlideover>
    </ClientOnly>
  </div>
</template>
