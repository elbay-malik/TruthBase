import { z } from 'zod'

// API request contracts. Server routes validate against these; the client
// can reuse them for form validation. Import via the #shared alias.

export const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1),
      }),
    )
    .min(1),
  documentId: z.string().optional(),
})

export const searchRequestSchema = z.object({
  query: z.string().min(1),
  documentId: z.string().optional(),
  topK: z.number().int().positive().max(50).default(10),
})

export type ChatRequest = z.infer<typeof chatRequestSchema>
export type SearchRequest = z.infer<typeof searchRequestSchema>

/** Route params for /api/documents/:id/* — validated before any DB query. */
export const documentParamsSchema = z.object({
  id: z.uuid(),
})

export type DocumentParams = z.infer<typeof documentParamsSchema>
