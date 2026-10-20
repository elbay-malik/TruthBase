import { propagateAttributes, startActiveObservation, type LangfuseAgent } from '@langfuse/tracing'
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
//
// Tracing (Phase 10): each request is one Langfuse trace, an `agent` root
// observation that stays open until the answer stream ends, with retrieval
// and every model call nested in it. It records the answer and the time to
// first token (ttftMs) the SPEC targets. No-ops when tracing is off.

export default defineEventHandler(async (event) => {
  const startedAt = performance.now()
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

  const expander = configuredTaskModel(config, config.expandModel)
  const reranker = configuredReranker(config)
  const ms = () => Math.round(performance.now() - startedAt)

  return propagateAttributes({
    traceName: 'chat',
    tags: ['chat'],
    metadata: { answerModel: modelId, expander: expander?.id ?? 'off', reranker: reranker?.id ?? 'off', filtered: documentId ? 'yes' : 'no' },
  }, () => startActiveObservation('chat', (root) => {
    root.update({ input: { question, documentId } })
    const trace = endOnce(root)

    const onError = (error: unknown) => {
      if (abort.signal.aborted) {
        trace.end({ level: 'WARNING', statusMessage: 'client disconnected', metadata: { totalMs: ms() } })
        return 'Answer cancelled.'
      }
      console.error(`[chat] ${modelId}`, error)
      trace.end({ level: 'ERROR', statusMessage: String(error).slice(0, 500), metadata: { totalMs: ms() } })
      return isFallbackError(error)
        ? 'The answer service is busy right now. Please try again in a minute.'
        : 'Something went wrong while answering. Please try again.'
    }

    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer }) => {
        const { sources, rewrites, reranked } = await retrieveSources(
          supabase,
          geminiEmbedder(config.geminiApiKey, 'RETRIEVAL_QUERY', abort.signal),
          question,
          { documentId, expander, reranker, abortSignal: abort.signal },
        )
        const retrieval = { retrievalMs: ms(), sources: sources.length, rewrites: rewrites.length, reranked }
        writer.write({ type: 'data-sources', data: { sources } })

        if (sources.length === 0) {
          // Nothing indexed to answer from: refuse without spending an LLM call.
          writer.write({ type: 'text-start', id: 'refusal' })
          writer.write({ type: 'text-delta', id: 'refusal', delta: NO_ANSWER })
          writer.write({ type: 'text-end', id: 'refusal' })
          trace.end({ output: NO_ANSWER, metadata: { ...retrieval, totalMs: ms() } })
          return
        }

        let ttftMs: number | undefined
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
          onChunk: ({ chunk }) => {
            if (ttftMs === undefined && chunk.type === 'text-delta') ttftMs = ms()
          },
          onFinish: ({ text }) => trace.end({ output: text, metadata: { ...retrieval, ttftMs, totalMs: ms() } }),
          onAbort: () => trace.end({ level: 'WARNING', statusMessage: 'client disconnected', metadata: { ...retrieval, ttftMs, totalMs: ms() } }),
        })
        // Generation errors surface here, not in createUIMessageStream's onError.
        writer.merge(toUIMessageStream({ stream: result.stream, onError }))
      },
      onError,
    })
    return createUIMessageStreamResponse({ stream })
  }, { asType: 'agent', endOnExit: false }))
})

/** Ends the root observation once, whichever of finish, error or abort comes first. */
function endOnce(root: LangfuseAgent) {
  let ended = false
  return {
    end(attributes: Parameters<LangfuseAgent['update']>[0]) {
      if (ended) return
      ended = true
      root.update(attributes).end()
    },
  }
}
