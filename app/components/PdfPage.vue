<script setup lang="ts">
import type { PDFPageProxy } from 'pdfjs-dist'
import type { HighlightRect } from '#shared/types'
import type { Box } from '~/utils/pdf-highlight'
import '~/assets/css/pdf-text-layer.css'

// One PDF page: canvas + text layer rendered only while `visible` (near the
// viewport), released when scrolled far away. Highlights come straight from
// the stored PDF-space rects through the page viewport, so they are placed
// before the canvas paints and stay put on zoom (ADR-0004). When the stored
// rects are stale (other page size, or the text moved), the highlight is
// rebuilt from the text layer instead — approximate, once the layer renders.

const props = defineProps<{
  page: PDFPageProxy
  scale: number
  visible: boolean
  rects?: HighlightRect[]
  /** The chunk's character range in the page text (stored with the rects). */
  range?: { start: number, end: number }
  /** The chunk text: checked against the rendered page text at `range`. */
  expectedText?: string
  /** The stored rects were computed for a different page size. */
  geometryStale?: boolean
  /** Re-trigger the highlight flash (e.g. the active citation + click count). */
  flashKey?: string
}>()

const emit = defineEmits<{
  /** Once rendered: do the stored offsets still address `expectedText`, and was it found at all? */
  verified: [result: { ok: boolean, located: boolean }]
  /** Text-layer fallback boxes are in place (the viewer scrolls to them). */
  fallbackReady: []
}>()

const viewport = computed(() => props.page.getViewport({ scale: props.scale }))
const mount = ref<HTMLDivElement>()
const rendered = shallowRef<RenderedPage>()
const fallbackBoxes = shallowRef<Box[]>([])
let rendering: AbortController | undefined

async function render() {
  // A newer zoom supersedes the render in flight: cancel it rather than let it finish.
  rendering?.abort()
  const controller = rendering = new AbortController()
  const fresh = document.createElement('div')
  try {
    const result = await renderPage(props.page, props.scale, fresh, controller.signal)
    if (controller.signal.aborted || !mount.value) {
      result.textLayer.cancel() // superseded by a newer zoom / scrolled away
      releaseCanvases(fresh)
      return
    }
    releaseCanvases(mount.value)
    mount.value.replaceChildren(fresh)
    rendered.value = result
  }
  catch (error) {
    releaseCanvases(fresh)
    const name = (error as Error)?.name
    if (name !== 'RenderingCancelledException' && name !== 'AbortError') console.error('[pdf] page render failed', error)
  }
}

function release() {
  rendering?.abort()
  rendering = undefined
  rendered.value?.textLayer.cancel()
  rendered.value = undefined
  releaseCanvases(mount.value)
  mount.value?.replaceChildren()
  // Drop the operator list and decoded images; once the cancelled render settles if one is in flight.
  props.page.cleanup()
}

watch(() => [props.visible, props.scale] as const, ([visible]) => {
  if (visible) void render()
  else release()
}, { immediate: true })
onBeforeUnmount(release)

// Stored rects are trusted only while the page text still has the cited
// passage at the stored offsets (same PDF.js version and normalization as
// ingestion). If it moved, the passage is looked up by its text instead, and
// the highlight is rebuilt from the text layer — approximate.
const check = computed(() => {
  const text = rendered.value?.pageText.text
  const { range, expectedText } = props
  if (text === undefined || !range || expectedText === undefined) return undefined
  if (text.slice(range.start, range.end) === expectedText) return { ok: true, range }
  const at = text.indexOf(expectedText)
  return { ok: false, range: at >= 0 ? { start: at, end: at + expectedText.length } : undefined }
})
// Every recheck (new target, re-render), not just changes: the viewer resets its flag per target.
watch(check, (result) => {
  if (result) emit('verified', { ok: result.ok, located: result.range !== undefined })
}, { immediate: true })

// Text moved but found elsewhere: rebuild from the text layer. Text not found
// at all: keep the stored rects (still on the right page) unless the page
// geometry changed too, in which case there is nothing trustworthy to draw.
const fallbackRange = computed(() => (check.value ? check.value.range : props.range))
const useFallback = computed(() => props.geometryStale || (check.value?.ok === false && check.value.range !== undefined))

