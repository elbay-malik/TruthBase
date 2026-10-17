<script setup lang="ts">
// Phase 3.5 spike (throwaway; superseded by the Phase 5 viewer).
//
// Renders golden-span pages with PDF.js in the browser and measures the stored
// highlight rects (computed at ingestion) against the PDF.js text layer, at
// several zoom levels. Results land in `window.__spike` for
// scripts/spike-highlight.ts (Playwright) and in the table below.
//
//   /spike/highlight                      full run: 60 spans × zooms
//   /spike/highlight?span=g-006%232&zoom=2  one span, overlays drawn (screenshots)

import type { PDFDocumentProxy } from 'pdfjs-dist'
import fixturesJson from '~~/test/fixtures/highlight-spans.json'
import { overlapMetrics, type Box } from '#shared/utils/rect-overlap'
import '~/assets/css/pdf-text-layer.css'

interface Fixture {
  id: string
  document: string
  page: number
  text: string
  start: number
  end: number
  pageWidth: number
  pageHeight: number
  spanRects: { x1: number, y1: number, x2: number, y2: number }[]
  chunk: { start: number, end: number, rects: { x1: number, y1: number, x2: number, y2: number }[] }
}

interface EdgeCheck {
  /** Stored edge minus text-layer edge, in PDF points (zoom-independent). */
  delta: number
  /** Edge falls on a text-item boundary, where the text layer is exact. */
  atItemBoundary: boolean
}

interface InkCheck {
  /** Line has no ink inside the stored box at all (a misplaced highlight). */
  noInk: boolean
  coverage: number
  /** PDF points between box edge and ink edge; negative = ink outside the box. */
  topSlack: number
  bottomSlack: number
}

interface SpanResult {
  id: string
  zoom: number
  /** The text layer's characters at [start,end) equal the golden quote. */
  textMatches: boolean
  start?: EdgeCheck
  end?: EdgeCheck
  /** Per stored line rect of the span. */
  ink: InkCheck[]
  /** Informational: area overlap with the text-layer line hulls. */
  hull: { iou: number, coverage: number, precision: number }
  chunkHull: { iou: number, coverage: number, precision: number }
  storedLines: number
  truthLines: number
}

interface PageCheck {
  document: string
  page: number
  rotate: number
  viewOrigin: [number, number]
  sizeDelta: number
  /** Page size is a whole number of CSS px at every measured zoom. Otherwise the
   * text layer (rounded down to whole px) and the overlay drift apart slightly. */
  wholePixelSizes: boolean
}

definePageMeta({ layout: false })
useHead({ title: 'Highlight spike', meta: [{ name: 'robots', content: 'noindex' }] })

const fixtures = fixturesJson as Fixture[]
const ZOOMS = [0.5, 1, 2]
const route = useRoute()
const mount = ref<HTMLDivElement>()
const status = ref('starting…')
const results = ref<SpanResult[]>([])

const warnings: string[] = []
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '))
  originalWarn(...args)
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

