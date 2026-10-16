import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { extractText, getDocumentProxy } from 'unpdf'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

// Guards the golden dataset (docs/golden/golden.json): schema, and that every
// evidence quote is an exact substring of its page's extracted text. The
// highlight E2E tests and evals rely on that, so a quote that drifts from the
// PDF must fail here, not silently in Phase 5/9.

const GOLDEN_DIR = resolve(__dirname, '../../docs/golden')

const evidenceSchema = z.object({
  document: z.string().regex(/\.pdf$/),
  page: z.number().int().positive(),
  text: z.string().min(1),
})

const recordSchema = z
  .object({
    id: z.string().regex(/^g-\d{3}$/),
    question: z.string().min(1),
    answer: z.string().min(1).nullable(),
    evidence: z.array(evidenceSchema),
    tags: z.array(z.string()).default([]),
  })
  .refine(r => (r.answer === null) === (r.evidence.length === 0), {
    message: 'unanswerable records (answer: null) must have no evidence; answerable ones need at least one',
  })

const goldenSchema = z.array(recordSchema).min(30).max(50)

/** Same whitespace normalization the ingestion pipeline must apply. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

let golden: z.infer<typeof goldenSchema>
const pages = new Map<string, string[]>()

beforeAll(async () => {
  golden = goldenSchema.parse(JSON.parse(await readFile(resolve(GOLDEN_DIR, 'golden.json'), 'utf8')))

  const documents = new Set(golden.flatMap(r => r.evidence.map(e => e.document)))
  for (const document of documents) {
    const path = resolve(GOLDEN_DIR, 'pdfs', document)
    if (!existsSync(path)) continue
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)))
    const { text } = await extractText(pdf, { mergePages: false })
    pages.set(document, text.map(normalize))
  }
}, 60_000)

describe('golden dataset', () => {
  it('has unique ids', () => {
    const ids = golden.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('references only PDFs that exist in docs/golden/pdfs', () => {
    const missing = [...new Set(golden.flatMap(r => r.evidence.map(e => e.document)))].filter(d => !pages.has(d))
    expect(missing).toEqual([])
  })

  it('includes unanswerable and ambiguous questions', () => {
    expect(golden.filter(r => r.answer === null).length).toBeGreaterThanOrEqual(3)
    expect(golden.filter(r => r.tags.includes('ambiguous')).length).toBeGreaterThanOrEqual(3)
  })

  it('quotes every evidence span verbatim from its page', () => {
    const failures = golden.flatMap(r =>
      r.evidence
        .filter((e) => {
          const pageText = pages.get(e.document)?.[e.page - 1]
          return pageText === undefined || !pageText.includes(normalize(e.text))
        })
        .map(e => `${r.id}: ${e.document} p.${e.page}: "${e.text.slice(0, 60)}…"`),
    )
    expect(failures).toEqual([])
  })
})
