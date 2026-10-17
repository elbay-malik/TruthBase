<script setup lang="ts">
import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist'
import type { SourceRef } from '#shared/types/chat'

// The PDF pane (Phase 5, WIREFRAMES §3). Loads a document from a short-lived
// signed URL, lays out every page at its real size, renders only pages near
// the viewport, and scrolls a citation's highlight into view. Browser only —
// mount inside <ClientOnly>.

const props = defineProps<{
  documentId?: string
  filename?: string
  /** The citation to show: its page is scrolled to and its rects highlighted. */
  target?: SourceRef
  /** e.g. "Citation 1 of 3": shown and announced with the page. */
  citationLabel?: string
  initialScale?: number
}>()

const emit = defineEmits<{ prev: [], next: [], loaded: [pageCount: number] }>()

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const scroller = ref<HTMLDivElement>()
const pages = shallowRef<PDFPageProxy[]>([])
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const scale = ref(props.initialScale ?? 1)
const fitWidth = ref(!props.initialScale)
const visible = ref(new Set<number>())
const currentPage = ref(1)
const announcement = ref('')
let loadingTask: PDFDocumentLoadingTask | undefined
let observer: IntersectionObserver | undefined

// ── loading ────────────────────────────────────────────────────────────────
let loadToken = 0

async function open(documentId: string) {
  // Switching documents mid-load (e.g. default document, then a deep link) must
  // never let the older, slower load win: every await re-checks the token.
  const token = ++loadToken
  const stale = () => token !== loadToken
  status.value = 'loading'
  const previous = loadingTask
  loadingTask = undefined
  await previous?.destroy() // PDF.js 6: no PDFDocumentProxy#destroy
  pages.value = []
  visible.value = new Set()
  try {
    const pdfjs = await loadPdfjs()
    if (stale()) return
    // Signed URLs expire (15 min): on a 4xx from Storage, sign again once.
    let task: PDFDocumentLoadingTask
    let loaded: PDFPageProxy[]
    for (let attempt = 0; ; attempt++) {
      const { url } = await $fetch(`/api/documents/${documentId}/file`)
      if (stale()) return
      task = pdfjs.getDocument({ url })
      try {
        const pdf = await task.promise
        loaded = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)))
        break
      }
      catch (error) {
        await task.destroy()
        if (stale()) return
        if (attempt > 0 || (error as Error)?.name !== 'ResponseException') throw error
      }
    }
    if (stale()) {
      await task.destroy()
      return
    }
    loadingTask = task
    pages.value = loaded.map(p => markRaw(p))
    status.value = 'ready'
    emit('loaded', pages.value.length)
    await nextTick()
    applyFitWidth()
    observePages()
    scrollToTarget('auto')
  }
  catch (error) {
    if (stale()) return
    console.error('[pdf] load failed', error)
    status.value = 'error'
  }
}

watch(() => props.documentId, (id) => {
  if (id) void open(id)
}, { immediate: true })
onBeforeUnmount(() => {
  observer?.disconnect()
  void loadingTask?.destroy()
})

// ── visibility (render only nearby pages) ──────────────────────────────────
function observePages() {
  observer?.disconnect()
  observer = new IntersectionObserver((entries) => {
    const next = new Set(visible.value)
    for (const entry of entries) {
      const n = Number((entry.target as HTMLElement).dataset.pageNumber)
      if (entry.isIntersecting) next.add(n)
      else next.delete(n)
    }
    visible.value = next
  }, { root: scroller.value, rootMargin: '150% 0px' })
  scroller.value?.querySelectorAll('.pdf-page-slot').forEach(el => observer!.observe(el))
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  const middle = el.scrollTop + el.clientHeight / 2
  for (const slot of el.querySelectorAll<HTMLElement>('.pdf-page-slot')) {
    if (slot.offsetTop + slot.offsetHeight >= middle) {
      currentPage.value = Number(slot.dataset.pageNumber)
      break
    }
  }
}

// ── zoom ───────────────────────────────────────────────────────────────────
function applyFitWidth() {
  const first = pages.value[0]
  if (!fitWidth.value || !first || !scroller.value) return
  const available = scroller.value.clientWidth - 32
  scale.value = Math.max(0.5, Math.min(3, available / first.getViewport({ scale: 1 }).width))
}

function zoom(direction: 1 | -1) {
  fitWidth.value = false
  const eps = 1e-6
  scale.value = direction > 0
    ? ZOOMS.find(z => z > scale.value + eps) ?? ZOOMS.at(-1)!
    : ZOOMS.findLast(z => z < scale.value - eps) ?? ZOOMS[0]!
}

function toggleFitWidth() {
  fitWidth.value = true
  applyFitWidth()
}

useResizeObserver(scroller, () => applyFitWidth())
// Keep the citation in view when the zoom changes.
watch(scale, () => nextTick(() => scrollToTarget('auto')))

