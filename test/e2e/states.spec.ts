import { quotaMessage } from '../../server/utils/quota'
import { announcedPage, ask, chip, closeSheet, expectHighlight, isPhone, liveStatus, open, openCitation, pagesRegion, questionBox, viewer } from './app'
import { pageName, sourceName } from '../../app/utils/corpus'
import { answerFor, answerStream, errorStream, expect, RECORDS, refusalStream, sourceOf, SPANS, streamReply, test } from './fixtures'

// The answer and viewer states of WIREFRAMES §4 and §7: a grounded refusal,
// the daily demo cap, a failed answer, a PDF that fails to load, and an
// answer cut off mid-stream.

test('NO_ANSWER: a neutral refusal, related passages open without a highlight', async ({ page, api }) => {
  const related = ['g-020#1', 'g-015#1', 'g-017#1'].map((id, i) => sourceOf(SPANS.find(s => s.id === id)!, i + 1))
  api.chat = route => streamReply(route, refusalStream(related))
  await open(page)
  await ask(page, 'What financial penalties does the NIST CSF 2.0 impose for non-compliance?')

  await expect(liveStatus(page)).toHaveText('Not found in the documents.')
  await expect(page.getByText('Not found in the documents.', { exact: true }).and(page.locator(':not([role="status"])'))).toBeVisible()
  await expect(page.getByRole('button', { name: /^Citation \d+:/ })).toHaveCount(0)
  await expect(page.getByText('NO_ANSWER')).toHaveCount(0)

  const target = related[1]!
  await page.getByRole('button', { name: `Open ${sourceName(target)}: possibly related, not a source` }).click()
  await expect(viewer(page)).toHaveAttribute('data-document-id', target.documentId)
  await expect(viewer(page).getByText(`Possibly related, not a source · ${pageName(target.filename, target.pageNumber).text}`)).toBeVisible()
  await expect(viewer(page).getByRole('group', { name: `Page ${target.pageNumber}`, exact: true }).locator('canvas')).toBeVisible()
  await expect(viewer(page).locator('.pdf-highlight')).toHaveCount(0)
})

test('daily cap: 429 from the quota shows the reset time and keeps the box read-only', async ({ page, api }) => {
  // Fixed, not secondsUntilUtcMidnight(): near midnight the cap could lift mid-test.
  const retryAfter = 3 * 3600
  const message = quotaMessage('chat', 'client', 30)
  // createError's JSON body as Nitro sends it (server/utils/quota.ts enforceQuota).
  api.chat = route => route.fulfill({
    status: 429,
    headers: { 'retry-after': String(retryAfter) },
    json: { error: true, url: route.request().url(), statusCode: 429, statusMessage: 'Too Many Requests', message, data: { quota: 'client', resource: 'chat', retryAfter } },
  })
  await open(page)
  const question = RECORDS[0]!.question
  await ask(page, question)

  await expect(page.getByText('Daily demo limit reached', { exact: true })).toBeVisible()
  const conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(message)).toBeVisible()
  await expect(conversation.getByText(/Back in about (3 h 0|2 h 59) min, at /)).toBeVisible()
  await expect(liveStatus(page)).toHaveText(new RegExp(`^Daily demo limit reached\\. ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Back at `))
  await expect(questionBox(page)).toHaveAttribute('readonly')
  await expect(questionBox(page)).toHaveAttribute('placeholder', /^Back at /)
  await expect(page.getByRole('button', { name: 'Ask' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)

  // Neither Enter nor Ask sends again until the reset.
  await questionBox(page).press('Enter')
  // aria-disabled, not disabled: still clickable, and a no-op.
  await page.getByRole('button', { name: 'Ask' }).click({ force: true })
  await expect(liveStatus(page)).toHaveText(/^Daily demo limit reached\./)
  expect(api.questions).toEqual([question])
})

test('per-minute limit: the Postgres 429 reads as "wait a minute", not a daily cap', async ({ page, api }) => {
  const record = RECORDS.find(r => r.id === 'g-020')!
  let calls = 0
  // createError's JSON body for a blocked chat:minute counter (enforceQuota): no data.quota.
  api.chat = route => calls++ === 0
    ? route.fulfill({
        status: 429,
        headers: { 'retry-after': '42' },
        json: { error: true, url: route.request().url(), statusCode: 429, statusMessage: 'Too Many Requests', message: quotaMessage('chat', 'minute', 10), data: { limit: 'minute', resource: 'chat', retryAfter: 42 } },
      })
    : streamReply(route, answerStream(record.sources, answerFor(record)))
  await open(page)
  await ask(page, record.question)

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText('Per-minute limit reached', { exact: true })).toBeVisible()
  // The quota's own message, with the limit it enforces.
  await expect(conversation.getByText(quotaMessage('chat', 'minute', 10), { exact: true })).toBeVisible()
  await expect(page.getByText('Daily demo limit reached', { exact: true })).toHaveCount(0)
  await expect(questionBox(page)).not.toHaveAttribute('readonly')
  await conversation.getByRole('button', { name: 'Retry' }).click()
  await expect(liveStatus(page)).toHaveText('Answer ready, 1 source.')
  expect(api.questions).toEqual([record.question, record.question])
})

