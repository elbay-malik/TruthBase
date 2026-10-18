import { NO_ANSWER } from '../types/chat'

// Citation markers and refusals in model answers — one implementation shared
// by the chat UI (chips), the server (prompt.ts) and the golden-set eval, so
// what users see and what the metrics count can never disagree.
//
// Markers: "[2]", "[1][4]", "[1, 2]", ranges "[1-3]" / "[1–3]", and gpt-oss's
// native "【2】" / "【2†L3-L5】". A "[" glued to a word ("arr[2]", and the
// chained "arr[1][2]") is not a marker; adjacent markers ("[1][3]") are. Inside a marker, numbers outside 1..sourceCount are dropped; the
// valid ones still count (UI and eval apply the same rule).

/** Group 1: the marker body, e.g. "1, 3-4". */
export const CITATION_MARKER = /(?<!\w(?:\[[^[\]]*\])*)\[(\d+(?:\s*[-–,，]\s*\d+)*)\]|【(\d+(?:\s*[-–,，]\s*\d+)*)(?:†[^】]*)?】/g

/** Ranges wider than this are not expanded (a "[1-40]" is not a citation list). */
const MAX_RANGE = 10

export type AnswerSegment = { type: 'text', text: string } | { type: 'cite', index: number }

/** Valid citation numbers in one marker body, in order, without duplicates. */
function markerNumbers(body: string, sourceCount: number): number[] {
  const numbers: number[] = []
  for (const part of body.split(/[,，]/)) {
    const range = part.split(/[-–]/).map(n => Number(n.trim()))
    const [from, to = from] = range as [number, number?]
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from || to - from >= MAX_RANGE) continue
    for (let n = from; n <= to; n++) {
      if (n >= 1 && n <= sourceCount && !numbers.includes(n)) numbers.push(n)
    }
  }
  return numbers
}

/**
 * Splits an answer into text and citation segments for rendering chips. A
 * marker with no valid number stays plain text, so a hallucinated "[9]" never
 * becomes a clickable chip.
 */
export function splitCitations(answer: string, sourceCount: number): AnswerSegment[] {
  const segments: AnswerSegment[] = []
  let last = 0
  for (const match of answer.matchAll(CITATION_MARKER)) {
    const numbers = markerNumbers(match[1] ?? match[2]!, sourceCount)
    if (numbers.length === 0) continue
    if (match.index > last) segments.push({ type: 'text', text: answer.slice(last, match.index) })
    for (const index of numbers) segments.push({ type: 'cite', index })
    last = match.index + match[0].length
  }
  if (last < answer.length) segments.push({ type: 'text', text: answer.slice(last) })
  return segments
}

/** Valid citation numbers in an answer, in order of first use. */
export function parseCitations(answer: string, sourceCount: number): number[] {
  const cited: number[] = []
  for (const segment of splitCitations(answer, sourceCount)) {
    if (segment.type === 'cite' && !cited.includes(segment.index)) cited.push(segment.index)
  }
  return cited
}

/**
 * Removes Markdown bold the prompt asks the model not to use but gpt-oss
 * sometimes still emits ("**GOVERN**"), for plain-text rendering. Only `**`
 * not glued to a word or another `*` on the outside, within one line, so
 * quoted text like "x**2 + y**2" or Python's "__init__" stays intact.
 */
export function stripEmphasis(text: string): string {
  return text.replace(/(?<![\w*])\*\*(?=\S)([^\n]*?\S)\*\*(?![\w*])/g, '$1')
}

/**
 * Whether an answer is the grounded refusal. Tolerates Markdown decoration and
 * punctuation ("**NO_ANSWER**", "`NO_ANSWER`.") and a refusal followed by an
 * explanation, as long as that explanation cites nothing.
 */
export function isRefusal(answer: string, sourceCount = 0): boolean {
  const head = answer.trim().replace(/^[*_`\s]+/, '')
  if (!head.startsWith(NO_ANSWER)) return false
  return parseCitations(answer, sourceCount).length === 0
}

/** A partially streamed refusal ("NO_ANS…", "**NO_") — hide instead of flashing it. */
export function looksLikeRefusalPrefix(text: string): boolean {
  const head = text.trim().replace(/^[*_`\s]+/, '')
  return head.length > 0 && NO_ANSWER.startsWith(head)
}