// ── citation target ────────────────────────────────────────────────────────
const targetPage = computed(() => props.target?.highlight?.pageNumber ?? props.target?.pageNumber ?? undefined)

/** Stored rects are only valid for the page geometry they were computed on. */
const approximate = computed(() => {
  const h = props.target?.highlight
  const page = targetPage.value ? pages.value[targetPage.value - 1] : undefined
  if (!h || !page) return false
  const vp = page.getViewport({ scale: 1 })
  return Math.abs(vp.width - h.pageWidth) > 0.5 || Math.abs(vp.height - h.pageHeight) > 0.5
})

const pageRefs = ref<Record<number, { boxes: { y1: number }[] }>>({})

function scrollToTarget(behavior: ScrollBehavior = 'smooth') {
  const n = targetPage.value
  const el = scroller.value
  if (!n || !el || status.value !== 'ready') return
  const slot = el.querySelector<HTMLElement>(`.pdf-page-slot[data-page-number="${n}"]`)
  if (!slot) return
  const boxTop = pageRefs.value[n]?.boxes[0]?.y1 ?? 0
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollTo({ top: Math.max(0, slot.offsetTop + boxTop - el.clientHeight / 3), behavior: reduced ? 'auto' : behavior })
}

watch(() => props.target?.chunkId, async (chunkId, previous) => {
  await nextTick()
  // The first citation shown (e.g. a deep link) jumps straight there; moving
  // between citations scrolls smoothly so the reader keeps their bearings.
  scrollToTarget(previous ? 'smooth' : 'auto')
  if (targetPage.value) {
    announcement.value = `Page ${targetPage.value}${props.citationLabel ? `, ${props.citationLabel}` : ''}`
  }
}, { immediate: true }) // the phone sheet mounts the viewer after a citation is already chosen

defineExpose({ focus: () => scroller.value?.focus(), scale, status })
</script>

<template>
  <section
    class="flex h-full min-h-0 flex-col bg-muted"
    aria-label="Document viewer"
  >
    <header class="flex flex-wrap items-center gap-2 border-b border-default bg-default px-3 py-2 text-sm">
      <span class="min-w-0 flex-1 truncate font-medium">{{ props.filename || 'Document' }}</span>
      <span
        v-if="pages.length"
        class="tabular-nums text-muted"
      >p. {{ currentPage }} / {{ pages.length }}</span>
      <UFieldGroup size="xs">
        <UButton
          icon="i-lucide-minus"
          color="neutral"
          variant="outline"
          aria-label="Zoom out"
          :disabled="scale <= ZOOMS[0]!"
          @click="zoom(-1)"
        />
        <UButton
          color="neutral"
          variant="outline"
          class="w-14 justify-center tabular-nums"
          :aria-label="`Zoom ${Math.round(scale * 100)} percent, fit to width`"
          @click="toggleFitWidth"
        >
          {{ Math.round(scale * 100) }}%
        </UButton>
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          aria-label="Zoom in"
          :disabled="scale >= ZOOMS.at(-1)!"
          @click="zoom(1)"
        />
      </UFieldGroup>
    </header>

    <div
      v-if="target && citationLabel"
      class="flex items-center gap-2 border-b border-default bg-default px-3 py-1.5 text-xs"
    >
      <span class="flex-1 text-muted">{{ citationLabel }} · p. {{ targetPage }}</span>
      <UBadge
        v-if="approximate"
        color="warning"
        variant="subtle"
        size="sm"
      >
        Approximate highlight
      </UBadge>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-chevron-left"
        aria-label="Previous citation"
        @click="emit('prev')"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-chevron-right"
        aria-label="Next citation"
        @click="emit('next')"
      />
    </div>

    <div
      ref="scroller"
      class="relative min-h-0 flex-1 overflow-auto outline-none"
      tabindex="-1"
      @scroll.passive="onScroll"
    >
      <p
        v-if="status === 'loading'"
        class="p-6 text-sm text-muted"
      >
        Loading document…
      </p>
      <UAlert
        v-else-if="status === 'error'"
        class="m-4"
        color="error"
        variant="subtle"
        title="Couldn't load this document."
        description="Citations still list the page and the quoted text."
      />
      <div class="flex flex-col items-center gap-4 p-4">
        <PdfPage
          v-for="page in pages"
          :key="page.pageNumber"
          :ref="(el) => { if (el) pageRefs[page.pageNumber] = el as unknown as { boxes: { y1: number }[] } }"
          :page="page"
          :scale="scale"
          :visible="visible.has(page.pageNumber) || page.pageNumber === targetPage"
          :rects="page.pageNumber === targetPage && !approximate ? target?.highlight?.rects : undefined"
          :fallback-range="page.pageNumber === targetPage && approximate && target?.highlight ? { start: target.highlight.startOffset, end: target.highlight.endOffset } : undefined"
          :flash-key="target?.chunkId"
        />
      </div>
    </div>

    <p
      class="sr-only"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
  </section>
</template>
