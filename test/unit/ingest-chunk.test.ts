import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { chunkPage, DEFAULT_CHUNK_OPTIONS, type ChunkSpan } from '../../server/ingest/chunk'
import { extractPages, type PageLayout } from '../../server/ingest/extract'

const GOLDEN = resolve(__dirname, '../../docs/golden')

/** Invariants every chunking must satisfy, whatever the text. */
function expectWellFormed(text: string, chunks: ChunkSpan[], maxLength: number) {
  let coveredUpTo = 0
  for (const [i, c] of chunks.entries()) {
    expect(c.end).toBeGreaterThan(c.start)
    expect(c.end - c.start).toBeLessThanOrEqual(maxLength)
    expect(text[c.start]).not.toBe(' ')
    expect(text[c.end - 1]).not.toBe(' ')
    if (i > 0) expect(c.start).toBeGreaterThan(chunks[i - 1]!.start) // progress
    // No gap: the next chunk starts at or before the previous end (+ separator space).
    expect(c.start).toBeLessThanOrEqual(coveredUpTo + 1)
    coveredUpTo = Math.max(coveredUpTo, c.end)
  }
  expect(chunks[0]?.start ?? 0).toBe(0)
  expect(coveredUpTo).toBe(text.length)
}

describe('chunkPage', () => {
  const opts = { maxChars: 60, overlapChars: 20, minChars: 10 }

  it('returns no chunks for an empty page and one for a short page', () => {
    expect(chunkPage('', opts)).toEqual([])
    expect(chunkPage('Short page.', opts)).toEqual([{ start: 0, end: 11 }])
  })

  it('packs whole sentences and overlaps the trailing one', () => {
    const text = 'First sentence is here. Second sentence is here. Third sentence is here.'
    const chunks = chunkPage(text, { ...opts, overlapChars: 30 })
    expect(chunks.map(c => text.slice(c.start, c.end))).toEqual([
      'First sentence is here. Second sentence is here.',
      'Second sentence is here. Third sentence is here.',
    ])
  })

  it('only overlaps whole sentences that fit the overlap budget', () => {
    const text = 'First sentence is here. Second sentence is here. Third sentence is here.'
    const chunks = chunkPage(text, opts) // 24-char sentence > 20-char budget
    expect(chunks.map(c => text.slice(c.start, c.end))).toEqual([
      'First sentence is here. Second sentence is here.',
      'Third sentence is here.',
    ])
  })

  it('splits an over-long sentence at word boundaries', () => {
    const text = 'word '.repeat(40).trim()
    const chunks = chunkPage(text, opts)
    expectWellFormed(text, chunks, opts.maxChars + opts.minChars)
    for (const c of chunks) expect(text.slice(c.start, c.end)).toMatch(/^word( word)*$/)
  })

  it('hard-cuts a token longer than maxChars instead of looping', () => {
    const text = 'x'.repeat(150)
    expectWellFormed(text, chunkPage(text, opts), opts.maxChars + opts.minChars)
  })
})

describe('chunkPage on the golden PDFs (default options)', () => {
  const pages = new Map<string, PageLayout[]>()
  let golden: { answer: string | null, evidence: { document: string, page: number, text: string }[] }[]

  beforeAll(async () => {
    golden = JSON.parse(await readFile(resolve(GOLDEN, 'golden.json'), 'utf8'))
    for (const document of new Set(golden.flatMap(r => r.evidence.map(e => e.document)))) {
      pages.set(document, await extractPages(new Uint8Array(await readFile(resolve(GOLDEN, 'pdfs', document)))))
    }
  }, 60_000)

  it('produces well-formed chunks on every page', () => {
    for (const layouts of pages.values()) {
      for (const page of layouts) {
        expectWellFormed(page.text, chunkPage(page.text), DEFAULT_CHUNK_OPTIONS.maxChars + DEFAULT_CHUNK_OPTIONS.minChars)
      }
    }
  })

  // The ADR-0003 sizing criterion: a span split across chunks cannot be cited
  // or highlighted as one passage.
  it('keeps every golden evidence span inside a single chunk', () => {
    const split = golden.flatMap(r => r.evidence).filter((e) => {
      const page = pages.get(e.document)![e.page - 1]!
      const at = page.text.indexOf(e.text)
      return !chunkPage(page.text).some(c => c.start <= at && at + e.text.length <= c.end)
    })
    expect(split.map(e => `${e.document} p.${e.page}: ${e.text.slice(0, 50)}`)).toEqual([])
  })
})
