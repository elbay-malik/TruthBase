import { isPhone, open, pagesRegion, viewer } from './app'
import { documentOf, expect, test } from './fixtures'

// The first screen: the corpus index (desktop: the empty viewer pane; phones:
// under the example questions). A row opens that document from page 1.

test('the corpus index lists the documents and opens one from page 1', async ({ page, api }) => {
  await open(page)
  const index = isPhone(page) ? page.getByRole('main') : viewer(page)
  await expect(index.getByRole('heading', { name: 'The documents' })).toBeVisible()
  for (const [title, pages] of [
    ['Artificial Intelligence Risk Management Framework (AI RMF 1.0)', 48],
    ['The NIST Cybersecurity Framework (CSF) 2.0', 32],
    ['RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval', 23],
    ['Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection', 30],
  ] as const) await expect(index.getByRole('button', { name: `Open ${title}, ${pages} pages` })).toBeVisible()
  await expect(index.getByText('Highlight placement: 176/180 checks pass')).toBeVisible()
  await expect(index.getByRole('navigation', { name: 'Project' }).getByRole('link')).toHaveCount(4)
  expect(api.pdfStatuses).toEqual([])

  const csf = documentOf('nist-csf-2.0.pdf')
  await index.getByRole('button', { name: /^Open The NIST Cybersecurity Framework/ }).click()
  await expect(viewer(page)).toHaveAttribute('data-document-id', csf.id)
  await expect(pagesRegion(page, 'nist-csf-2.0.pdf')).toBeFocused()
  expect(api.questions).toEqual([])
})
