import { z } from 'zod'

const chatRequestSchema = z.object({
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

// Phase 4 (docs/EXECUTION_PLAN.md): embed query → hybrid RRF retrieval →
// rerank → grounded streamText with citation source parts.
export default defineEventHandler(async (event) => {
  await readValidatedBody(event, chatRequestSchema.parse)

  throw createError({
    statusCode: 501,
    statusMessage: 'Not Implemented',
    message: 'The chat endpoint lands in Phase 4.',
  })
})
