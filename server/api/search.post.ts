import { z } from 'zod'

const searchRequestSchema = z.object({
  query: z.string().min(1),
  documentId: z.string().optional(),
  topK: z.number().int().positive().max(50).default(10),
})

// Phase 2/6 (docs/EXECUTION_PLAN.md): hybrid pgvector + tsvector retrieval
// fused by the RRF SQL RPC on Supabase.
export default defineEventHandler(async (event) => {
  await readValidatedBody(event, searchRequestSchema.parse)

  throw createError({
    statusCode: 501,
    statusMessage: 'Not Implemented',
    message: 'The search endpoint lands with the Phase 2 database schema.',
  })
})
