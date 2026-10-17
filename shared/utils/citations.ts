// Splits an answer into text and citation segments for rendering chips.
// Handles "[2]", "[1][4]" and "[1, 2]", plus gpt-oss's native "【2】" and
// "【2†L3-L5】" forms. Numbers outside 1..sourceCount stay as plain text, so a
// hallucinated marker never becomes a clickable chip.

/** A citation marker: [n], [n, m], 【n】 or 【n†…】. Group 1 holds the numbers. */
export const CITATION_MARKER = /[[【](\d+(?:\s*[,，]\s*\d+)*)(?:†[^\]】]*)?[\]】]/g

const numbersOf = (group: string) => group.split(/[,，]/).map(n => Number(n.trim()))

export type AnswerSegment = { type: 'text', text: string } | { type: 'cite', index: number }

export function splitCitations(answer: string, sourceCount: number): AnswerSegment[] {
  const segments: AnswerSegment[] = []
  let last = 0
  for (const match of answer.matchAll(CITATION_MARKER)) {
    const numbers = numbersOf(match[1]!)
    if (!numbers.every(n => n >= 1 && n <= sourceCount)) continue
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
  for (const match of answer.matchAll(CITATION_MARKER)) {
    for (const n of numbersOf(match[1]!)) {
      if (n >= 1 && n <= sourceCount && !cited.includes(n)) cited.push(n)
    }
  }
  return cited
}
