import { createUIMessageStream, createUIMessageStreamResponse, streamText, toUIMessageStream } from 'ai'
import { chatRequestSchema } from '#shared/schemas'
import { NO_ANSWER, type ChatMessage } from '#shared/types/chat'
import { geminiEmbedder } from '../ingest/embed'
import { chatModel, configuredTaskModel, isFallbackError } from '../rag/model'
import { buildPrompt, GROUNDING_INSTRUCTIONS } from '../rag/prompt'
import { configuredReranker } from '../rag/rerank'
import { retrieveSources } from '../rag/retrieve'

// POST /api/chat { question, documentId? } → UI message stream (AI SDK v7):
//   data-sources  numbered sources [1..k] with chunk id, document, page and
//                 stored highlight rects (citation chips; Phase 5 highlights)
//   text          grounded answer citing [n], or exactly NO_ANSWER
// Retrieval: Gemini query embedding → hybrid RRF search, plus multi-query
// rewrites of an ambiguous question fused with RRF (ADR-0009) → LLM rerank of
// the fused top 15 (ADR-0007) → top 8; each LLM step is skipped on failure. Generation:
// Groq gpt-oss-120b with Gemini fallback (server/rag/model.ts), temperature 0.
// A client disconnect (Stop, closed tab) aborts the embedding and LLM calls.

export default defineEventHandler(async (event) => {
  const { question, documentId } = await readValidatedBody(event, chatRequestSchema.parse)
  const config = useRuntimeConfig(event)
  if (!config.geminiApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'Query embeddings are not configured (set NUXT_GEMINI_API_KEY).' })
  }
  const { model, id: modelId, providerOptions } = chatModel({ groqApiKey: config.groqApiKey, geminiApiKey: config.geminiApiKey })
  const supabase = serverSupabase()

  // The request body is already consumed, so watch the response side: it
  // closes early when the client goes away.
  const abort = new AbortController()
  event.node.res.on('close', () => {
    if (!event.node.res.writableFinished) abort.abort()
  })

  const onError = (error: unknown) => {
    if (abort.signal.aborted) return 'Answer cancelled.'
    console.error(`[chat] ${modelId}`, error)
    return isFallbackError(error)
      ? 'The answer service is busy right now. Please try again in a minute.'
      : 'Something went wrong while answering. Please try again.'
  }

  const stream = createUIMessageStream<ChatMessage>({
    execute: async ({ writer }) => {
      const { sources } = await retrieveSources(
        supabase,
        geminiEmbedder(config.geminiApiKey, 'RETRIEVAL_QUERY', abort.signal),
        question,
        { documentId, expander: configuredTaskModel(config, config.expandModel), reranker: configuredReranker(config), abortSignal: abort.signal },
      )
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
        // withFallback already switches provider on 429/5xx; one more round
        // after the SDK's backoff is enough before telling the user.
        maxRetries: 1,
        providerOptions,
        abortSignal: abort.signal,
      })
      // Generation errors surface here, not in createUIMessageStream's onError.
      writer.merge(toUIMessageStream({ stream: result.stream, onError }))
    },
    onError,
  })
  return createUIMessageStreamResponse({ stream })
})
