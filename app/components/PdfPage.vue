<script setup lang="ts">
import type { PDFPageProxy } from 'pdfjs-dist'
import type { HighlightRect } from '#shared/types'
import type { Box } from '#shared/utils/rect-overlap'
import '~/assets/css/pdf-text-layer.css'

// One PDF page: canvas + text layer rendered only while `visible` (near the
// viewport), released when scrolled far away. Highlights come straight from
// the stored PDF-space rects through the page viewport, so they are placed
// before the canvas paints and stay put on zoom (ADR-0004). When the stored
// rects are stale (`fallbackRange`), the highlight is rebuilt from the text
// layer instead — approximate, and only once the layer has rendered.

const props = defineProps<{
  page: PDFPageProxy
  scale: number
  visible: boolean
  rects?: HighlightRect[]
  fallbackRange?: { start: number, end: number }
  /** Re-trigger the highlight flash (e.g. the active citation's chunk id). */
  flashKey?: string
}>()

const viewport = computed(() => props.page.getViewport({ scale: props.scale }))
const mount = ref<HTMLDivElement>()
const rendered = shallowRef<RenderedPage>()
const fallbackBoxes = shallowRef<Box[]>([])
let token = 0

async function render() {
  const current = ++token
  const fresh = document.createElement('div')
  try {
    const result = await renderPage(props.page, props.scale, fresh)
    if (current !== token || !mount.value) {
      result.textLayer.cancel() // superseded by a newer zoom / scrolled away
      return
    }
    mount.value.replaceChildren(fresh)
    rendered.value = result
  }
  catch (error) {
    if ((error as Error)?.name !== 'RenderingCancelledException') console.error('[pdf] page render failed', error)
  }
}

function release() {
  token++
  rendered.value?.textLayer.cancel()
  rendered.value = undefined
  mount.value?.replaceChildren()
}

watch(() => [props.visible, props.scale] as const, ([visible]) => {
  if (visible) void render()
  else release()
}, { immediate: true })
onBeforeUnmount(release)

// Fallback geometry needs the text layer attached to the DOM.
watch([rendered, () => props.fallbackRange], async () => {
  fallbackBoxes.value = []
  if (!rendered.value || !props.fallbackRange) return
  await nextTick()
  fallbackBoxes.value = textLayerLines(rendered.value, props.fallbackRange.start, props.fallbackRange.end)
})

const boxes = computed<Box[]>(() => {
  if (props.fallbackRange) return fallbackBoxes.value
  return props.rects?.length ? toViewportBoxes(viewport.value, props.rects) : []
})

defineExpose({ boxes, viewport })
</script>

<template>
  <div
    class="pdf-page-slot relative bg-white shadow-sm ring-1 ring-black/5"
    :style="{ width: `${viewport.width}px`, height: `${viewport.height}px` }"
    :data-page-number="page.pageNumber"
  >
    <div
      ref="mount"
      class="absolute inset-0"
    />
    <div
      v-if="!rendered"
      class="absolute inset-0 grid place-items-center text-xs text-muted"
    >
      Page {{ page.pageNumber }}
    </div>
    <div
      class="pointer-events-none absolute inset-0 z-10"
      aria-hidden="true"
    >
      <div
        v-for="(box, i) in boxes"
        :key="`${flashKey}-${i}`"
        class="pdf-highlight absolute"
        :style="{ left: `${box.x1}px`, top: `${box.y1}px`, width: `${box.x2 - box.x1}px`, height: `${box.y2 - box.y1}px` }"
      />
    </div>
  </div>
</template>

<style>
/* Tint + outline: the highlight is not conveyed by colour alone (WIREFRAMES a11y). */
.pdf-highlight {
  background: rgb(250 204 21 / 0.38);
  box-shadow: 0 0 0 1.5px rgb(202 138 4 / 0.9);
  border-radius: 2px;
  mix-blend-mode: multiply;
  animation: pdf-highlight-flash 600ms ease-out 1;
}

@keyframes pdf-highlight-flash {
  0% { background: rgb(250 204 21 / 0.85); }
  100% { background: rgb(250 204 21 / 0.38); }
}

@media (prefers-reduced-motion: reduce) {
  .pdf-highlight { animation: none; }
}
</style>
