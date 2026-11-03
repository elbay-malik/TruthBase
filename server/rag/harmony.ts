import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { NO_ANSWER } from '../../shared/types/chat'

// gpt-oss writes in "harmony" channels. Groq and Cloudflare normally split the
// analysis channel off and return only the final answer, but on Cloudflare 1 of
// 50 eval answers came back as raw channels:
//   analysis: need definition ...<|end|><|start|>assistantfinal: A profile is ...<|return|>
// Visitors must never see that, so the Cloudflare model is wrapped in this
// filter. It works on the stream, because the text goes straight to the browser.

const FINAL_MARKER = /<\|channel\|>\s*final\s*<\|message\|>\s*|assistantfinal\s*:?\s*/
const TOKEN = /<\|(?:start|end|return|call|channel|message|constrain)\|>/
/** The start of a token, at the end of the buffer: the rest may still be arriving. */
const PARTIAL_TOKEN = /<(?:\|[a-z]*\|?)?$/
/** The longest marker that can still be arriving at the end of the buffer. */
const MARKER_TAIL = 48
const CHANNEL_HEADS = ['analysis', 'assistantfinal', 'assistant<|channel|>', '<|start|>', '<|channel|>', '<|message|>', '<|end|>', '<|return|>', '<|call|>']

export interface HarmonyFilter {
  /** The visible text a new delta releases, possibly none. */
  push: (delta: string) => string
  /** The rest of the visible text, when the text ends; `truncated` if the output cap ended it. */
  end: (truncated?: boolean) => string
}

/**
 * Hides analysis text and channel tokens. An answer that opens with lowercase
 * "analysis" is held until the final channel's marker. If none comes it was all
 * reasoning, and the answer becomes the grounded refusal, unless the output cap
 * cut it off: that isn't a refusal, so the text stays empty and the route's
 * "cut off" notice speaks. Answers start with a capital in practice, so a real
 * one opening with that word is not a concern. Only known tokens count, so
 * notation like "P(a<|b|)" stays in the answer.
 */
export function harmonyFilter(): HarmonyFilter {
  let state: 'head' | 'body' | 'hidden' = 'head'
  let buffer = ''
  let emitted = false
  let hidFromStart = false

  const drain = (final: boolean): string => {
    let out = ''
    for (;;) {
      if (state === 'head') {
        buffer = buffer.trimStart()
        if (!buffer) return out
        if (!final && CHANNEL_HEADS.some(head => head.startsWith(buffer))) return out
        if (CHANNEL_HEADS.some(head => buffer.startsWith(head))) {
          if (!emitted && !out) hidFromStart = true
          state = 'hidden'
        }
        else {
          state = 'body'
        }
      }
      else if (state === 'hidden') {
        const match = FINAL_MARKER.exec(buffer)
        if (match) {
          // Wait for what may still belong to the marker (":" and spaces).
          if (!final && match.index + match[0].length === buffer.length) return out
          buffer = buffer.slice(match.index + match[0].length)
          state = 'head'
        }
        else {
          buffer = final ? '' : buffer.slice(-MARKER_TAIL)
          return out
        }
      }
      else {
        const token = TOKEN.exec(buffer)
        if (token) {
          out += buffer.slice(0, token.index)
          buffer = buffer.slice(token.index)
          state = 'hidden'
        }
        else {
          const hold = final ? 0 : (PARTIAL_TOKEN.exec(buffer)?.[0].length ?? 0)
          out += buffer.slice(0, buffer.length - hold)
          buffer = buffer.slice(buffer.length - hold)
          return out
        }
      }
    }
  }
  const release = (final: boolean, truncated = false) => {
    let out = drain(final)
    if (final && hidFromStart && !emitted && !out && !truncated) out = NO_ANSWER
    if (out) emitted = true
    return out
  }
  return {
    push: (delta) => {
      buffer += delta
      return release(false)
    },
    end: truncated => release(true, truncated),
  }
}

/** The filter over a whole text, for non-streamed calls. */
export function stripHarmony(text: string, truncated = false): string {
  const filter = harmonyFilter()
  return filter.push(text) + filter.end(truncated)
}

/** `model` with harmonyFilter() over its text, streamed or not. */
export function withoutHarmony(model: LanguageModelV4): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const result = await model.doGenerate(options)
      const truncated = result.finishReason.unified === 'length'
      return { ...result, content: result.content.map(part => part.type === 'text' ? { ...part, text: stripHarmony(part.text, truncated) } : part) }
    },
    doStream: async (options: LanguageModelV4CallOptions) => {
      const result = await model.doStream(options)
      const filters = new Map<string, HarmonyFilter>()
      const filterOf = (id: string) => {
        let filter = filters.get(id)
        if (!filter) filters.set(id, filter = harmonyFilter())
        return filter
      }
      // A text's end waits for the finish part, which says why it ended.
      const ended: string[] = []
      const closeTexts = (controller: TransformStreamDefaultController<LanguageModelV4StreamPart>, truncated: boolean) => {
        for (const id of ended.splice(0)) {
          const delta = filterOf(id).end(truncated)
          if (delta) controller.enqueue({ type: 'text-delta', id, delta })
          controller.enqueue({ type: 'text-end', id })
        }
      }
      return {
        ...result,
        stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform: (part, controller) => {
            if (part.type === 'text-delta') {
              const delta = filterOf(part.id).push(part.delta)
              // A part with no fields, so hidden text still counts as progress
              // for streamText's between-chunks timeout.
              controller.enqueue(delta ? { ...part, delta } : { type: 'response-metadata' })
            }
            else if (part.type === 'text-end') {
              ended.push(part.id)
            }
            else {
              if (part.type === 'finish') closeTexts(controller, part.finishReason.unified === 'length')
              controller.enqueue(part)
            }
          },
          flush: controller => closeTexts(controller, false),
        })),
      }
    },
  }
}
