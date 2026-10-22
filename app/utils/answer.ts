import type { AnswerSegment } from '#shared/utils/citations'

// How an answer's text and citation chips are laid out: paragraphs and lists,
// as the model writes them in plain text ("- GOVERN … [1]⏎- IDENTIFY … [2]").

export type AnswerBlock =
  | { type: 'p', lines: AnswerSegment[][] }
  | { type: 'ul' | 'ol', items: AnswerSegment[][] }

/** A list line's marker: "- ", "* ", "• ", "1. ", "2) ". Group 1 is set for a numbered one. */
const LIST_MARKER = /^[ \t]*(?:[-*•]|(\d+)[.)])[ \t]+/

/**
 * Tidies the segments as rendered: no space between a chip and the
 * punctuation after it ("tree [1] ." reads "tree¹."), and runs of spaces
 * collapsed. The space before a chip is dropped by the page itself.
 */
export function tidySegments(segments: AnswerSegment[]): AnswerSegment[] {
  return segments.flatMap((segment, i): AnswerSegment[] => {
    if (segment.type !== 'text') return [segment]
    let text = segment.text.replace(/[ \t]{2,}/g, ' ')
    if (segments[i - 1]?.type === 'cite') text = text.replace(/^[ \t]+(?=[.,;:!?)])/, '')
    return text ? [{ type: 'text', text }] : []
  })
}

/**
 * Splits segments into lines, then groups them: consecutive list lines make a
 * list (numbered when the first one is), a blank line ends a paragraph, and
 * other lines join the paragraph they follow.
 */
export function answerBlocks(segments: AnswerSegment[]): AnswerBlock[] {
  const lines: AnswerSegment[][] = [[]]
  for (const segment of segments) {
    if (segment.type !== 'text') {
      lines.at(-1)!.push(segment)
      continue
    }
    segment.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines.at(-1)!.push({ type: 'text', text: part })
    })
  }

  const blocks: AnswerBlock[] = []
  let open: AnswerBlock | undefined
  for (const line of lines) {
    const first = line[0]
    const blank = line.every(s => s.type === 'text' && !s.text.trim())
    if (blank) {
      open = undefined
      continue
    }
    const marker = first?.type === 'text' ? LIST_MARKER.exec(first.text) : null
    if (first?.type === 'text' && marker) {
      const rest = first.text.slice(marker[0].length)
      const item = rest ? [{ type: 'text', text: rest } as AnswerSegment, ...line.slice(1)] : line.slice(1)
      if (open?.type !== 'ul' && open?.type !== 'ol') {
        open = { type: marker[1] ? 'ol' : 'ul', items: [] }
        blocks.push(open)
      }
      open.items.push(item)
      continue
    }
    if (open?.type !== 'p') {
      open = { type: 'p', lines: [] }
      blocks.push(open)
    }
    open.lines.push(line)
  }
  return blocks
}
