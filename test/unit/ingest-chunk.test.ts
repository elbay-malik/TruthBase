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
    if (i > 0) expect(c.end).toBeGreaterThan(chunks[i - 1]!.end) // never a subset of the previous chunk
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

  it('never emits a chunk contained in the previous one when overlap cannot fit', () => {
    // Overlap would pull the next chunk back to "Bbbb…", but "Bbbb… Cccc…" exceeds maxChars.
    const text = `${'A'.repeat(20)}. ${'B'.repeat(15)}. ${'C'.repeat(50)}.`
    const chunks = chunkPage(text, { maxChars: 60, overlapChars: 20, minChars: 5 })
    expectWellFormed(text, chunks, 60 + 5)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.end).toBeGreaterThan(chunks[i - 1]!.end)
  })

  it('ends CJK sentences at 。！？ without a following space, and overlaps them', () => {
    const sentence = (ch: string) => `${ch.repeat(20)}。`
    const text = `${sentence('一')}${sentence('二')}「${'三'.repeat(19)}！」${sentence('四')}`
    const chunks = chunkPage(text, { ...opts, overlapChars: 30 })
    expectWellFormed(text, chunks, opts.maxChars + opts.minChars)
    expect(chunks.map(c => text.slice(c.start, c.end))).toEqual([
      `${sentence('一')}${sentence('二')}`,
      `${sentence('二')}「${'三'.repeat(19)}！」`,
      `「${'三'.repeat(19)}！」${sentence('四')}`,
    ])
  })

  it('hard-cuts a token longer than maxChars instead of looping', () => {
    const text = 'x'.repeat(150)
    expectWellFormed(text, chunkPage(text, opts), opts.maxChars + opts.minChars)
  })

  it('fills a chunk up to exactly maxChars and splits one character later', () => {
    const exact = `${'A'.repeat(29)}. ${'B'.repeat(28)}.` // 30 + 1 + 29 = 60
    expect(chunkPage(exact, opts)).toEqual([{ start: 0, end: 60 }])
    const over = `${'A'.repeat(29)}. ${'B'.repeat(29)}.` // 61: the 30-char sentence exceeds the overlap budget
    expect(chunkPage(over, opts)).toEqual([{ start: 0, end: 30 }, { start: 31, end: 61 }])
  })

  it('merges a tail shorter than minChars into the previous chunk, but not one of exactly minChars', () => {
    const noOverlap = { ...opts, overlapChars: 0 }
    const short = `${'A'.repeat(50)}. ${'B'.repeat(8)}.` // tail of 9 chars
    expect(chunkPage(short, noOverlap)).toEqual([{ start: 0, end: 61 }])
    const kept = `${'A'.repeat(50)}. ${'B'.repeat(9)}.` // tail of 10 chars
    expect(chunkPage(kept, noOverlap)).toEqual([{ start: 0, end: 51 }, { start: 52, end: 62 }])
  })

  it('keeps a page shorter than minChars as its only chunk', () => {
    expect(chunkPage('Hi.', opts)).toEqual([{ start: 0, end: 3 }])
    expect(chunkPage('x', opts)).toEqual([{ start: 0, end: 1 }])
  })

  it('emits back-to-back chunks without overlap when overlapChars is 0', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} ends here.`).join(' ')
    const chunks = chunkPage(text, { ...opts, overlapChars: 0 })
    expectWellFormed(text, chunks, opts.maxChars + opts.minChars)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end + 1)
  })

  it('keeps a closing quote or bracket with its sentence', () => {
    // maxChars 20 leaves room for one more word, so a word-boundary split
    // (sentence end missed) would differ from sentence packing.
    const one = { maxChars: 20, overlapChars: 0, minChars: 0 }
    const quoted = 'He said "stop." Then left.'
    expect(chunkPage(quoted, one).map(c => quoted.slice(c.start, c.end))).toEqual(['He said "stop."', 'Then left.'])
    const bracketed = '(See note one.) Next one.'
    expect(chunkPage(bracketed, one).map(c => bracketed.slice(c.start, c.end))).toEqual(['(See note one.)', 'Next one.'])
  })

  it('packs abbreviation and decimal false sentence ends back into one chunk', () => {
    const text = 'See e.g. Table 2.1 by Smith et al. for details.'
    expect(chunkPage(text, opts)).toEqual([{ start: 0, end: text.length }])
  })

  // Seeded, so failures reproduce: mixed Latin / CJK / over-long tokens under
  // random options must always satisfy the invariants.
  it('stays well-formed on randomized pages and options', () => {
    let seed = 0x13
    const random = () => { // mulberry32
      seed = (seed + 0x6D2B79F5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1))
    const pick = <T>(xs: T[]) => xs[int(0, xs.length - 1)]!
    const word = () => 'abcdefghij'.slice(0, int(1, 10)).repeat(random() < 0.02 ? 30 : 1)
    const sentence = () => random() < 0.25
      ? `${'漢字かな'.repeat(int(1, 15))}${pick(['。', '！', '？」'])}`
      : `${Array.from({ length: int(1, 25) }, word).join(' ')}${pick(['.', '!', '?', '."', '.)', ''])}`

    for (let run = 0; run < 300; run++) {
      const text = Array.from({ length: int(1, 30) }, sentence).reduce((acc, s) => acc + (acc && random() < 0.8 ? ' ' : '') + s, '')
      const maxChars = int(20, 300)
      const options = { maxChars, overlapChars: int(0, maxChars), minChars: int(0, Math.floor(maxChars / 3)) }
      const chunks = chunkPage(text, options)
      expectWellFormed(text, chunks, maxChars + options.minChars)
      for (const c of chunks.slice(0, -1)) expect(c.end - c.start).toBeLessThanOrEqual(maxChars)
    }
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
