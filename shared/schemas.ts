import { z } from 'zod'

// API request contracts. Server routes validate against these; the client
// can reuse them for form validation. Import via the #shared alias.

/**
 * POST /api/chat. Single-turn by design (Phase 4): every question is answered
 * only from the sources retrieved for it, so the client sends the question,
 * not the conversation.
 */
export const chatRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  documentId: z.uuid().optional(),
})

export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  documentId: z.uuid().optional(),
  topK: z.number().int().positive().max(50).default(10),
})

export type ChatRequest = z.infer<typeof chatRequestSchema>
export type SearchRequest = z.infer<typeof searchRequestSchema>

/** Route params for /api/documents/:id/* — validated before any DB query. */
export const documentParamsSchema = z.object({
  id: z.uuid(),
})

export type DocumentParams = z.infer<typeof documentParamsSchema>
