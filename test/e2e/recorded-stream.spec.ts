import { ask, chip, expectHighlight, liveStatus, open, openCitation, type Cited } from './app'
import { documentOf, expect, RECORDED_G020, SPANS, streamReply, test } from './fixtures'

// The real answer to g-020 as POST /api/chat streamed it (Groq, 2026-10-20),
// replayed byte for byte with its headers: the UI is checked against the real
// wire format, not only the one test/e2e/fixtures.ts builds.

test('recorded g-020 stream: chip [1] highlights RC.RP-03 on page 28', async ({ page, api }) => {
  api.chat = route => streamReply(route, RECORDED_G020)
  await open(page, '/?zoom=1')
  await ask(page, 'Which CSF subcategory says backups must be checked before they are used to restore systems?')
  await expect(liveStatus(page)).toHaveText('Answer ready, 1 source.')
  await expect(page.getByText('RC.RP‑03: “The integrity of backups')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Citation \d+:/ })).toHaveCount(1)

  const { id: documentId, filename } = documentOf('nist-csf-2.0.pdf')
  const source: Cited = { index: 1, filename, pageNumber: 28, documentId }
  await expect(chip(page, source)).toBeVisible()
  await openCitation(page, source)
  // The recording carries the stored (unrounded) rects; the fixture's are rounded to 0.01 pt.
  await expectHighlight(page, SPANS.find(s => s.id === 'g-020#1')!, source, 1)
})
