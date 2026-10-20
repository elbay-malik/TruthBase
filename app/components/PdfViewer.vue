<script setup lang="ts">
import type { PDFPageProxy } from 'pdfjs-dist'
import type { SourceRef } from '#shared/types/chat'
import type { Box } from '~/utils/pdf-highlight'

// The PDF pane (Phase 5, WIREFRAMES §3). Loads a document from a short-lived
// signed URL (cached across mounts, app/utils/pdf-documents.ts), lays out every
// page at its real size, renders only pages near the viewport, and scrolls a
// citation's highlight into view. Browser only — mount inside <ClientOnly>.
// `layout="sheet"` is the phone variant (WIREFRAMES §6): close button in the
// header row, citation stepper in a bottom bar.

const props = defineProps<{
  /** No document: an empty state, and PDF.js is not loaded. */
  documentId?: string
  filename?: string
  /** The documents the header switcher offers (none: the filename is plain text). */
  documents?: { id: string, filename: string }[]
  /** The citation to show: its page is scrolled to and its rects highlighted. */
  target?: SourceRef
  /** Bumped on every citation click, so re-clicking the active one scrolls back to it. */
  targetNonce?: number
  /** e.g. "Citation 1 of 3": shown and announced with the page. */
  citationLabel?: string
  /** Show previous / next citation buttons (only when an answer is active). */
  canStep?: boolean
  initialScale?: number
  /** Default 'pane'. */
  layout?: 'pane' | 'sheet'
}>()

const emit = defineEmits<{
  'prev': []
  'next': []
  'loaded': [pageCount: number]
  /** A manual zoom (undefined = fit width), so a remounted viewer can restore it. */
  'update:zoom': [scale: number | undefined]
  /** Chosen in the header switcher; the parent sets `documentId` (and clears `target`). */
  'select-document': [documentId: string]
  /** The sheet's close button. */
  'close': []
}>()

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const EPS = 1e-6
const scroller = ref<HTMLDivElement>()
const pages = shallowRef<PDFPageProxy[]>([])
const loadedDocumentId = ref<string>()
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const scale = ref(props.initialScale ?? 1)
const fitWidth = ref(!props.initialScale)
const visible = ref(new Set<number>())
const currentPage = ref(1)
const announcement = ref('')
/** Shows the focus ring on focus handed over from code (a citation chip), not only :focus-visible. */
const focusRing = ref(false)
let observer: IntersectionObserver | undefined
/** A page jumped to with the page buttons: it stays current while the scroller rests there. */
let pinned: { page: number, top: number } | undefined

const sheet = computed(() => props.layout === 'sheet')
const ready = computed(() => status.value === 'ready')
const documentItems = computed(() => (props.documents ?? []).map(d => ({ label: d.filename, value: d.id })))

async function announce(text: string) {
  // Clear first: an unchanged live region is not announced again.
  announcement.value = ''
  await nextTick()
  announcement.value = text
}

// ── loading ────────────────────────────────────────────────────────────────
let loadToken = 0

function reset() {
  loadToken++
  observer?.disconnect()
  status.value = 'idle'
  pages.value = []
  loadedDocumentId.value = undefined
  visible.value = new Set()
  currentPage.value = 1
  pinned = undefined
}

async function open(documentId: string) {
  // Switching documents mid-load (e.g. default document, then a deep link) must
  // never let the older, slower load win: every await re-checks the token.
  reset()
  const token = loadToken
  const stale = () => token !== loadToken
  status.value = 'loading'
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
    if (props.target?.documentId === documentId) void announceTarget()
  }
  catch (error) {
    if (stale()) return
    console.error('[pdf] load failed', error)
    status.value = 'error'
    void announce(`Couldn't load ${props.filename ?? 'this document'}. Retry available.`)
  }
}

watch(() => props.documentId, (id) => {
  if (id) void open(id)
  else reset()
}, { immediate: true })
onBeforeUnmount(() => {
  loadToken++ // a load still in flight must not touch this instance
  observer?.disconnect()
  // The document itself stays open in the cache for the next mount.
})