onMounted(async () => {
  const spike: Record<string, unknown> = { status: 'running' }
  ;(window as unknown as { __spike: unknown }).__spike = spike
  try {
    const pdfjs = await loadPdfjs()
    const documents = await $fetch('/api/documents')
    const idOf = Object.fromEntries(documents.map(d => [d.filename, d.id]))

    const only = typeof route.query.span === 'string' ? route.query.span : undefined
    const zooms = typeof route.query.zoom === 'string' ? [Number(route.query.zoom)] : ZOOMS
    const selected = only ? fixtures.filter(f => f.id === only) : fixtures
    if (selected.length === 0) throw new Error(`no fixture ${only}`)

    const pageChecks: PageCheck[] = []
    const byDocument = Map.groupBy(selected, f => f.document)
    for (const [filename, docFixtures] of byDocument) {
      status.value = `loading ${filename}`
      const { url } = await $fetch(`/api/documents/${idOf[filename]}/file`)
      const loadingTask = pdfjs.getDocument({ url })
      const pdf: PDFDocumentProxy = await loadingTask.promise
      try {
        for (const [pageNumber, pageFixtures] of Map.groupBy(docFixtures, f => f.page)) {
          const page = await pdf.getPage(pageNumber)
          const unscaled = page.getViewport({ scale: 1 })
          pageChecks.push({
            document: filename,
            page: pageNumber,
            rotate: page.rotate,
            viewOrigin: [page.view[0]!, page.view[1]!],
            sizeDelta: round(Math.max(Math.abs(unscaled.width - pageFixtures[0]!.pageWidth), Math.abs(unscaled.height - pageFixtures[0]!.pageHeight)), 3),
            wholePixelSizes: zooms.every(z => Number.isInteger(unscaled.width * z) && Number.isInteger(unscaled.height * z)),
          })

          for (const zoom of zooms) {
            status.value = `${filename} p.${pageNumber} @ ${zoom}×`
            mount.value!.replaceChildren()
            const rendered = await renderPage(page, zoom, mount.value!)

            for (const f of pageFixtures) {
              const stored = toViewportBoxes(rendered.viewport, f.spanRects)
              const lines = textLayerLines(rendered, f.start, f.end)
              const chunkStored = toViewportBoxes(rendered.viewport, f.chunk.rects)
              const edge = (index: number, side: 'start' | 'end', storedX: number | undefined): EdgeCheck | undefined => {
                const truth = textLayerEdge(rendered, index, side)
                return truth && storedX !== undefined
                  ? { delta: round((storedX - truth.x) / zoom, 3), atItemBoundary: truth.atItemBoundary }
                  : undefined
              }
              const m = (a: Box[], b: Box[]) => {
                const r = overlapMetrics(a, b)
                return { iou: round(r.iou, 3), coverage: round(r.coverage, 3), precision: round(r.precision, 3) }
              }
              results.value.push({
                id: f.id,
                zoom,
                textMatches: rendered.pageText.text.slice(f.start, f.end) === f.text,
                start: edge(f.start, 'start', stored[0]?.x1),
                end: edge(f.end - 1, 'end', stored.at(-1)?.x2),
                ink: inkCoverage(rendered, stored).map(i => ({
                  noInk: i.noInk,
                  coverage: round(i.coverage, 3),
                  topSlack: round(i.topSlack / zoom),
                  bottomSlack: round(i.bottomSlack / zoom),
                })),
                hull: m(stored, lines),
                chunkHull: m(chunkStored, textLayerLines(rendered, f.chunk.start, f.chunk.end)),
                storedLines: stored.length,
                truthLines: lines.length,
              })

              if (only) {
                drawBoxes(rendered.container, chunkStored, 'spike-chunk')
                drawBoxes(rendered.container, textLayerBoxes(rendered, f.start, f.end), 'spike-truth')
                drawBoxes(rendered.container, stored, 'spike-stored')
              }
            }
          }
          page.cleanup()
        }
      }
      finally {
        await loadingTask.destroy() // PDF.js 6: no PDFDocumentProxy#destroy
      }
    }

    Object.assign(spike, {
      status: 'done',
      fakeWorker: warnings.some(w => w.includes('fake worker')),
      warnings,
      pageChecks,
      results: results.value,
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
    })
    status.value = `done: ${results.value.length} measurements`
  }
  catch (error) {
    Object.assign(spike, { status: 'error', error: String(error), warnings })
    status.value = `error: ${String(error)}`
  }
  finally {
    console.warn = originalWarn
  }
})
</script>

<template>
  <main class="spike">
    <p data-testid="status">
      {{ status }}
    </p>
    <div
      ref="mount"
      class="spike-mount"
    />
    <table v-if="results.length && !route.query.span">
      <thead>
        <tr><th>span</th><th>zoom</th><th>text</th><th>start Δ pt</th><th>end Δ pt</th><th>min ink coverage</th><th>hull IoU</th><th>lines</th></tr>
      </thead>
      <tbody>
        <tr
          v-for="r in results"
          :key="`${r.id}@${r.zoom}`"
        >
          <td>{{ r.id }}</td><td>{{ r.zoom }}</td><td>{{ r.textMatches ? '✓' : '✗' }}</td>
          <td>{{ r.start?.delta }}{{ r.start?.atItemBoundary ? '' : ' (mid)' }}</td>
          <td>{{ r.end?.delta }}{{ r.end?.atItemBoundary ? '' : ' (mid)' }}</td>
          <td>{{ r.ink.some(i => i.noInk) ? 'NO INK' : Math.min(...r.ink.map(i => i.coverage)) }}</td>
          <td>{{ r.hull.iou }}</td>
          <td>{{ r.storedLines }}/{{ r.truthLines }}</td>
        </tr>
      </tbody>
    </table>
  </main>
</template>

<style>
.spike { padding: 16px; font: 13px/1.4 system-ui, sans-serif; background: #fff; color: #111; }
.spike-mount { display: inline-block; box-shadow: 0 0 0 1px #ccc; }
.spike table { border-collapse: collapse; margin-top: 16px; }
.spike td, .spike th { border: 1px solid #ddd; padding: 2px 6px; text-align: right; }
.spike-chunk { background: rgb(37 99 235 / 0.12); }
.spike-stored { background: rgb(37 99 235 / 0.28); }
.spike-truth { outline: 1.5px solid rgb(220 38 38 / 0.95); }
</style>
