<script setup lang="ts">
import { useChat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import { NO_ANSWER, type ChatMessage, type SourceRef } from '#shared/types/chat'
import { splitCitations } from '#shared/utils/citations'

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

const input = ref('')
const { messages, sendMessage, status, stop, error } = useChat<ChatMessage>({
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
  input.value = ''
  sendMessage({ text })
}

function onKeydown(event: KeyboardEvent) {
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
const isRefusalText = (text: string) => text.trim().replace(/[.!]+$/, '') === NO_ANSWER
/** Hide a partially streamed refusal token ("NO_ANS…") instead of flashing it. */
const looksLikeRefusalPrefix = (text: string) => text.length > 0 && NO_ANSWER.startsWith(text.trim())

function citedIndexes(message: ChatMessage): Set<number> {
  const sources = sourcesOf(message)
  return new Set(splitCitations(textOf(message), sources.length).flatMap(s => (s.type === 'cite' ? [s.index] : [])))
}

// ── viewer ─────────────────────────────────────────────────────────────────
const route = useRoute()
const isDesktop = useMediaQuery('(min-width: 1024px)')
const viewer = ref<{ focus: () => void }>()
const viewerOpen = ref(false) // small screens: the sheet
const viewerDocumentId = ref<string>()
const viewerTarget = ref<SourceRef>()
const active = ref<{ messageId: string, index: number }>()
const initialScale = Number(route.query.zoom) || undefined
const viewerFilename = computed(() => documents.value.find(d => d.id === viewerDocumentId.value)?.filename)
let returnFocusTo: HTMLElement | null = null

watchEffect(() => {
  // Before any citation is opened, show the filtered document (or the first one).
  if (!viewerDocumentId.value && documents.value.length) {
    viewerDocumentId.value = documentId.value !== 'all' ? documentId.value : documents.value[0]!.id
  }
})

/** Citation numbers of an answer in reading order (for Citation n of m / prev / next). */
function citationOrder(message: ChatMessage): number[] {
  return [...citedIndexes(message)]
}

const activeMessage = computed(() => messages.value.find(m => m.id === active.value?.messageId))
const citationLabel = computed(() => {
  if (!viewerTarget.value) return undefined
  if (!activeMessage.value || !active.value) return 'Linked citation'
  const order = citationOrder(activeMessage.value)
  return `Citation ${order.indexOf(active.value.index) + 1} of ${order.length}`
})

function openCitation(message: ChatMessage, index: number, from?: EventTarget | null) {
  const source = sourcesOf(message)[index - 1]
  if (!source) return
  returnFocusTo = from instanceof HTMLElement ? from : null
  active.value = { messageId: message.id, index }
  viewerDocumentId.value = source.documentId
  viewerTarget.value = source
  if (!isDesktop.value) viewerOpen.value = true
  nextTick(() => viewer.value?.focus())
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
    viewerDocumentId.value = source.documentId
    viewerTarget.value = source
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

        <section
          class="flex flex-col gap-6"
          aria-live="polite"
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
              <template v-if="isRefusalText(textOf(message))">
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
                      {{ source.filename }} · p. {{ source.pageNumber }}
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
                    v-for="(segment, i) in splitCitations(textOf(message), sourcesOf(message).length)"
                    :key="i"
                  >
                    <span v-if="segment.type === 'text'">{{ segment.text }}</span>
                    <UTooltip
                      v-else
                      :text="`${sourcesOf(message)[segment.index - 1]?.filename} · p. ${sourcesOf(message)[segment.index - 1]?.pageNumber}`"
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
            title="The answer service is unavailable right now."
            :description="error.message"
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
          :citation-label="citationLabel"
          :initial-scale="initialScale"
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
              :citation-label="citationLabel"
              :initial-scale="initialScale"
              @prev="stepCitation(-1)"
              @next="stepCitation(1)"
            />
          </div>
        </template>
      </USlideover>
    </ClientOnly>
  </div>
</template>