function onSelectDocument(id: unknown) {
  if (typeof id === 'string' && id !== props.documentId) emit('select-document', id)
}

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

/** Smooth only over short distances: a long animation delays the highlight (its flash marks the spot). */
function behaviorFor(distance: number): ScrollBehavior {
  const el = scroller.value
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return !reduced && el && distance < el.clientHeight ? 'smooth' : 'auto'
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  if (pinned && Math.abs(el.scrollTop - pinned.top) < 2) {
    currentPage.value = pinned.page
    return
  }
  const middle = el.scrollTop + el.clientHeight / 2
  for (const slot of el.querySelectorAll<HTMLElement>('.pdf-page-slot')) {
    if (slot.offsetTop + slot.offsetHeight >= middle) {
      currentPage.value = Number(slot.dataset.pageNumber)
      break
    }
  }
}

// ── page navigation ────────────────────────────────────────────────────────
const pageDraft = ref('1')
const pageInputFocused = ref(false)
watch(currentPage, (n) => {
  if (!pageInputFocused.value) pageDraft.value = String(n)
}, { immediate: true })

function goToPage(n: number) {
  const el = scroller.value
  const slot = slotOf(n)
  if (!el || !slot) return
  // The page's top edge just below the 16 px gap above it.
  const top = Math.max(0, Math.min(slot.offsetTop - 16, el.scrollHeight - el.clientHeight))
  pinned = { page: n, top }
  currentPage.value = n
  el.scrollTo({ top, behavior: behaviorFor(Math.abs(top - el.scrollTop)) })
}

function stepPage(delta: 1 | -1) {
  if (!ready.value) return
  const n = currentPage.value + delta
  if (n < 1 || n > pages.value.length) return
  goToPage(n)
  void announce(`Page ${n} of ${pages.value.length}`)
}

function commitPageDraft() {
  const n = Number.parseInt(pageDraft.value, 10)
  if (ready.value && Number.isFinite(n)) {
    const page = Math.min(pages.value.length, Math.max(1, n))
    goToPage(page)
    void announce(`Page ${page} of ${pages.value.length}`)
  }
  pageDraft.value = String(currentPage.value)
}

function onPageInputBlur() {
  pageInputFocused.value = false
  pageDraft.value = String(currentPage.value)
}

// ── zoom ───────────────────────────────────────────────────────────────────
const zoomPercent = computed(() => Math.round(scale.value * 100))
const canZoomOut = computed(() => ready.value && scale.value > ZOOMS[0]! + EPS)
const canZoomIn = computed(() => ready.value && scale.value < ZOOMS.at(-1)! - EPS)

function applyFitWidth() {
  const first = pages.value[0]
  if (!fitWidth.value || !first || !scroller.value) return
  const available = scroller.value.clientWidth - 32
  scale.value = Math.max(0.5, Math.min(3, available / first.getViewport({ scale: 1 }).width))
}

// At a limit the button stays enabled (aria-disabled) so it keeps focus; the guards make it a no-op.
function zoom(direction: 1 | -1) {
  if (!ready.value) return
  const next = direction > 0
    ? ZOOMS.find(z => z > scale.value + EPS)
    : ZOOMS.findLast(z => z < scale.value - EPS)
  if (next === undefined) return
  fitWidth.value = false
  scale.value = next
  emit('update:zoom', scale.value)
  void announce(`Zoom ${zoomPercent.value}%`)
}

function toggleFitWidth() {
  if (!ready.value) return
  fitWidth.value = true
  applyFitWidth()
  emit('update:zoom', undefined)
  void announce(`Fit to width, zoom ${zoomPercent.value}%`)
}

// The scroller reserves its scrollbar gutter: otherwise a scrollbar that appears
// narrows it, fit width shrinks the pages, the scrollbar goes, and so on.
useResizeObserver(scroller, () => applyFitWidth())