test('error part: the alert shows the route\'s message, Retry answers again', async ({ page, api }) => {
  const record = RECORDS.find(r => r.id === 'g-020')!
  const busy = 'The answer service is busy right now. Please try again in a minute.'
  let calls = 0
  api.chat = route => streamReply(route, calls++ === 0 ? errorStream(record.sources, busy) : answerStream(record.sources, answerFor(record)))
  await open(page)
  await ask(page, record.question)

  const conversation = page.getByRole('region', { name: 'Conversation' })
  const title = conversation.getByText('Answer service unavailable', { exact: true })
  await expect(title).toBeVisible()
  await expect(conversation.getByText(busy, { exact: true })).toBeVisible()
  await expect(liveStatus(page)).toHaveText(`Answer service unavailable. ${busy}`)
  await expect(page.getByRole('button', { name: /^Citation \d+:/ })).toHaveCount(0)
  // The failed question is back in the box, ready to edit or re-send.
  await expect(questionBox(page)).toHaveValue(record.question)

  await conversation.getByRole('button', { name: 'Retry' }).click()
  await expect(liveStatus(page)).toHaveText('Answer ready, 1 source.')
  await expect(title).toHaveCount(0)
  await expect(chip(page, record.sources[0]!)).toBeVisible()
  await expect(questionBox(page)).toHaveValue('')
  expect(api.questions).toEqual([record.question, record.question])
})

test('PDF load failure: the viewer offers Retry, then shows the highlight', async ({ page, api }) => {
  const record = RECORDS.find(r => r.id === 'g-020')!
  const source = record.sources[0]!
  api.chat = route => streamReply(route, answerStream(record.sources, answerFor(record)))
  api.pdfDown = true
  await open(page, '/?zoom=1')
  await ask(page, record.question)
  await chip(page, source).click()

  await expect(viewer(page).getByText('Document failed to load', { exact: true })).toBeVisible()
  await expect(viewer(page).locator('[aria-live="polite"]')).toHaveText('NIST CSF 2.0 failed to load. Retry available.')
  // The cited passage is still readable.
  await expect(viewer(page).locator('blockquote')).toContainText('RC.RP-03: The integrity of backups')

  api.pdfDown = false
  await viewer(page).getByRole('button', { name: 'Retry' }).click()
  await expect(pagesRegion(page, source.filename)).toBeFocused()
  await expectHighlight(page, record.spans[0]!, source, 1)
  await expect(viewer(page).locator('[aria-live="polite"]')).toHaveText(announcedPage(source, 'Citation 1 of 1'))
})

test('interrupted stream: partial citations stay clickable, Regenerate answers again', async ({ page, api }) => {
  const record = RECORDS.find(r => r.id === 'g-013')!
  const answer = answerFor(record)
  // Cut right after the first citation marker.
  const deltas = answer.match(/\S+\s*|\s+/g)!
  const cut = deltas.findIndex(d => d.startsWith('[1]')) + 1
  let calls = 0
  api.chat = route => streamReply(route, answerStream(record.sources, answer, calls++ === 0 ? { cut } : {}))
  await open(page, '/?zoom=1')
  await ask(page, record.question)

  await expect(liveStatus(page)).toHaveText('Answer interrupted.')
  await expect(page.getByText('Answer interrupted.', { exact: true }).and(page.locator(':not([role="status"])'))).toBeVisible()
  await expect(page.getByRole('button', { name: /^Citation \d+:/ })).toHaveCount(1)

  const source = record.sources[0]!
  await openCitation(page, source)
  await expectHighlight(page, record.spans[0]!, source, 1)
  await closeSheet(page, source)

  await page.getByRole('button', { name: 'Regenerate' }).click()
  await expect(liveStatus(page)).toHaveText('Answer ready, 2 sources.')
  await expect(page.getByText('Answer interrupted.', { exact: true }).and(page.locator(':not([role="status"])'))).toHaveCount(0)
  await expect(chip(page, record.sources[1]!)).toBeVisible()
  expect(api.questions).toEqual([record.question, record.question])
  if (isPhone(page)) await expect(viewer(page)).toBeHidden()
})

// Phones: closing the sheet hands focus back to the chip. Touch has no hover,
// so the chip has no tooltip to open there and cover the answer.
test('phone: closing the sheet does not open the chip\'s tooltip', async ({ page, api }) => {
  test.skip(!isPhone(page), 'the sheet exists only on phones')
  const record = RECORDS.find(r => r.id === 'g-029')!
  api.chat = route => streamReply(route, answerStream(record.sources, answerFor(record)))
  await open(page)
  await ask(page, record.question)
  await openCitation(page, record.sources[0]!)
  await viewer(page).getByRole('button', { name: 'Close document' }).click()
  await expect(chip(page, record.sources[0]!)).toBeFocused()
  // Give a delayed tooltip time to open, if one were going to.
  await page.waitForTimeout(800)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
})
