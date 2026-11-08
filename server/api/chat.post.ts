import { propagateAttributes, startActiveObservation, type LangfuseAgent } from '@langfuse/tracing'
import { createUIMessageStream, createUIMessageStreamResponse, streamText, toUIMessageStream, type ToolSet } from 'ai'
import { chatRequestSchema } from '#shared/schemas'
import { TURNSTILE_CHAT_ACTION } from '#shared/turnstile'
import { NO_ANSWER, type ChatMessage } from '#shared/types/chat'
import { cloudflareEmbedder, embeddingsConfigured, INTERACTIVE_EMBED_LIMITS } from '../ingest/embed'
import { chatModel, configuredTaskModel, isFallbackError } from '../rag/model'
import { ANSWER_MAX_TOKENS, buildPrompt, GROUNDING_INSTRUCTIONS } from '../rag/prompt'
import { configuredReranker } from '../rag/rerank'
import { retrieveSources } from '../rag/retrieve'

// POST /api/chat { question, documentId? } → UI message stream (AI SDK v7),
// with a Turnstile token in the x-turnstile-token header (server/utils/turnstile.ts):
//   data-sources  numbered sources [1..k] with chunk id, document, page and
//                 stored highlight rects (citation chips; Phase 5 highlights)
//   text          grounded answer citing [n], or exactly NO_ANSWER
// Retrieval: bge-m3 query embedding → hybrid RRF search, plus multi-query
// rewrites of an ambiguous question fused with RRF (ADR-0009) → LLM rerank of
// the fused top 20 (ADR-0007) → top 8; each LLM step is skipped on failure. Generation:
// Groq gpt-oss-120b with Cloudflare fallback (server/rag/model.ts), temperature 0.
// A client disconnect (Stop, closed tab) aborts the embedding and LLM calls.
// Generation that stalls (no chunk for 15 s, or 45 s in all) or hits the
// output cap ends the answer with an error part saying so.
//
// Tracing (Phase 10): each request is one Langfuse trace, an `agent` root
// observation that stays open until the answer stream ends, with retrieval
// and every model call nested in it. It records the answer and the time to
// first token (ttftMs) the SPEC targets. No-ops when tracing is off.

/** Generation budget: in all, and between two stream chunks. */
const GENERATION_TIMEOUT = { totalMs: 45_000, chunkMs: 15_000 }

export default defineEventHandler(async (event) => {
  const startedAt = performance.now()
  // Watch the response side from the start: it closes early when the client
  // goes away, also while the body or the quota check is still awaited.
  const abort = new AbortController()
  event.node.res.on('close', () => {
    if (!event.node.res.writableFinished) abort.abort()
  })
  assertSameSiteJson(event)
  // One fresh Turnstile token per question, redeemed before the quota counts it.
  await assertTurnstile(event, TURNSTILE_CHAT_ACTION)
  const { question, documentId } = await readValidatedBody(event, chatRequestSchema.parse)
  const config = useRuntimeConfig(event)
  // Cloudflare embeds every question and is also the answer fallback, so with
  // these two values answers always have a model, with or without Groq.
  if (!embeddingsConfigured(config)) {
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: 'Query embeddings are not configured (set the NUXT_CLOUDFLARE_* values).' })
  }
  const { model, id: modelId, providerOptions } = chatModel(config)
  const supabase = serverSupabase()
  // Per-minute and daily limits (ADR-0010): a clean 429 before any model call or stream.
  const quota = quotaConfig('chat')
  if (quota) await enforceQuota(event, supabase, 'chat', quota.limits, quota.options)

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
          cloudflareEmbedder(config, abort.signal, INTERACTIVE_EMBED_LIMITS),
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
        // Shown after the answer text: the UI renders an error part as an alert
        // and stops reading the stream, so it must come last.
        let notice: string | undefined
        const result = streamText({
          model,
          instructions: GROUNDING_INSTRUCTIONS,
          prompt: buildPrompt(question, sources),
          temperature: 0,
          maxOutputTokens: ANSWER_MAX_TOKENS,
          // withFallback already switches provider on 429/5xx, unreachable or
          // slow to start; one more round after the SDK's backoff is enough
          // before telling the user.
          maxRetries: 1,
          providerOptions,
          abortSignal: abort.signal,
          timeout: GENERATION_TIMEOUT,
          onChunk: ({ chunk }) => {
            if (ttftMs === undefined && chunk.type === 'text-delta') ttftMs = ms()
          },
          onFinish: ({ text, finishReason, response }) => {
            const truncated = finishReason === 'length'
            if (truncated) notice = 'The answer was cut off at the length limit. Ask a narrower question for the rest.'
            trace.end({
              output: text,
              ...(truncated && { level: 'WARNING' as const, statusMessage: 'answer truncated at maxOutputTokens' }),
              // answeredBy: which provider of the chain gave this answer.
              metadata: { ...retrieval, ttftMs, totalMs: ms(), finishReason, answeredBy: response.modelId },
            })
          },
          onAbort: () => {
            if (abort.signal.aborted) {
              trace.end({ level: 'WARNING', statusMessage: 'client disconnected', metadata: { ...retrieval, ttftMs, totalMs: ms() } })
              return
            }
            // Not the client, so one of the generation timeouts fired.
            notice = 'The answer took too long. Please try again.'
            trace.end({ level: 'ERROR', statusMessage: 'generation timed out', metadata: { ...retrieval, ttftMs, totalMs: ms() } })
          },
        })
        // Generation errors surface here, not in createUIMessageStream's onError.
        writer.merge(toUIMessageStream<ToolSet, ChatMessage>({
          stream: result.stream,
          onError,
          // Cloudflare streams the model's reasoning as its own parts.
          sendReasoning: false,
        }).pipeThrough(new TransformStream({
          flush: (controller) => {
            if (notice) controller.enqueue({ type: 'error', errorText: notice })
          },
        })))
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
