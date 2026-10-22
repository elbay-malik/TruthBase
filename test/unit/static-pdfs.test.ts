import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STATIC_PDFS, staticPdfUrl, takesCorpusName } from '../../server/utils/static-pdfs'

const PDFS = new URL('../../docs/golden/pdfs/', import.meta.url)
const published = readdirSync(PDFS).filter(name => name.endsWith('.pdf'))

describe('staticPdfUrl', () => {
  it('knows exactly the files published from docs/golden/pdfs', () => {
    expect([...STATIC_PDFS].sort()).toEqual([...published].sort())
  })

  it('gives a corpus PDF its same-origin URL, and any other file none', () => {
    expect(staticPdfUrl('nist-csf-2.0.pdf')).toBe('/pdfs/nist-csf-2.0.pdf')
    expect(staticPdfUrl('uploaded.pdf')).toBeUndefined()
    expect(staticPdfUrl('../nist-csf-2.0.pdf')).toBeUndefined()
  })
})

describe('takesCorpusName', () => {
  it('lets each corpus file keep its own name: the hashes match the published files', () => {
    for (const name of published) expect(takesCorpusName(name, readFileSync(new URL(name, PDFS))), name).toBe(false)
  })

  it('stops another PDF from taking a corpus name, and leaves other names alone', () => {
    const other = readFileSync(new URL('self-rag.pdf', PDFS))
    expect(takesCorpusName('raptor.pdf', other)).toBe(true)
    expect(takesCorpusName('raptor-v2.pdf', other)).toBe(false)
  })
})
