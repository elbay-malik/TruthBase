import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getDocumentProxy } from 'unpdf'
import { describe, expect, it } from 'vitest'
import { documentInfo, folioOf, pageName, passageText, printedPage, sourceName } from '../../app/utils/corpus'

const PDFS = resolve(__dirname, '../../docs/golden/pdfs')
const DOCUMENTS = ['nist-ai-rmf-1.0.pdf', 'nist-csf-2.0.pdf', 'self-rag.pdf', 'raptor.pdf']
/** Running heads and folios sit in this share of the page height (RUNNING_MARGIN). */
const BAND = 0.075

/** Text of the top and bottom margin bands of every page, in PDF.js item order. */
async function margins(filename: string): Promise<{ top: string, bottom: string[] }[]> {
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(resolve(PDFS, filename))))
  const pages = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const { height } = page.getViewport({ scale: 1 })
    const items = (await page.getTextContent()).items
      .flatMap(item => ('str' in item && item.str.trim() ? [{ str: item.str.trim(), y: item.transform[5] as number }] : []))
    pages.push({
      top: items.filter(i => i.y > height * (1 - BAND)).map(i => i.str).join(' ').replace(/\s+/g, ' '),
      // Folios: the bottom band (the AI RMF prints "Page 4" a little above it).
      bottom: items.filter(i => i.y < height * 0.12).map(i => i.str),
    })
  }
  return pages
}

describe('the corpus table matches the PDFs', () => {
  it.each(DOCUMENTS)('%s: printed page numbers and running heads', async (filename) => {
    const info = documentInfo(filename)
    const pages = await margins(filename)
    expect(info.printed?.at(-1)?.to).toBeLessThanOrEqual(pages.length)
    pages.forEach(({ top, bottom }, i) => {
      const printed = printedPage(filename, i + 1)
      const folio = folioOf(filename, i + 1)
      // A page with a number prints exactly that folio; a page without one prints none.
      if (folio) expect(bottom, `p. ${i + 1}`).toContain(folio)
      else expect(bottom.filter(s => /^(?:Page )?(?:\d+|[ivx]+)$/.test(s)), `p. ${i + 1}`).toEqual([])
      if (top && printed !== undefined) expect(info.runningHead, `p. ${i + 1}`).toContain(top)
    })
  })
})

describe('pageName', () => {
  it('names the printed page first, then the PDF page when they differ', () => {
    expect(pageName('nist-csf-2.0.pdf', 28)).toEqual({ text: 'p. 23 (PDF 28)', spoken: 'page 23 (PDF page 28)' })
    expect(pageName('nist-csf-2.0.pdf', 5)).toEqual({ text: 'p. iv (PDF 5)', spoken: 'page iv (PDF page 5)' })
  })

  it('gives one number when the printed page is the PDF page', () => {
    expect(pageName('raptor.pdf', 3)).toEqual({ text: 'p. 3', spoken: 'page 3' })
  })

  it('says "PDF page" when no printed number is known', () => {
    expect(pageName('nist-csf-2.0.pdf', 1)).toEqual({ text: 'PDF p. 1', spoken: 'PDF page 1' })
    expect(pageName('upload.pdf', 12)).toEqual({ text: 'PDF p. 12', spoken: 'PDF page 12' })
    expect(pageName('raptor.pdf', null)).toEqual({ text: 'p. ?', spoken: 'page unknown' })
  })

  it('names a source by its short title', () => {
    expect(sourceName({ filename: 'nist-ai-rmf-1.0.pdf', pageNumber: 9 })).toBe('NIST AI RMF 1.0, page 4 (PDF page 9)')
    expect(sourceName({ filename: 'upload.pdf', pageNumber: 2 })).toBe('upload.pdf, PDF page 2')
  })
})

describe('passageText', () => {
  const rect = (y: number) => ({ x1: 0, y1: y - 5, x2: 100, y2: y + 5 })
  const highlight = (...ys: number[]) => ({ rects: ys.map(rect), pageHeight: 1000 })

  it('drops the running head and the folio read right after it', () => {
    const content = 'NIST CSWP 29 The NIST Cybersecurity Framework (CSF) 2.0 February 26, 2024 5 Fig. 2. CSF Functions'
    expect(passageText({ filename: 'nist-csf-2.0.pdf', pageNumber: 10, content, highlight: highlight(970, 500, 20) }))
      .toBe('Fig. 2. CSF Functions')
    expect(passageText({ filename: 'nist-csf-2.0.pdf', pageNumber: 10, content, highlight: null })).toBe('Fig. 2. CSF Functions')
  })

  it('drops a trailing folio only when a line sits in the bottom margin', () => {
    const content = 'a mixture of several Gaussian distributions. 3'
    expect(passageText({ filename: 'raptor.pdf', pageNumber: 3, content, highlight: highlight(500, 20) }))
      .toBe('…a mixture of several Gaussian distributions.')
    expect(passageText({ filename: 'raptor.pdf', pageNumber: 3, content, highlight: highlight(500, 480) })).toBe(`…${content}`)
    expect(passageText({ filename: 'raptor.pdf', pageNumber: 3, content, highlight: null })).toBe(`…${content}`)
  })

  it('keeps a head-like start that is not in the top margin', () => {
    const content = 'Preprint. Type Input Output'
    expect(passageText({ filename: 'self-rag.pdf', pageNumber: 4, content, highlight: highlight(500) })).toBe(content)
    expect(passageText({ filename: 'self-rag.pdf', pageNumber: 4, content, highlight: highlight(980, 500) })).toBe('Type Input Output')
  })

  it('drops a head glued to the folio and the figure text before a caption', () => {
    // RAPTOR p. 2, as stored: the head runs into the folio and Figure 1's labels.
    const content = 'Published as a conference paper at ICLR 20242 3 4 51 1 23 34 55 6 87 Index #8 Text: summary of nodes 2 and 3 Child Nodes: 2, 3 Text Embedding Text chunks 3 .1 4 .1 5 2. Summarization by LLM 1. Clustering 10 7 1 2 8 43 5 6 9 Formation of one tree layer Root layer Leaf layer Contents of a nodeRAPTOR Tree Figure 1: Tree construction process: RAPTOR recursively clusters chunks of text.'
    expect(passageText({ filename: 'raptor.pdf', pageNumber: 2, content, highlight: highlight(960, 500) }))
      .toBe('Figure 1: Tree construction process: RAPTOR recursively clusters chunks of text.')
  })

  it('keeps prose that leads into a caption', () => {
    const content = 'The results in 2023 improved on all 3 tasks, as Table 2. shows for each model.'
    expect(passageText({ filename: 'raptor.pdf', pageNumber: 5, content, highlight: highlight(500) })).toBe(content)
  })

  it('marks a passage that starts mid-sentence', () => {
    expect(passageText({ filename: 'nist-csf-2.0.pdf', pageNumber: 9, content: 'NIST CSWP 29 The NIST Cybersecurity Framework (CSF) 2.0 February 26, 2024 4 improvement opportunities for the organization', highlight: highlight(970, 500) }))
      .toBe('…improvement opportunities for the organization')
  })

  it('leaves unknown documents and furniture-only chunks as they are', () => {
    expect(passageText({ filename: 'upload.pdf', pageNumber: 1, content: 'Preprint. Text', highlight: null })).toBe('Preprint. Text')
    expect(passageText({ filename: 'self-rag.pdf', pageNumber: 4, content: 'Preprint.', highlight: null })).toBe('Preprint.')
  })
})