// Fallback geometry needs the text layer attached to the DOM.
watch(() => [rendered.value, useFallback.value, fallbackRange.value?.start, fallbackRange.value?.end] as const, async ([r, fallback, start, end]) => {
  fallbackBoxes.value = []
  if (!r || !fallback || start === undefined || end === undefined) return
  await nextTick()
  if (r !== rendered.value) return
  fallbackBoxes.value = textLayerLines(r, start, end)
  if (fallbackBoxes.value.length) emit('fallbackReady')
}, { immediate: true })

const boxes = computed<Box[]>(() => {
  const all = useFallback.value
    ? fallbackBoxes.value
    : props.rects?.length ? toViewportBoxes(viewport.value, props.rects) : []
  return dropRunningMargins(all, viewport.value.height)
})

/**
 * The evidence bracket: one mark in the margin beside the whole passage, from
 * its first line's top to its last line's bottom (DESIGN.md "PDF Highlight").
 * It shows where the passage starts and ends by shape alone, so the per-line
 * tint is not the only cue. Dashed when the boxes are rebuilt from the text
 * layer (approximate).
 */
const BRACKET_GAP = 6
const BRACKET_WIDTH = 6
const bracket = computed(() => {
  const all = boxes.value
  if (!all.length) return undefined
  const top = Math.min(...all.map(b => b.y1))
  const bottom = Math.max(...all.map(b => b.y2))
  const left = Math.max(1, Math.min(...all.map(b => b.x1)) - BRACKET_GAP - BRACKET_WIDTH)
  return { left, top, height: bottom - top }
})

defineExpose({ boxes, viewport })
</script>

<template>
  <div
    class="pdf-page-slot relative bg-white shadow-sm ring-1 ring-black/5"
    role="group"
    :aria-label="`Page ${page.pageNumber}`"
    :style="{ width: `${viewport.width}px`, height: `${viewport.height}px` }"
    :data-page-number="page.pageNumber"
  >
    <div
      ref="mount"
      class="absolute inset-0"
    />
    <div
      v-if="!rendered"
      class="absolute inset-0 grid place-items-center text-xs text-slate-600"
      aria-hidden="true"
    >
      Page {{ page.pageNumber }}
    </div>
    <!-- No z-index: it would isolate the overlay, and the tint's multiply
         would no longer reach the canvas. Later in tree order = on top. -->
    <div
      class="pointer-events-none absolute inset-0"
      aria-hidden="true"
    >
      <div
        v-for="(box, i) in boxes"
        :key="`${flashKey}-${i}`"
        class="pdf-highlight absolute"
        :style="{ left: `${box.x1}px`, top: `${box.y1}px`, width: `${box.x2 - box.x1}px`, height: `${box.y2 - box.y1}px` }"
      />
      <div
        v-if="bracket"
        :key="`${flashKey}-bracket`"
        class="pdf-evidence-bracket absolute"
        :class="{ 'pdf-evidence-bracket--approximate': useFallback }"
        :style="{ left: `${bracket.left}px`, top: `${bracket.top}px`, width: `${BRACKET_WIDTH}px`, height: `${bracket.height}px` }"
      />
    </div>
  </div>
</template>

<style>
/*
 * The evidence mark (DESIGN.md "PDF Highlight"): a highlighter tint per line,
 * multiplied with the page so the glyphs stay crisp, and one bracket in the
 * margin beside the whole passage. The bracket is the non-colour cue: its
 * shape marks where the passage starts and ends. Margin Brown is 4.9:1 on the
 * always-white page; it is not blended.
 */
.pdf-highlight {
  border-radius: 2px;
}

.pdf-highlight::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgb(250 204 21 / 0.45);
  mix-blend-mode: multiply;
  animation: pdf-highlight-flash 600ms ease-out 1;
}

.pdf-evidence-bracket {
  border: 0 solid #a16207;
  border-width: 2px 0 2px 3px;
  animation: pdf-evidence-draw 420ms cubic-bezier(0.16, 1, 0.3, 1) 1;
}

/* Rebuilt from the text layer: the same mark, dashed, beside the "Approximate highlight" badge. */
.pdf-evidence-bracket--approximate {
  border-left-style: dashed;
}

@keyframes pdf-highlight-flash {
  0% { background: rgb(250 204 21 / 0.85); }
  100% { background: rgb(250 204 21 / 0.45); }
}

/* Drawn outward from the passage's middle, so the eye lands on it. */
@keyframes pdf-evidence-draw {
  0% { clip-path: inset(50% 0 50% 0); }
  100% { clip-path: inset(0 0 0 0); }
}

@media (prefers-reduced-motion: reduce) {
  .pdf-highlight::before,
  .pdf-evidence-bracket { animation: none; }
}
</style>
