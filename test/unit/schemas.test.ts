import { describe, expect, it } from 'vitest'
import { chatRequestSchema, searchRequestSchema } from '../../shared/schemas'

describe('searchRequestSchema', () => {
  it('applies the default topK', () => {
    const parsed = searchRequestSchema.parse({ query: 'what is RRF?' })
    expect(parsed.topK).toBe(10)
  })

  it('rejects an empty query', () => {
    expect(searchRequestSchema.safeParse({ query: '' }).success).toBe(false)
  })

  it('caps topK at 50', () => {
    expect(searchRequestSchema.safeParse({ query: 'x', topK: 51 }).success).toBe(false)
  })
})

describe('chatRequestSchema', () => {
  it('requires at least one message', () => {
    expect(chatRequestSchema.safeParse({ messages: [] }).success).toBe(false)
  })

  it('accepts a valid user message', () => {
    const result = chatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown roles', () => {
    const result = chatRequestSchema.safeParse({
      messages: [{ role: 'tool', content: 'hi' }],
    })
    expect(result.success).toBe(false)
  })
})
