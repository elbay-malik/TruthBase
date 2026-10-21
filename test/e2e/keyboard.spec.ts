import type { Locator } from '@playwright/test'
import { announcedPage, chip, isPhone, liveStatus, open, pagesRegion, questionBox, viewer } from './app'
import { answerFor, answerStream, expect, RECORDS, streamReply, test } from './fixtures'

// The keyboard-only showcase flow (WIREFRAMES "Keyboard and accessibility"):
// "/" → question → Enter → Tab to a chip → Enter → focus in the viewer and
// "Page N (PDF page M), Citation i of m" announced → "[" / "]" → Esc back to the chip.

// Two sources in one document, on pages 7 and 17.
const record = RECORDS.find(r => r.id === 'g-029')!
const [first, second] = record.sources as [typeof record.sources[0], typeof record.sources[0]]

const isFocused = (locator: Locator) => locator.evaluate(el => el === document.activeElement)

test('keyboard only: / → ask → chip → [ ] → Esc', async ({ page, api }) => {
  api.chat = route => streamReply(route, answerStream(record.sources, answerFor(record)))
  await open(page)

  await page.keyboard.press('/')
  await expect(questionBox(page)).toBeFocused()
  await page.keyboard.type(record.question)
  await page.keyboard.press('Enter')
  await expect(liveStatus(page)).toHaveText('Answer ready, 2 sources.')
  expect(api.questions).toEqual([record.question])
  // Sending keeps focus in the question box.
  await expect(questionBox(page)).toBeFocused()

  // The chips sit above the box in reading order: back to the first, then Tab to the next.
  for (let i = 0; i < 10 && !(await isFocused(chip(page, first))); i++) await page.keyboard.press('Shift+Tab')
  await expect(chip(page, first)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(chip(page, second)).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(chip(page, first)).toBeFocused()

  await page.keyboard.press('Enter')
  const pages = pagesRegion(page, first.filename)
  const announcement = viewer(page).locator('[aria-live="polite"]')
  await expect(pages).toBeFocused()
  await expect(announcement).toHaveText(announcedPage(first, 'Citation 1 of 2'))
  await expect(viewer(page).getByRole('group', { name: 'Page 7', exact: true }).locator('.pdf-highlight').first()).toBeVisible()
  // Phones: the sheet is modal, so the chips are hidden from the accessibility tree meanwhile.
  if (!isPhone(page)) await expect(chip(page, first)).toHaveAttribute('aria-current', 'true')

  await page.keyboard.press(']')
  await expect(announcement).toHaveText(announcedPage(second, 'Citation 2 of 2'))
  await expect(viewer(page).getByRole('group', { name: 'Page 17', exact: true }).locator('.pdf-highlight').first()).toBeVisible()
  await expect(pages).toBeFocused()
  await page.keyboard.press('[')
  await expect(announcement).toHaveText(announcedPage(first, 'Citation 1 of 2'))
  await page.keyboard.press(']')
  await expect(announcement).toHaveText(announcedPage(second, 'Citation 2 of 2'))

  // Esc returns to the chip of the citation now shown (phones: and closes the sheet).
  await page.keyboard.press('Escape')
  if (isPhone(page)) await expect(viewer(page)).toBeHidden()
  await expect(chip(page, second)).toBeFocused()
  await expect(chip(page, second)).toHaveAttribute('aria-current', 'true')

  // "/" again, from the chip: back to the question box.
  await page.keyboard.press('/')
  await expect(questionBox(page)).toBeFocused()
})
