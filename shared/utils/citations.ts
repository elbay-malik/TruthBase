// Splits an answer into text and citation segments for rendering chips.
// Handles "[2]", "[1][4]" and "[1, 2]". Numbers outside 1..sourceCount stay
// as plain text, so a hallucinated marker never becomes a clickable chip.

export type AnswerSegment = { type: 'text', text: string } | { type: 'cite', index: number }

export function splitCitations(answer: string, sourceCount: number): AnswerSegment[] {
  const segments: AnswerSegment[] = []
  let last = 0
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    const numbers = match[1]!.split(',').map(n => Number(n.trim()))
    if (!numbers.every(n => n >= 1 && n <= sourceCount)) continue
    if (match.index > last) segments.push({ type: 'text', text: answer.slice(last, match.index) })
    for (const index of numbers) segments.push({ type: 'cite', index })
    last = match.index + match[0].length
  }
  if (last < answer.length) segments.push({ type: 'text', text: answer.slice(last) })
  return segments
}
