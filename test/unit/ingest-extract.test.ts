import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { extractText, getDocumentProxy } from 'unpdf'
import { describe, expect, it } from 'vitest'
import { extractPages, normalizePage, type PositionedItem } from '../../server/ingest/extract'

const PDFS = resolve(__dirname, '../../docs/golden/pdfs')
const DOCUMENTS = ['nist-ai-rmf-1.0.pdf', 'nist-csf-2.0.pdf', 'self-rag.pdf', 'raptor.pdf']

const item = (str: string, hasEOL = false): PositionedItem =>
  ({ str, x: 0, y: 0, width: 0, height: 0, fontSize: 10, hasEOL })

describe('normalizePage', () => {
  it('collapses whitespace, turns line ends into spaces, and trims', () => {
    const page = normalizePage([item('  Risk  is', true), item('a measure. '), item('', true), item('End ')])
    expect(page.text).toBe('Risk is a measure. End')
  })

  it('maps every non-space character back to its item and offset', () => {
    const page = normalizePage([item('ab', true), item(' cd')])
    expect(page.text).toBe('ab cd')
    expect([...page.charItem]).toEqual([0, 0, -1, 1, 1])
    expect([...page.charOffset]).toEqual([0, 1, -1, 1, 2])
  })
})

describe('extractPages on the golden PDFs', () => {
  it.each(DOCUMENTS)('%s: text matches the golden contract and maps back to items', async (document) => {
    const data = await readFile(resolve(PDFS, document))
    const pages = await extractPages(new Uint8Array(data))
    const { text: reference } = await extractText(await getDocumentProxy(new Uint8Array(data)), { mergePages: false })

    expect(pages.map(p => p.text)).toEqual(reference.map(t => t.replace(/\s+/g, ' ').trim()))
    for (const page of pages) {
      expect(page.width).toBeGreaterThan(0)
      for (let i = 0; i < page.text.length; i++) {
        const itemIndex = page.charItem[i]!
        if (itemIndex === -1) expect(page.text[i]).toBe(' ')
        else expect(page.items[itemIndex]!.str[page.charOffset[i]!]).toBe(page.text[i])
      }
    }
  }, 30_000)
})
