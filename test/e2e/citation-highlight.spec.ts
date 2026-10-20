import { ask, closeSheet, expectHighlight, liveStatus, open, openCitation, setZoom, viewerZoom } from './app'
import { answerFor, answerStream, expect, RECORDS, streamReply, test } from './fixtures'

// The differentiator (SPEC "Highlight accuracy", Phase 13): ask → the answer
// streams with citation chips → click a chip → the viewer opens the right
// document at the right page with the overlay exactly where the chunk's stored
// rects say, at 50%, 100% and 200%. One test per golden question; its answer
// cites every evidence span's chunk. Besides the geometry, each line's box
// must cover its glyph ink on the rendered canvas (check:viewer assertion 4; desktop),
// so the overlay is checked against what is drawn, not only against the rects.
//
// Desktop runs every golden span. The phone project (bottom sheet) runs the
// @core questions: all four PDFs, several chunks on one page, two pages, two
// documents in one answer; E2E_FULL=1 runs the rest there too.

const ZOOMS = [0.5, 1, 2]
const CORE = new Set(['g-001', 'g-013', 'g-020', 'g-022', 'g-029', 'g-038', 'g-043', 'g-045'])

for (const record of RECORDS) {
  const where = [...new Set(record.sources.map(s => `${s.filename} p. ${s.pageNumber}`))].join(', ')
  test(`${record.id}: chip → highlight (${where})`, { tag: CORE.has(record.id) ? '@core' : '@full' }, async ({ page, api, fakeWorker }) => {
    api.chat = route => streamReply(route, answerStream(record.sources, answerFor(record)))
    await open(page, `/?zoom=${ZOOMS[0]}`)
    await ask(page, record.question)
    const n = record.sources.length
    await expect(liveStatus(page)).toHaveText(`Answer ready, ${n} ${n === 1 ? 'source' : 'sources'}.`)
    expect(api.questions).toEqual([record.question])

    for (const zoom of ZOOMS) {
      for (const [i, span] of record.spans.entries()) {
        const source = record.sources[record.cites[i]! - 1]!
        // A chunk cited for several spans is checked once.
        if (record.cites.indexOf(source.index) !== i) continue
        await openCitation(page, source)
        if (await viewerZoom(page) !== zoom) {
          await setZoom(page, zoom)
          // Clicking the chip again scrolls back to the passage at the new zoom.
          await closeSheet(page, source)
          await openCitation(page, source)
        }
        await expectHighlight(page, span, source, zoom)
        await closeSheet(page, source)
      }
    }
    expect(fakeWorker.used, 'PDF.js fell back to its main-thread fake worker').toBe(false)
    expect(page.workers().map(w => w.url())).toContainEqual(expect.stringMatching(/\/pdf\.worker[^/]*\.mjs$/))
  })
}
