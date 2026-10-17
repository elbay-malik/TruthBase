<script setup lang="ts">
import { useChat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import { NO_ANSWER, type ChatMessage, type SourceRef } from '#shared/types/chat'
import { splitCitations } from '#shared/utils/citations'

// Phase 4 chat: grounded answers with citation chips (docs/WIREFRAMES.md §2–4).
// Phase 5 puts the PDF viewer beside it; until then a chip scrolls to its
// source card below the answer.

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

const activeSource = ref<string>()
function focusSource(messageId: string, index: number) {
  const id = `src-${messageId}-${index}`
  activeSource.value = id
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
</script>

<template>
  <UContainer class="flex min-h-screen max-w-3xl flex-col gap-6 py-8">
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
                    variant="soft"
                    class="mx-0.5 align-baseline"
                    :aria-label="`Citation ${segment.index}: ${sourcesOf(message)[segment.index - 1]?.filename}, page ${sourcesOf(message)[segment.index - 1]?.pageNumber}`"
                    @click="focusSource(message.id, segment.index)"
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
                :id="`src-${message.id}-${source.index}`"
                :key="source.chunkId"
                class="rounded-md border p-3 text-sm transition-colors"
                :class="activeSource === `src-${message.id}-${source.index}` ? 'border-primary bg-primary/5' : 'border-default'"
              >
                <p class="mb-1 font-medium">
                  [{{ source.index }}] {{ source.filename }} · p. {{ source.pageNumber }}
                </p>
                <p class="line-clamp-3 text-muted">
                  {{ source.content }}
                </p>
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

    <form
      class="sticky bottom-4 mt-auto flex items-end gap-2"
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
    <p class="text-center text-xs text-muted">
      Answers come only from these documents.
    </p>
  </UContainer>
</template>
