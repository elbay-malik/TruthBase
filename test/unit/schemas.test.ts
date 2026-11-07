import { describe, expect, it } from 'vitest'
import { chatRequestSchema, documentParamsSchema, searchRequestSchema } from '../../shared/schemas'

describe('searchRequestSchema', () => {
  it('applies the default topK', () => {
    const parsed = searchRequestSchema.parse({ query: 'what is RRF?' })
    expect(parsed.topK).toBe(10)
  })

  it('rejects an empty query', () => {
    expect(searchRequestSchema.safeParse({ query: '' }).success).toBe(false)
  })

  it('caps topK at the RPC\'s 30 rows', () => {
    expect(searchRequestSchema.safeParse({ query: 'x', topK: 30 }).success).toBe(true)
    expect(searchRequestSchema.safeParse({ query: 'x', topK: 31 }).success).toBe(false)
  })
})

describe('chatRequestSchema', () => {
  it('accepts a question and trims it', () => {
    expect(chatRequestSchema.parse({ question: '  What is RRF?  ' })).toEqual({ question: 'What is RRF?' })
  })

  it('rejects an empty or whitespace-only question', () => {
    expect(chatRequestSchema.safeParse({ question: '   ' }).success).toBe(false)
  })

  it('caps the question length', () => {
    expect(chatRequestSchema.safeParse({ question: 'x'.repeat(1001) }).success).toBe(false)
  })

  it('only accepts a uuid documentId', () => {
    expect(chatRequestSchema.safeParse({ question: 'q', documentId: 'nope' }).success).toBe(false)
    expect(chatRequestSchema.safeParse({ question: 'q', documentId: '0b2a3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d' }).success).toBe(true)
  })
})

describe('documentParamsSchema', () => {
  const id = '0b2a3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'

  it('accepts the canonical lower-case uuid', () => {
    expect(documentParamsSchema.parse({ id })).toEqual({ id })
  })

  it('rejects any other spelling of the same uuid, and non-uuids', () => {
    for (const value of [id.toUpperCase(), id.replace('a', 'A'), `{${id}}`, id.replaceAll('-', ''), 'nope', '']) {
      expect(documentParamsSchema.safeParse({ id: value }).success, value).toBe(false)
    }
  })
})