// Zoom and resize keep the reader where they were: the point at the middle of
// the pane (page + fraction of it) stays at the middle — or, when the citation
// is in view, its highlight's centre. Captured before the DOM re-lays out (pre
// flush), restored after (post flush). Right after a load, the citation is the
// place to be instead.
type Anchor = { page: number, y: number, x: number }
let pendingAnchor: Anchor | 'target' | undefined

function readingAnchor(): Anchor | undefined {
  const el = scroller.value
  const slot = slotOf(currentPage.value)
  if (!el || !slot || !slot.offsetHeight) return undefined
  return {
    page: currentPage.value,
    y: (el.scrollTop + el.clientHeight / 2 - slot.offsetTop) / slot.offsetHeight,
    x: el.scrollWidth > el.clientWidth ? (el.scrollLeft + el.clientWidth / 2 - slot.offsetLeft) / slot.offsetWidth : 0.5,
  }
}

function highlightAnchor(): Anchor | undefined {
  const n = targetPage.value
  const el = scroller.value
  const slot = n ? slotOf(n) : undefined
  const boxes = n ? pageRefs.value[n]?.boxes : undefined
  if (!n || !el || !slot || !boxes?.length || !slot.offsetHeight || !slot.offsetWidth) return undefined
  const x1 = Math.min(...boxes.map(b => b.x1))
  const x2 = Math.max(...boxes.map(b => b.x2))
  const y1 = Math.min(...boxes.map(b => b.y1))
  const y2 = Math.max(...boxes.map(b => b.y2))
  const inView = slot.offsetTop + y2 > el.scrollTop && slot.offsetTop + y1 < el.scrollTop + el.clientHeight
    && slot.offsetLeft + x2 > el.scrollLeft && slot.offsetLeft + x1 < el.scrollLeft + el.clientWidth
  return inView ? { page: n, y: (y1 + y2) / 2 / slot.offsetHeight, x: (x1 + x2) / 2 / slot.offsetWidth } : undefined
}

