<script setup lang="ts">
import type { PDFPageProxy } from 'pdfjs-dist'
import type { SourceRef } from '#shared/types/chat'

// The PDF pane (Phase 5, WIREFRAMES §3). Loads a document from a short-lived
// signed URL (cached across mounts, app/utils/pdf-documents.ts), lays out every
// page at its real size, renders only pages near the viewport, and scrolls a
// citation's highlight into view. Browser only — mount inside <ClientOnly>.

const props = defineProps<{
  documentId?: string
  filename?: string
  /** The citation to show: its page is scrolled to and its rects highlighted. */
  target?: SourceRef
  /** Bumped on every citation click, so re-clicking the active one scrolls back to it. */
  targetNonce?: number
  /** e.g. "Citation 1 of 3": shown and announced with the page. */
  citationLabel?: string
  /** Show previous / next citation buttons (only when an answer is active). */
  canStep?: boolean
  initialScale?: number
}>()

const emit = defineEmits<{
  'prev': []
  'next': []
  'loaded': [pageCount: number]
  /** A manual zoom (undefined = fit width), so a remounted viewer can restore it. */
  'update:zoom': [scale: number | undefined]
}>()

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const scroller = ref<HTMLDivElement>()
const pages = shallowRef<PDFPageProxy[]>([])
const loadedDocumentId = ref<string>()
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const scale = ref(props.initialScale ?? 1)
const fitWidth = ref(!props.initialScale)
const visible = ref(new Set<number>())
const currentPage = ref(1)
const announcement = ref('')
let observer: IntersectionObserver | undefined

// ── loading ────────────────────────────────────────────────────────────────
let loadToken = 0

