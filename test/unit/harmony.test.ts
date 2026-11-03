import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { streamText } from 'ai'
import { describe, expect, it } from 'vitest'
import { harmonyFilter, stripHarmony, withoutHarmony } from '../../server/rag/harmony'

// The answer g-023 got from Cloudflare in the 2026-11-02 eval.
const LEAKED = 'analysis: need definition from sources. Provide answer citing.<|end|><|start|>assistantfinal: A Community Profile is a baseline [1][2]<|return|>'

const inPieces = (text: string, size: number) => {
  const filter = harmonyFilter()
  let out = ''
  for (let i = 0; i < text.length; i += size) out += filter.push(text.slice(i, i + size))
  return out + filter.end()
}

describe('harmonyFilter', () => {
  it('keeps only the final channel, however the stream is cut', () => {
    for (const size of [1, 2, 3, 7, 50, 500]) expect(inPieces(LEAKED, size)).toBe('A Community Profile is a baseline [1][2]')
  })

  it('reads the token form of the final channel', () => {
    expect(stripHarmony('<|channel|>analysis<|message|>hmm<|end|><|start|>assistant<|channel|>final<|message|>Answer [1].<|return|>')).toBe('Answer [1].')
  })

  it('leaves ordinary answers alone', () => {
    for (const text of ['Tier 2 < Tier 3 [1].', 'Analysis of the data shows x [1].', 'a is the first letter [1].', 'x <', 'NO_ANSWER']) {
      for (const size of [1, 4, 100]) expect(inPieces(text, size)).toBe(text)
    }
  })

  it('cuts a trailing token', () => {
    expect(inPieces('The answer [1].<|return|>', 3)).toBe('The answer [1].')
  })

  it('refuses when there is nothing but reasoning', () => {
    expect(stripHarmony('analysis: need more sources, not sure')).toBe('NO_ANSWER')
    expect(stripHarmony('analysis: thinking<|end|><|start|>assistantfinal:')).toBe('NO_ANSWER')
  })
})

describe('withoutHarmony', () => {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: 'analysis: hmm<|end|><|start|>assistant' },
    { type: 'text-delta', id: '1', delta: 'final: Ans' },
    { type: 'text-delta', id: '1', delta: 'wer<' },
    { type: 'text-end', id: '1' },
  ]
  const model = {
    specificationVersion: 'v4',
    provider: 'p',
    modelId: 'm',
    supportedUrls: {},
    doStream: async () => ({ stream: new ReadableStream({ start: (c) => { parts.forEach(p => c.enqueue(p)); c.close() } }) }),
    doGenerate: async () => ({ finishReason: { unified: 'stop', raw: 'stop' }, content: [{ type: 'text', text: LEAKED }, { type: 'reasoning', text: 'kept' }] }),
  } as unknown as LanguageModelV4

  it('filters a stream and keeps its other parts in order', async () => {
    const { stream } = await withoutHarmony(model).doStream({} as never)
    const out: LanguageModelV4StreamPart[] = []
    for await (const part of stream as unknown as AsyncIterable<LanguageModelV4StreamPart>) out.push(part)
    expect(out.map(p => p.type).filter(type => type !== 'response-metadata')).toEqual(['stream-start', 'text-start', 'text-delta', 'text-delta', 'text-delta', 'text-end'])
    expect(out.filter(p => p.type === 'text-delta').map(p => p.delta).join('')).toBe('Answer<')
  })

  it('filters a whole answer', async () => {
    const { content } = await withoutHarmony(model).doGenerate({} as never)
    expect(content).toEqual([{ type: 'text', text: 'A Community Profile is a baseline [1][2]' }, { type: 'reasoning', text: 'kept' }])
  })
})

describe('harmonyFilter, review cases', () => {
  it('keeps notation that merely looks like a token', () => {
    const text = 'The bound is P(a<|b|) in general, and this holds [1].'
    for (const size of [1, 3, 100]) expect(inPieces(text, size)).toBe(text)
  })

  it('does not take "assistant final" in the reasoning for the marker', () => {
    expect(stripHarmony('analysis: the assistant final answer must cite [1]. I am an assistant finally.<|end|><|start|>assistantfinal: Answer [1].')).toBe('Answer [1].')
  })

  it('reads an answer that opens with the final channel', () => {
    for (const size of [1, 5, 100]) {
      expect(inPieces('assistant<|channel|>final<|message|>Answer [1].', size)).toBe('Answer [1].')
      expect(inPieces('assistantfinal: Answer [1].', size)).toBe('Answer [1].')
    }
    expect(inPieces('assistant roles differ [1].', 4)).toBe('assistant roles differ [1].')
  })

  it('leaves the text empty, not refused, when the output cap ends the reasoning', () => {
    expect(stripHarmony('analysis: still thinking', true)).toBe('')
  })
})

describe('withoutHarmony and streamText', () => {
  const slowStream = (parts: LanguageModelV4StreamPart[], ms: number) => new ReadableStream<LanguageModelV4StreamPart>({
    start: async (c) => {
      for (const part of parts) {
        c.enqueue(part)
        await new Promise(resolve => setTimeout(resolve, ms))
      }
      c.close()
    },
  })
  const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage: { inputTokens: {}, outputTokens: {} } }) as unknown as LanguageModelV4StreamPart
  const streaming = (parts: LanguageModelV4StreamPart[], ms = 0) => withoutHarmony({
    specificationVersion: 'v4',
    provider: 'p',
    modelId: 'm',
    supportedUrls: {},
    doStream: async () => ({ stream: slowStream(parts, ms) }),
  } as unknown as LanguageModelV4)
  const hidden = (n: number): LanguageModelV4StreamPart[] => Array.from({ length: n }, () => ({ type: 'text-delta', id: '1', delta: 'analysis thinking ' }))

  it('counts hidden reasoning as progress for the chunk timeout', async () => {
    const model = streaming([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      ...hidden(6),
      { type: 'text-delta', id: '1', delta: '<|end|><|start|>assistantfinal: Answer' },
      { type: 'text-end', id: '1' },
      finish('stop'),
    ], 30)
    const result = streamText({ model, prompt: 'q', timeout: { chunkMs: 100 } })
    await expect(result.text).resolves.toBe('Answer')
  })

  it('reports a cut-off answer as truncated, with no refusal', async () => {
    const result = streamText({ model: streaming([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      ...hidden(2),
      { type: 'text-end', id: '1' },
      finish('length'),
    ]), prompt: 'q' })
    await expect(result.text).resolves.toBe('')
    await expect(result.finishReason).resolves.toBe('length')
  })
})
