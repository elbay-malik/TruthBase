import { pageName } from '../../app/utils/corpus'
import { expectHighlight, isPhone, open, viewer } from './app'
import { chunkIdOf, expect, sourceOf, SPANS, test } from './fixtures'

// Citation deep links: /?chunk=<id>[&zoom=<scale>] opens the chunk in the
// viewer (the phone sheet opens by itself), highlighted, before any question.

for (const [id, zoom] of [['g-020#1', 1], ['g-038#2', 2], ['g-045#1', 0.5]] as const) {
  const span = SPANS.find(s => s.id === id)!
  test(`/?chunk= ${id} (${span.document} p. ${span.page}) at zoom ${zoom}`, async ({ page, api, fakeWorker }) => {
    await open(page, `/?chunk=${chunkIdOf(span)}&zoom=${zoom}`)
    await expect(viewer(page).getByText(`Shared passage · ${pageName(span.document, span.page).text}`)).toBeVisible()
    await expectHighlight(page, span, sourceOf(span), zoom)
    expect(api.questions).toEqual([])
    expect(fakeWorker.used).toBe(false)
    // The corpus PDF from the build's own /pdfs, as production serves it.
    expect(api.pdfStatuses.length).toBeGreaterThan(0)
    expect(api.pdfStatuses.every(status => status === 200 || status === 206)).toBe(true)
  })
}

// Cross-origin from the stub's "Storage", as a document outside the corpus
// loads: CORS and Accept-Ranges as Supabase sends them.
test('a PDF whose download stalls loads by range requests', async ({ page, api }) => {
  const span = SPANS.find(s => s.id === 'g-043#2')!
  api.pdfStall = true
  await open(page, `/?chunk=${chunkIdOf(span)}&zoom=1`)
  await expectHighlight(page, span, sourceOf(span), 1)
  expect(api.pdfStatuses).toContain(206)
})

test('a shared claim may contain < and >', async ({ page, api }) => {
  const span = SPANS.find(s => s.id === 'g-020#1')!
  const url = `/?chunk=${chunkIdOf(span)}&claim=${encodeURIComponent('Tier 2 < Tier 3')}`
  // nuxt-security's XSS validator used to answer 400 to the page itself.
  expect((await page.request.get(url)).status()).toBe(200)
  await open(page, url)
  await expect(viewer(page).getByText(`Shared passage · ${pageName(span.document, span.page).text}`)).toBeVisible()
  expect(api.questions).toEqual([])
})

test('an unknown chunk id leaves the viewer empty', async ({ page, api }) => {
  await open(page, '/?chunk=00000000-0000-4000-a000-000000000000')
  await expect(page.getByRole('heading', { name: 'TruthBase', level: 1 })).toBeVisible()
  if (isPhone(page)) await expect(viewer(page)).toBeHidden()
  else await expect(viewer(page).getByRole('heading', { name: 'The documents' })).toBeVisible()
  expect(api.questions).toEqual([])
})
