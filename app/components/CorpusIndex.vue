<script setup lang="ts">
import { documentInfo, HIGHLIGHT_CHECKS, PROJECT_LINKS } from '~/utils/corpus'

// The first screen's account of what TruthBase answers from and how its
// highlight is checked (DESIGN.md "Corpus Index"). Desktop: the empty viewer
// pane, as a catalogue of the four PDFs. Phones (`compact`): the same, in
// short rows under the example questions. A row opens that document at page 1.

const props = defineProps<{
  documents: { id: string, filename: string, pageCount: number }[]
  compact?: boolean
}>()

const emit = defineEmits<{
  /** A row was chosen: open this document in the viewer, from page 1. */
  open: [documentId: string, from: HTMLElement | null]
}>()

const rows = computed(() => props.documents.map(d => ({ ...d, info: documentInfo(d.filename) })))
const heading = computed(() => (props.compact ? 'h2' : 'h3'))
const id = useId()

const links = [
  { label: 'Source code', to: PROJECT_LINKS.repo },
  { label: 'README', to: PROJECT_LINKS.readme },
  { label: 'Architecture decisions', to: PROJECT_LINKS.adrs },
  { label: 'Evals', to: PROJECT_LINKS.evals },
]

const pages = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`
</script>

<template>
  <div
    class="flex flex-col"
    :class="compact ? 'gap-6' : 'mx-auto w-full max-w-2xl gap-10 px-8 pt-10 pb-12'"
  >
    <section
      v-if="rows.length"
      class="flex flex-col gap-2"
      :aria-labelledby="`${id}-documents`"
    >
      <component
        :is="heading"
        :id="`${id}-documents`"
        class="text-xs font-semibold tracking-wider uppercase text-muted"
      >
        The documents
      </component>
      <p
        v-if="!compact"
        class="text-sm text-muted"
      >
        Every answer comes from these {{ rows.length }} PDFs. Open one to read it from the first page.
      </p>
      <ul
        class="flex flex-col divide-y divide-default border-y border-default"
        :class="{ 'mt-2': !compact }"
      >
        <li
          v-for="row in rows"
          :key="row.id"
        >
          <!-- Compact: one line per document, short title and page count. -->
          <button
            v-if="compact"
            type="button"
            class="flex min-h-11 w-full cursor-pointer items-baseline gap-3 px-1 py-2.5 text-left transition-colors hover:bg-muted [--focus-ring-offset:-2px]"
            :aria-label="`Open ${row.info.title}, ${pages(row.pageCount)}`"
            @click="emit('open', row.id, $event.currentTarget as HTMLElement)"
          >
            <span class="min-w-0 flex-1 truncate font-serif text-[1.0625rem] text-highlighted">{{ row.info.short }}</span>
            <span class="shrink-0 text-xs tabular-nums text-muted">{{ pages(row.pageCount) }}</span>
          </button>
          <button
            v-else
            type="button"
            class="grid w-full cursor-pointer grid-cols-[1fr_auto] items-baseline gap-x-8 gap-y-1 px-3 py-4 text-left transition-colors hover:bg-default [--focus-ring-offset:-2px]"
            :aria-label="`Open ${row.info.title}, ${pages(row.pageCount)}`"
            @click="emit('open', row.id, $event.currentTarget as HTMLElement)"
          >
            <span class="font-serif text-[1.0625rem] leading-snug text-balance text-highlighted">{{ row.info.title }}</span>
            <span class="text-sm tabular-nums text-muted">{{ pages(row.pageCount) }}</span>
            <span class="col-span-2 text-sm text-muted">
              <template v-if="row.info.source">{{ row.info.source }} · </template>{{ row.filename }}
            </span>
          </button>
        </li>
      </ul>
    </section>

    <section
      class="flex flex-col gap-2"
      :aria-labelledby="`${id}-checks`"
    >
      <component
        :is="heading"
        :id="`${id}-checks`"
        class="text-xs font-semibold tracking-wider uppercase text-muted"
      >
        How the highlight is checked
      </component>
      <!-- Inline padding: the links reach the 24 px target (WCAG 2.5.8) without spacing the lines. -->
      <p class="max-w-prose text-sm text-toned">
        Highlight placement: <strong class="font-semibold tabular-nums text-highlighted">{{ HIGHLIGHT_CHECKS.passed }}/{{ HIGHLIGHT_CHECKS.total }}</strong>
        checks pass ({{ HIGHLIGHT_CHECKS.spans }} golden passages at {{ HIGHLIGHT_CHECKS.zooms }} zoom, in a real browser).
        <a
          :href="PROJECT_LINKS.highlightAccuracy"
          target="_blank"
          rel="noopener"
          class="py-1 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >Method<span class="sr-only"> (opens in a new tab)</span></a>
        ·
        <a
          :href="PROJECT_LINKS.limitations"
          target="_blank"
          rel="noopener"
          class="py-1 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >Limitations<span class="sr-only"> (opens in a new tab)</span></a>
      </p>
    </section>

    <nav
      aria-label="Project"
      class="text-sm"
    >
      <ul class="flex flex-wrap gap-x-5 gap-y-2">
        <li
          v-for="link in links"
          :key="link.label"
        >
          <a
            :href="link.to"
            target="_blank"
            rel="noopener"
            class="inline-flex min-h-6 items-center gap-1 text-muted underline decoration-accented underline-offset-4 transition-colors hover:text-highlighted hover:decoration-current"
          >
            {{ link.label }}
            <UIcon
              name="i-lucide-arrow-up-right"
              class="size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span class="sr-only">(opens in a new tab)</span>
          </a>
        </li>
      </ul>
    </nav>
  </div>
</template>