async function open(documentId: string) {
  // Switching documents mid-load (e.g. default document, then a deep link) must
  // never let the older, slower load win: every await re-checks the token.
  const token = ++loadToken
  const stale = () => token !== loadToken
  status.value = 'loading'
  pages.value = []
  loadedDocumentId.value = undefined
  visible.value = new Set()
  currentPage.value = 1
  scroller.value?.scrollTo({ top: 0, left: 0 })
  try {
    const doc = await loadDocument(documentId)
    if (stale()) return
    pages.value = doc.pages
    loadedDocumentId.value = documentId
    status.value = 'ready'
    emit('loaded', pages.value.length)
    await nextTick()
    const before = scale.value
    applyFitWidth()
    // A scale change re-lays out the pages: scroll once that has happened.
    if (scale.value !== before) pendingAnchor = 'target'
    else scrollToTarget('auto')
    observePages()
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
  loadToken++ // a load still in flight must not touch this instance
  observer?.disconnect()
  // The document itself stays open in the cache for the next mount.
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

const slotOf = (n: number) => scroller.value?.querySelector<HTMLElement>(`.pdf-page-slot[data-page-number="${n}"]`) ?? undefined

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
  emit('update:zoom', scale.value)
}

function toggleFitWidth() {
  fitWidth.value = true
  applyFitWidth()
  emit('update:zoom', undefined)
}

useResizeObserver(scroller, () => applyFitWidth())

// Zoom and resize keep the reader where they were: the point at the middle of
// the pane (page + fraction of it) stays at the middle. Captured before the
// DOM re-lays out (pre flush), restored after (post flush). Right after a
// load, the citation is the place to be instead.
type Anchor = { page: number, y: number, x: number }
let pendingAnchor: Anchor | 'target' | undefined

function readingAnchor(): Anchor | undefined {
  const el = scroller.value
  const slot = slotOf(currentPage.value)
  if (!el || !slot || !slot.offsetHeight) return undefined
  return {
    page: currentPage.value,
    y: (el.scrollTop + el.clientHeight / 2 - slot.offsetTop) / slot.offsetHeight,
    x: el.scrollWidth > el.clientWidth ? (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth : 0.5,
  }
}

watch(scale, () => {
  pendingAnchor ??= readingAnchor()
}, { flush: 'pre' })
watch(scale, () => {
  const anchor = pendingAnchor
  pendingAnchor = undefined
  const el = scroller.value
  if (anchor === 'target') return scrollToTarget('auto')
  const slot = anchor && slotOf(anchor.page)
  if (!el || !anchor || !slot) return
  el.scrollTo({
    top: slot.offsetTop + anchor.y * slot.offsetHeight - el.clientHeight / 2,
    left: anchor.x * el.scrollWidth - el.clientWidth / 2,
  })
}, { flush: 'post' })

// ── citation target ────────────────────────────────────────────────────────
const targetPage = computed(() => props.target?.highlight?.pageNumber ?? props.target?.pageNumber ?? undefined)

/** Stored rects are only valid for the page geometry they were computed on. */
const geometryStale = computed(() => {
  const h = props.target?.highlight
  const page = targetPage.value ? pages.value[targetPage.value - 1] : undefined
  if (!h || !page) return false
  const vp = page.getViewport({ scale: 1 })
  return Math.abs(vp.width - h.pageWidth) > 0.5 || Math.abs(vp.height - h.pageHeight) > 0.5
})
/** Set by the target page once rendered: its text no longer matches the stored offsets. */
const textStale = ref(false)
/** …and the cited text wasn't found anywhere on the page. */
const notLocated = ref(false)
const approximate = computed(() => !!props.target?.highlight && (geometryStale.value || textStale.value))
const approximateLabel = computed(() => (notLocated.value ? 'Passage not located on this page' : 'Approximate highlight'))

/** One object per target, so the page's watchers don't re-run on every render. */
const targetRange = computed(() => {
  const h = props.target?.highlight
  return h ? { start: h.startOffset, end: h.endOffset } : undefined
})

const pageRefs = ref<Record<number, { boxes: { y1: number }[] }>>({})

function scrollToTarget(behavior: ScrollBehavior = 'smooth') {
  const n = targetPage.value
  const el = scroller.value
  if (!n || !el || status.value !== 'ready') return
  const slot = slotOf(n)
  if (!slot) return
  const boxTop = pageRefs.value[n]?.boxes[0]?.y1 ?? 0
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollTo({ top: Math.max(0, slot.offsetTop + boxTop - el.clientHeight / 3), behavior: reduced ? 'auto' : behavior })
}

/** Whether this opened citation already scrolled to its fallback boxes (declared before the immediate watcher uses it). */
let fallbackScrolled = false

watch(() => [props.target?.chunkId, props.targetNonce] as const, async (_current, previous) => {
  // Every open re-verifies (the target page re-emits once rendered).
  textStale.value = false
  notLocated.value = false
  fallbackScrolled = false
  // A failed load is retried when a citation in that document is opened again.
  if (status.value === 'error' && props.documentId) void open(props.documentId)
  await nextTick()
  // The first citation shown (e.g. a deep link) jumps straight there; moving
  // between citations, or re-clicking one, scrolls smoothly.
  scrollToTarget(previous?.[0] ? 'smooth' : 'auto')
  if (targetPage.value) {
    // Clear first: re-clicking the same citation yields the same text, and an
    // unchanged live region is not announced again.
    announcement.value = ''
    await nextTick()
    announcement.value = `Page ${targetPage.value}${props.citationLabel ? `, ${props.citationLabel}` : ''}`
  }
}, { immediate: true }) // the phone sheet mounts the viewer after a citation is already chosen

function onTargetVerified(result: { ok: boolean, located: boolean }) {
  textStale.value = !result.ok
  notLocated.value = !result.located
}

// Fallback boxes arrive after the page renders, possibly elsewhere on the page
// than the stored rects: scroll to them once per opened citation.
function onFallbackReady() {
  if (fallbackScrolled) return
  fallbackScrolled = true
  nextTick(() => scrollToTarget('auto'))
}

function retryLoad() {
  if (props.documentId) void open(props.documentId)
}

defineExpose({ focus: () => scroller.value?.focus(), scale, status, documentId: loadedDocumentId })
</script>

<template>
  <section
    class="flex h-full min-h-0 flex-col bg-muted"
    aria-label="Document viewer"
    :data-document-id="loadedDocumentId"
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
        {{ approximateLabel }}
      </UBadge>
      <UButton
        v-if="canStep"
        size="xs"
        variant="ghost"
        icon="i-lucide-chevron-left"
        aria-label="Previous citation"
        @click="emit('prev')"
      />
      <UButton
        v-if="canStep"
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
        :actions="[{ label: 'Retry', color: 'error', variant: 'outline', onClick: retryLoad }]"
      />
      <!-- w-max + min-w-full: a page wider than the pane overflows to the right
           only (centring would push its left part out of scroll reach). -->
      <div class="flex w-max min-w-full flex-col items-center gap-4 p-4">
        <PdfPage
          v-for="page in pages"
          :key="page.pageNumber"
          :ref="(el) => { if (el) pageRefs[page.pageNumber] = el as unknown as { boxes: { y1: number }[] } }"
          :page="page"
          :scale="scale"
          :visible="visible.has(page.pageNumber) || page.pageNumber === targetPage"
          :rects="page.pageNumber === targetPage ? target?.highlight?.rects : undefined"
          :range="page.pageNumber === targetPage ? targetRange : undefined"
          :expected-text="page.pageNumber === targetPage ? target?.content : undefined"
          :geometry-stale="page.pageNumber === targetPage && geometryStale"
          :flash-key="`${target?.chunkId}-${targetNonce ?? 0}`"
          @verified="onTargetVerified"
          @fallback-ready="onFallbackReady"
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
