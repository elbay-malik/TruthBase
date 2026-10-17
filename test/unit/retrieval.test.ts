import { describe, expect, it } from 'vitest'
import { toSearchHit } from '../../server/rag/search'

describe('toSearchHit', () => {
  it('maps a hybrid_search row from snake_case to the app shape', () => {
    const hit = toSearchHit({
      id: 'c1',
      document_id: 'd1',
      page_number: 28,
      content: 'RC.RP-03: The integrity of backups …',
      highlight: null,
      created_at: '2026-10-16T19:00:00Z',
      score: 1 / 51 + 1 / 52,
    })

    expect(hit).toEqual({
      id: 'c1',
      documentId: 'd1',
      pageNumber: 28,
      content: 'RC.RP-03: The integrity of backups …',
      highlight: null,
      createdAt: '2026-10-16T19:00:00Z',
      score: 1 / 51 + 1 / 52,
    })
  })
})