watch(scale, () => {
  pinned = undefined
  pendingAnchor ??= highlightAnchor() ?? readingAnchor()
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
    left: slot.offsetLeft + anchor.x * slot.offsetWidth - el.clientWidth / 2,
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

/** The cited text, shown while the PDF can't be: the error copy promises it. */
const quote = computed(() => {
  const text = props.target?.content.replace(/\s+/g, ' ').trim()
  return text && text.length > 280 ? `${text.slice(0, 280)}…` : text
})

const pageRefs = ref<Record<number, { boxes: Box[] }>>({})

function scrollToTarget(behavior: ScrollBehavior = 'smooth') {
  const n = targetPage.value
  const el = scroller.value
  if (!n || !el || status.value !== 'ready') return
  const slot = slotOf(n)
  if (!slot) return
  const boxTop = pageRefs.value[n]?.boxes[0]?.y1 ?? 0
  const top = Math.max(0, slot.offsetTop + boxTop - el.clientHeight / 3)
  el.scrollTo({ top, behavior: behavior === 'smooth' ? behaviorFor(Math.abs(top - el.scrollTop)) : 'auto' })
}

/** "Page 28, Citation 1 of 3": only once the page is really shown (never over a load error). */
async function announceTarget() {
  if (status.value !== 'ready' || !targetPage.value) return
  await announce(`Page ${targetPage.value}${props.citationLabel ? `, ${props.citationLabel}` : ''}`)
}

/** Whether this opened citation already scrolled to its fallback boxes (declared before the immediate watcher uses it). */
let fallbackScrolled = false

watch(() => [props.target?.chunkId, props.targetNonce] as const, async (current, previous) => {
  // A new citation re-verifies (the target page re-emits once rendered).
  // Re-clicking the active one keeps its flags: nothing re-renders to re-emit them.
  if (current[0] !== previous?.[0]) {
    textStale.value = false
    notLocated.value = false
  }
  fallbackScrolled = false
  pinned = undefined
  // A failed load is retried when a citation in that document is opened again.
  if (status.value === 'error' && props.documentId) void open(props.documentId)
  await nextTick()
  // The first citation shown (e.g. a deep link) jumps straight there; moving
  // between citations, or re-clicking one, scrolls smoothly when it is close.
  scrollToTarget(previous?.[0] ? 'smooth' : 'auto')
  // Still loading: open() announces once the document is ready.
  await announceTarget()
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

function focusScroller() {
  if (!scroller.value) return
  focusRing.value = true
  scroller.value.focus({ preventScroll: true })
}

function retryLoad() {
  if (!props.documentId) return
  void open(props.documentId)
  // The alert (and its Retry) unmounts now: keep focus in the viewer.
  focusScroller()
}

defineExpose({ focus: focusScroller, scale, status, documentId: loadedDocumentId })
</script>

<template>
  <section
    class="flex h-full min-h-0 flex-col bg-muted"
    aria-label="Document viewer"
    :data-document-id="loadedDocumentId"
  >
    <header
      class="flex items-center border-b border-default bg-default text-sm"
      :class="sheet ? 'gap-1 px-1 py-1' : 'flex-wrap gap-x-2 gap-y-1 px-3 py-2'"
    >
      <UButton
        v-if="sheet"
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="lg"
        class="size-11 shrink-0 justify-center"
        aria-label="Close document"
        @click="emit('close')"
      />
      <h2 class="flex min-w-0 flex-1 basis-32 font-medium">
        <USelect
          v-if="documentItems.length"
          :model-value="documentId"
          :items="documentItems"
          variant="ghost"
          :size="sheet ? 'md' : 'sm'"
          placeholder="Choose a document"
          aria-label="Document"
          class="max-w-full min-w-0"
          :class="sheet ? 'min-h-11' : '-ml-2'"
          :ui="{ value: 'font-medium', placeholder: 'text-muted' }"
          @update:model-value="onSelectDocument"
        />
        <span
          v-else
          class="truncate"
          :class="{ 'px-2': sheet }"
        >{{ filename || 'Document' }}</span>
      </h2>

      <template v-if="ready">
        <span
          v-if="sheet"
          class="shrink-0 px-1 tabular-nums text-muted"
        >{{ currentPage }} / {{ pages.length }}</span>
        <div
          v-else
          class="flex shrink-0 items-center gap-1 tabular-nums text-muted"
        >
          <UButton
            icon="i-lucide-chevron-left"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="Previous page"
            :aria-disabled="currentPage <= 1 || undefined"
            @click="stepPage(-1)"
          />
          <UInput
            v-model="pageDraft"
            size="sm"
            inputmode="numeric"
            autocomplete="off"
            :aria-label="`Page number, 1 to ${pages.length}`"
            class="w-11"
            :ui="{ base: 'px-1 text-center tabular-nums' }"
            @focus="pageInputFocused = true"
            @blur="onPageInputBlur"
            @keydown.enter.prevent="commitPageDraft"
          />
          <span aria-hidden="true">/ {{ pages.length }}</span>
          <UButton
            icon="i-lucide-chevron-right"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="Next page"
            :aria-disabled="currentPage >= pages.length || undefined"
            @click="stepPage(1)"
          />
        </div>
      </template>

      <UFieldGroup
        v-if="documentId"
        :size="sheet ? 'lg' : 'sm'"
        class="shrink-0"
      >
        <UButton
          icon="i-lucide-minus"
          color="neutral"
          variant="outline"
          aria-label="Zoom out"
          :class="{ 'size-11 justify-center': sheet }"
          :aria-disabled="!canZoomOut || undefined"
          @click="zoom(-1)"
        />
        <UButton
          color="neutral"
          variant="outline"
          class="w-14 justify-center tabular-nums"
          :class="{ 'h-11': sheet }"
          :aria-label="`Fit to width (zoom ${zoomPercent}%)`"
          :aria-pressed="fitWidth"
          :aria-disabled="!ready || undefined"
          @click="toggleFitWidth"
        >
          {{ fitWidth ? 'Fit' : `${zoomPercent}%` }}
        </UButton>
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          aria-label="Zoom in"
          :class="{ 'size-11 justify-center': sheet }"
          :aria-disabled="!canZoomIn || undefined"
          @click="zoom(1)"
        />
      </UFieldGroup>
    </header>

    <div
      v-if="!sheet && target && citationLabel"
      class="flex items-center gap-2 border-b border-default bg-default px-3 py-1.5 text-xs"
    >
      <span class="flex-1 text-muted">{{ citationLabel }} · p. {{ targetPage ?? '?' }}</span>
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
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-chevron-left"
        aria-label="Previous citation"
        @click="emit('prev')"
      />
      <UButton
        v-if="canStep"
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-chevron-right"
        aria-label="Next citation"
        @click="emit('next')"
      />
    </div>

    <div
      v-if="!documentId"
      class="grid min-h-0 flex-1 place-items-center p-6"
    >
      <div class="flex max-w-xs flex-col items-center gap-3 text-center text-muted">
        <UIcon
          name="i-lucide-text-search"
          class="size-8 text-dimmed"
        />
        <p class="text-sm">
          Click a citation to see the exact passage here.
        </p>
      </div>
    </div>
    <div
      v-else
      ref="scroller"
      class="relative min-h-0 flex-1 overflow-auto outline-none [scrollbar-gutter:stable] focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary data-focus-ring:focus:outline-solid data-focus-ring:focus:outline-2 data-focus-ring:focus:-outline-offset-2 data-focus-ring:focus:outline-primary"
      tabindex="0"
      role="region"
      :aria-label="`${filename ?? 'Document'}, PDF pages`"
      :data-focus-ring="focusRing || undefined"
      @blur="focusRing = false"
      @scroll.passive="onScroll"
    >
      <p
        v-if="status === 'loading'"
        class="p-6 text-sm text-muted"
      >
        Loading document…
      </p>
      <div
        v-else-if="status === 'error'"
        class="flex flex-col gap-3 p-4"
      >
        <UAlert
          color="error"
          variant="subtle"
          title="Couldn't load this document."
          description="Citations still list the page and the quoted text."
          :ui="{ description: 'opacity-100' }"
          :actions="[{ label: 'Retry', color: 'error', variant: 'outline', onClick: retryLoad }]"
        />
        <figure
          v-if="quote"
          class="rounded-md border border-default bg-default p-3 text-sm"
        >
          <figcaption class="mb-1 text-xs text-muted">
            {{ citationLabel ?? 'Cited passage' }} · p. {{ targetPage ?? '?' }}
          </figcaption>
          <blockquote class="text-toned">
            {{ quote }}
          </blockquote>
        </figure>
      </div>
      <!-- w-max + min-w-full: a page wider than the pane overflows to the right
           only (centring would push its left part out of scroll reach). -->
      <div class="flex w-max min-w-full flex-col items-center gap-4 p-4">
        <PdfPage
          v-for="page in pages"
          :key="page.pageNumber"
          :ref="(el) => { if (el) pageRefs[page.pageNumber] = el as unknown as { boxes: Box[] } }"
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

    <div
      v-if="sheet && target && citationLabel"
      class="flex items-center gap-2 border-t border-default bg-default px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
    >
      <UButton
        v-if="canStep"
        label="Prev"
        icon="i-lucide-chevron-left"
        color="neutral"
        variant="outline"
        size="lg"
        class="min-h-11 shrink-0"
        aria-label="Previous citation"
        @click="emit('prev')"
      />
      <div class="flex min-w-0 flex-1 flex-col items-center gap-0.5 text-center text-xs">
        <span class="max-w-full truncate text-muted">{{ citationLabel }} · p. {{ targetPage ?? '?' }}</span>
        <UBadge
          v-if="approximate"
          color="warning"
          variant="subtle"
          size="sm"
        >
          {{ approximateLabel }}
        </UBadge>
      </div>
      <UButton
        v-if="canStep"
        label="Next"
        trailing-icon="i-lucide-chevron-right"
        color="neutral"
        variant="outline"
        size="lg"
        class="min-h-11 shrink-0"
        aria-label="Next citation"
        @click="emit('next')"
      />
    </div>

    <p
      class="sr-only"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
  </section>
</template>
