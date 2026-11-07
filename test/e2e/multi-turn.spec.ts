import { announcedPage, ask, chip, closeSheet, isPhone, liveStatus, open, openCitation, questionBox, viewer } from './app'
import { answerFor, answerStream, documentOf, expect, RECORDS, streamReply, test } from './fixtures'

// More than one question in a session: each new question scrolls into view,
// the scope stays visible by the box, an open passage has a link (address bar
// and "Copy link"), and a new conversation clears all of it.

const records = ['g-029', 'g-013', 'g-020'].map(id => RECORDS.find(r => r.id === id)!)

test('each new question scrolls to the top of the conversation', async ({ page, api }) => {
  api.chat = (route, body) => {
    const record = records.find(r => r.question === body.question)!
    return streamReply(route, answerStream(record.sources, answerFor(record)))
  }
  await open(page)
  for (const [i, record] of records.entries()) {
    await ask(page, record.question)
    await expect(liveStatus(page)).toHaveText(new RegExp(`^Answer ready, ${record.sources.length} sources?\\.$`))
    const question = page.getByRole('article').filter({ hasText: record.question }).getByRole('heading', { name: 'You' })
    // In view, near the top of the conversation column: the answer streams in below it.
    await expect(question).toBeInViewport()
    if (i > 0) {
      // At the top, unless what follows it is too short to scroll that far.
      const { offset, atBottom } = await question.evaluate((el) => {
        const scroller = el.closest('main')!.querySelector<HTMLElement>('.overflow-y-auto')!
        return {
          offset: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
          atBottom: scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1,
        }
      })
      expect(offset < 80 || atBottom, `question ${i + 1} at ${offset} px`).toBe(true)
      expect(offset).toBeGreaterThanOrEqual(0)
    }
  }
})

test('the scope shows as a chip by the box until removed', async ({ page, api }) => {
  const record = records[2]!
  const scopes: (string | undefined)[] = []
  api.chat = (route, body) => {
    scopes.push(body.documentId)
    return streamReply(route, answerStream(record.sources, answerFor(record)))
  }
  await open(page)
  const csf = documentOf('nist-csf-2.0.pdf')
  await page.getByRole('combobox', { name: 'Documents to search' }).click()
  await page.getByRole('option', { name: 'NIST CSF 2.0' }).click()

  const form = page.getByRole('form', { name: 'Ask a question' }).locator('..')
  await expect(form.getByText('Searching NIST CSF 2.0 only')).toBeVisible()
  await expect(questionBox(page)).toHaveAccessibleDescription('Searching NIST CSF 2.0 only')
  await ask(page, record.question)
  await expect(liveStatus(page)).toHaveText('Answer ready, 1 source.')
  await expect(page.getByRole('article').filter({ hasText: record.question })).toContainText('in NIST CSF 2.0 only')

  await form.getByRole('button', { name: 'Search all documents (remove filter NIST CSF 2.0)' }).click()
  await expect(form.getByText('Searching NIST CSF 2.0 only')).toHaveCount(0)
  await expect(questionBox(page)).toBeFocused()
  await expect(page.getByRole('combobox', { name: 'Documents to search' })).toHaveText('All documents')
  await ask(page, record.question)
  await expect(liveStatus(page)).toHaveText('Answer ready, 1 source.')
  expect(scopes).toEqual([csf.id, undefined])
})

test('an open citation is in the URL, and Copy link copies it', async ({ page, api, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
  const record = records[0]!
  api.chat = route => streamReply(route, answerStream(record.sources, answerFor(record)))
  await open(page)
  await ask(page, record.question)
  await expect(liveStatus(page)).toHaveText('Answer ready, 2 sources.')
  const [first, second] = record.sources as [typeof record.sources[0], typeof record.sources[0]]

  await openCitation(page, first)
  await expect(page).toHaveURL(`/?chunk=${first.chunkId}`)
  // The passage itself is read out with the page.
  await expect(viewer(page).locator('[aria-live="polite"]')).toHaveText(announcedPage(first, 'Citation 1 of 2'))
  await viewer(page).getByRole('button', { name: 'Next citation' }).click()
  await expect(page).toHaveURL(`/?chunk=${second.chunkId}`)

  await viewer(page).getByRole('button', { name: 'Copy link to this passage' }).click()
  await expect(viewer(page).getByRole('button', { name: 'Link copied' })).toBeVisible()
  await expect(viewer(page).locator('[aria-live="polite"]')).toHaveText('Link to this passage copied.')
  // The link carries the passage only, as the address bar does.
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()))
  expect(copied.origin + copied.pathname).toBe(new URL('/', baseURL).href)
  expect([...copied.searchParams.keys()]).toEqual(['chunk'])
  expect(copied.searchParams.get('chunk')).toBe(second.chunkId)

  if (isPhone(page)) {
    // Closing the sheet takes the passage out of the URL.
    await closeSheet(page, second)
    await expect(page).toHaveURL('/')
  }
})

test('New conversation clears the answers, the open passage and its URL', async ({ page, api }) => {
  const record = records[2]!
  api.chat = route => streamReply(route, answerStream(record.sources, answerFor(record)))
  await open(page)
  await expect(page.getByRole('button', { name: 'New conversation' })).toHaveCount(0)
  await ask(page, record.question)
  await expect(liveStatus(page)).toHaveText('Answer ready, 1 source.')
  const source = record.sources[0]!
  await openCitation(page, source)
  await expect(page).toHaveURL(`/?chunk=${source.chunkId}`)
  await closeSheet(page, source)

  await questionBox(page).fill('An unsent draft')
  await page.getByRole('button', { name: 'New conversation' }).click()
  await expect(page.getByRole('article')).toHaveCount(0)
  await expect(chip(page, source)).toHaveCount(0)
  await expect(page).toHaveURL('/')
  await expect(liveStatus(page)).toHaveText('New conversation.')
  await expect(questionBox(page)).toBeFocused()
  await expect(questionBox(page)).toHaveValue('An unsent draft')
  await expect(page.getByRole('heading', { name: 'Try a question' })).toBeVisible()
  if (!isPhone(page)) await expect(viewer(page).getByRole('heading', { name: 'The documents' })).toBeVisible()
})

test('the question box grows to six lines, then scrolls', async ({ page }) => {
  await open(page)
  const box = questionBox(page)
  const oneLine = await box.evaluate(el => el.getBoundingClientRect().height)
  await box.fill(Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of a long question`).join('\n'))
  await expect.poll(() => box.evaluate(el => (el as HTMLTextAreaElement).rows)).toBe(6)
  const { height, scrolls } = await box.evaluate(el => ({ height: el.getBoundingClientRect().height, scrolls: el.scrollHeight > el.clientHeight }))
  expect(height).toBeGreaterThan(oneLine * 3)
  expect(height).toBeLessThan(oneLine * 7)
  expect(scrolls).toBe(true)
})
