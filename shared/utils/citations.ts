import { NO_ANSWER } from '../types/chat'

// Citation markers and refusals in model answers — one implementation shared
// by the chat UI (chips), the server (prompt.ts) and the golden-set eval, so
// what users see and what the metrics count can never disagree.
//
// Markers: "[2]", "[1][4]", "[1, 2]", ranges "[1-3]" / "[1–3]", and gpt-oss's
// native "【2】" / "【2†L3-L5】". A "[" glued to a number is a marker
// ("CSF 2.0[1]", "PR.DS-11[2]"); glued to a word only at the end of a clause,
// line or answer ("tiers[1].", "policy[1])", "- Govern[1]⏎"), so code like
// "arr[2] and m[1][2] or my_var[3])" is not. Adjacent markers
// ("[1][3]") are. Inside a marker, numbers outside 1..sourceCount are dropped;
// the valid ones still count (UI and eval apply the same rule).

/** Group 1: the body of an ASCII marker, group 2 of a native one, e.g. "1, 3-4". */
export const CITATION_MARKER = /\[(\d+(?:\s*[-–,，]\s*\d+)*)\]|【(\d+(?:\s*[-–,，]\s*\d+)*)(?:†[^】]*)?】/g

/** Whether the ASCII marker at text[start, end) is an index glued to a word ("arr[2]"), not a citation. */
function looksLikeIndex(text: string, start: number, end: number): boolean {
  // Look past adjacent bracket groups on both sides: "m[1][2]" is one index chain.
  const word = /\w*$/.exec(text.slice(Math.max(0, start - 200), start).replace(/(?:\[[^[\]]*\])+$/, ''))![0]
  if (!word || /\d$/.test(word)) return false
  if (word.includes('_')) return true
  return !/^(?:[.,;:!?)"'”’]+(?:\s|$)|[ \t]*(?:\r?\n|$))/.test(text.slice(end, end + 200).replace(/^(?:\[[^[\]]*\])+/, ''))
}

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
    if (match[1] !== undefined && looksLikeIndex(answer, match.index, match.index + match[0].length)) continue
    const numbers = markerNumbers(match[1] ?? match[2]!, sourceCount)
    if (numbers.length === 0) continue
    if (match.index > last) segments.push({ type: 'text', text: answer.slice(last, match.index) })
    for (const index of numbers) segments.push({ type: 'cite', index })
    last = match.index + match[0].length
  }
  if (last < answer.length) segments.push({ type: 'text', text: answer.slice(last) })
  return segments
}

/** A sentence end: . ! or ? (plus closing quotes or brackets) before a space, or a line break. */
const SENTENCE_END = /[.!?]["”’)\]]*(?=\s|$)|\n/

/**
 * The claim a citation backs: the sentence of the answer that carries its
 * chip, without any citation markers ("Backups are verified [1]." →
 * "Backups are verified."). Shown next to the evidence on phones, where the
 * answer is hidden behind the viewer. Empty when the answer doesn't cite `index`.
 */
export function claimSentence(segments: AnswerSegment[], index: number): string {
  const at = segments.findIndex(s => s.type === 'cite' && s.index === index)
  if (at < 0) return ''
  const textOf = (part: AnswerSegment[]) => part.map(s => (s.type === 'text' ? s.text : '')).join('')
  const before = textOf(segments.slice(0, at)).trimEnd()
  const after = textOf(segments.slice(at + 1))
  let start = 0
  let closed = false
  for (const match of before.matchAll(new RegExp(SENTENCE_END, 'g'))) {
    // A chip after the full stop ("Backups are verified. [1]") cites the sentence it follows.
    if (match.index + match[0].length >= before.length && match[0] !== '\n') closed = true
    else start = match.index + match[0].length
  }
  const end = closed ? null : SENTENCE_END.exec(after)
  const stop = closed ? 0 : end ? end.index + (end[0] === '\n' ? 0 : end[0].length) : after.length
  return `${before.slice(start)} ${after.slice(0, stop)}`
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
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
