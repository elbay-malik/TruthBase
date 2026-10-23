import { expect, test } from './fixtures'

// An address with no page gets TruthBase's own error page (app/error.vue),
// rendered by the production build with its real 404 status, and a way back.

test('an unknown address gets the TruthBase 404 page, with a way to the start page', async ({ page, api }) => {
  const response = await page.goto('/no-such-page')
  expect(response?.status()).toBe(404)
  await expect(page).toHaveTitle('Page not found · TruthBase')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
  await expect(page.getByText('There is no page at this address.')).toBeVisible()
  await expect(page.getByText('no-such-page')).toHaveCount(0)

  await page.getByRole('link', { name: 'Go to the start page' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'TruthBase', level: 1 })).toBeVisible()
  expect(api.questions).toEqual([])
})
