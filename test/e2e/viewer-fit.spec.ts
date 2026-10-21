import { claimSentence, splitCitations } from '../../shared/utils/citations'
import { announcedPage, ask, chip, expectHighlight, isPhone, liveStatus, open, openCitation, pagesRegion, viewer, viewerZoom } from './app'
import { answerFor, answerStream, expect, RECORDS, streamReply, test } from './fixtures'

// Reading the evidence where it is shown: on phones a citation opens zoomed to
// its passage (not the page width) with the claim it backs beside it; when the
// page is wider than the pane, the passage's start and bracket stay in view.

test('phone: a citation opens zoomed to its passage, with the claim it backs', async ({ page, api }) => {
  test.skip(!isPhone(page), 'the sheet exists only on phones')
  const record = RECORDS.find(r => r.id === 'g-029')!
  const answer = answerFor(record)
  api.chat = route => streamReply(route, answerStream(record.sources, answer))
  await open(page)
  await ask(page, record.question)
  await expect(liveStatus(page)).toHaveText('Answer ready, 2 sources.')

  const [first, second] = record.sources as [typeof record.sources[0], typeof record.sources[0]]
  await openCitation(page, first)
  const sheet = viewer(page)
  // The sheet header names the document, not its truncated filename.
  await expect(sheet.locator('header')).toContainText('Self-RAG')
  await expect(sheet.locator('header')).not.toContainText(first.filename)

  // Zoomed in past fit width, to a whole percent, and the overlay is exact there.
  const fit = viewer(page).getByRole('button', { name: /^Fit to width/ })
  await expect(fit).toHaveAttribute('aria-pressed', 'false')
  const zoom = await viewerZoom(page)
  const pane = await pagesRegion(page, first.filename).evaluate(el => el.clientWidth)
  const fitWidthZoom = (pane - 32) / record.spans[0]!.pageWidth
  expect(zoom).toBeGreaterThan(fitWidthZoom + 0.05)
  await expectHighlight(page, record.spans[0]!, first, zoom)

  // The answer's sentence for this chip, shown with its number.
  const claimOf = (index: number) => claimSentence(splitCitations(answer, record.sources.length), index)
  await expect(sheet.getByText(claimOf(1), { exact: false }).first()).toBeVisible()

  // Stepping carries the claim along.
  await sheet.getByRole('button', { name: 'Next citation' }).click()
  await expect(sheet.locator('[aria-live="polite"]')).toHaveText(announcedPage(second, 'Citation 2 of 2'))
  await expect(sheet.getByText(claimOf(2), { exact: false }).first()).toBeVisible()

  // Fit returns to the page width.
  await fit.click()
  await expect(fit).toHaveAttribute('aria-pressed', 'true')
})

test('desktop at 200%: the passage opens from its left edge, bracket in view', async ({ page, api }) => {
  test.skip(isPhone(page), 'checks the pane at a zoom wider than it')
  const record = RECORDS.find(r => r.id === 'g-020')!
  api.chat = route => streamReply(route, answerStream(record.sources, answerFor(record)))
  await open(page, '/?zoom=2')
  await ask(page, record.question)
  await openCitation(page, record.sources[0]!)
  await expectHighlight(page, record.spans[0]!, record.sources[0]!, 2)
  const view = await viewer(page).getByRole('region', { name: /PDF pages$/ }).evaluate((scroller) => {
    const pane = scroller.getBoundingClientRect()
    const bracket = scroller.querySelector('.pdf-evidence-bracket')!.getBoundingClientRect()
    return { inView: bracket.left >= pane.left && bracket.right <= pane.left + scroller.clientWidth, cutRight: scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 1 }
  })
  expect(view.inView).toBe(true)
  // The page runs on past the right edge: that edge is shaded.
  if (view.cutRight) await expect(viewer(page).locator('.pdf-cut-edge--right')).toHaveCount(1)
  await expect(chip(page, record.sources[0]!)).toHaveAttribute('aria-current', 'true')
})
