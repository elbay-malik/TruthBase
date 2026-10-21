import { pageName } from '../../app/utils/corpus'
import { expectHighlight, isPhone, open, viewer } from './app'
import { chunkIdOf, expect, sourceOf, SPANS, test } from './fixtures'

// Citation deep links: /?chunk=<id>[&zoom=<scale>] opens the chunk in the
// viewer (the phone sheet opens by itself), highlighted, before any question.

for (const [id, zoom] of [['g-020#1', 1], ['g-038#2', 2], ['g-045#1', 0.5]] as const) {
  const span = SPANS.find(s => s.id === id)!
  test(`/?chunk= ${id} (${span.document} p. ${span.page}) at zoom ${zoom}`, async ({ page, api, fakeWorker }) => {
    await open(page, `/?chunk=${chunkIdOf(span)}&zoom=${zoom}`)
    await expect(viewer(page).getByText(`Linked citation · ${pageName(span.document, span.page).text}`)).toBeVisible()
    await expectHighlight(page, span, sourceOf(span), zoom)
    expect(api.questions).toEqual([])
    expect(fakeWorker.used).toBe(false)
    // Cross-origin from the stub's "Storage" (CORS, Accept-Ranges as Supabase sends them).
    // Whether PDF.js also asks for ranges depends on how fast the stream arrives.
    expect(api.pdfStatuses.length).toBeGreaterThan(0)
    expect(api.pdfStatuses.every(status => status === 200 || status === 206)).toBe(true)
  })
}

test('a PDF whose download stalls loads by range requests', async ({ page, api }) => {
  const span = SPANS.find(s => s.id === 'g-043#2')!
  api.pdfStall = true
  await open(page, `/?chunk=${chunkIdOf(span)}&zoom=1`)
  await expectHighlight(page, span, sourceOf(span), 1)
  expect(api.pdfStatuses).toContain(206)
})

test('an unknown chunk id leaves the viewer empty', async ({ page, api }) => {
  await open(page, '/?chunk=00000000-0000-4000-a000-000000000000')
  await expect(page.getByRole('heading', { name: 'TruthBase', level: 1 })).toBeVisible()
  if (isPhone(page)) await expect(viewer(page)).toBeHidden()
  else await expect(viewer(page).getByRole('heading', { name: 'The documents' })).toBeVisible()
  expect(api.questions).toEqual([])
})
