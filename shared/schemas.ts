import { z } from 'zod'
import { MAX_QUESTION_LENGTH } from './limits'

// API request contracts. Server routes validate against these. The client
// imports plain limits from ./limits instead, to keep zod out of its bundle.

/**
 * POST /api/chat. Single-turn by design (Phase 4): every question is answered
 * only from the sources retrieved for it, so the client sends the question,
 * not the conversation.
 */
export const chatRequestSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  documentId: z.uuid().optional(),
})

export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  documentId: z.uuid().optional(),
  // hybrid_search_bge_m3 returns at most 30 rows (its RRF candidate pool).
  topK: z.number().int().positive().max(30).default(10),
})

export type ChatRequest = z.infer<typeof chatRequestSchema>
export type SearchRequest = z.infer<typeof searchRequestSchema>

/**
 * Route params for /api/chunks/:id and /api/documents/:id/* — validated
 * before any DB query. Only the canonical lower-case spelling is accepted:
 * Postgres compares uuids case-insensitively, so each spelling of one id
 * would otherwise be a separate cache entry and URL for the same row.
 */
export const documentParamsSchema = z.object({
  id: z.uuid().lowercase(),
})

export type DocumentParams = z.infer<typeof documentParamsSchema>
