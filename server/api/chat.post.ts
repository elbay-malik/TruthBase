import { createUIMessageStream, createUIMessageStreamResponse, streamText, toUIMessageStream } from 'ai'
import { chatRequestSchema } from '#shared/schemas'
import { NO_ANSWER, type ChatMessage } from '#shared/types/chat'
import { geminiEmbedder } from '../ingest/embed'
import { chatModel } from '../rag/model'
import { buildPrompt, GROUNDING_INSTRUCTIONS } from '../rag/prompt'
import { retrieveSources } from '../rag/retrieve'

// POST /api/chat { question, documentId? } → UI message stream (AI SDK v7):
//   data-sources  numbered sources [1..k] with chunk id, document, page and
//                 stored highlight rects (citation chips; Phase 5 highlights)
//   text          grounded answer citing [n], or exactly NO_ANSWER
// Retrieval: Gemini query embedding → hybrid RRF search (top 8). Generation:
// Groq or Gemini (server/rag/model.ts), temperature 0, grounding prompt.

export default defineEventHandler(async (event) => {
  const { question, documentId } = await readValidatedBody(event, chatRequestSchema.parse)
  const config = useRuntimeConfig(event)
  if (!config.geminiApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'Query embeddings are not configured (set NUXT_GEMINI_API_KEY).' })
  }
  const { model, id: modelId, providerOptions } = chatModel({ groqApiKey: config.groqApiKey, geminiApiKey: config.geminiApiKey })
  const supabase = serverSupabase()

  const stream = createUIMessageStream<ChatMessage>({
    execute: async ({ writer }) => {
      const sources = await retrieveSources(supabase, geminiEmbedder(config.geminiApiKey, 'RETRIEVAL_QUERY'), question, { documentId })
      writer.write({ type: 'data-sources', data: { sources } })

      if (sources.length === 0) {
        // Nothing indexed to answer from: refuse without spending an LLM call.
        writer.write({ type: 'text-start', id: 'refusal' })
        writer.write({ type: 'text-delta', id: 'refusal', delta: NO_ANSWER })
        writer.write({ type: 'text-end', id: 'refusal' })
        return
      }

      const result = streamText({
        model,
        instructions: GROUNDING_INSTRUCTIONS,
        prompt: buildPrompt(question, sources),
        temperature: 0,
        maxOutputTokens: 700,
        providerOptions,
      })
      writer.merge(toUIMessageStream({ stream: result.stream }))
    },
    onError: (error) => {
      console.error(`[chat] ${modelId}`, error)
      return 'Something went wrong while answering. Please try again.'
    },
  })
  return createUIMessageStreamResponse({ stream })
})
