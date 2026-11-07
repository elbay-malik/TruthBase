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

/** A bracket citation still streaming in: "[", "[1", "[1, 2", "[3–". */
const PARTIAL_BRACKET = /^\[[\d\s,，\-–]*$/

/**
 * The answer's tail without a citation marker that is still streaming in
 * ("… tree [1", "… tree 【2†"), and without the whitespace before it. It runs
 * on every streamed token, so it stays linear: the single regex
 * /\s*(?:\[[\d\s,，\-–]*|【[^】]*)$/ backtracks quadratically on a long run of
 * whitespace and could freeze the tab on a pathological answer.
 */
export function dropPartialMarker(text: string): string {
  const starts: number[] = []
  // A later "[" would be inside the marker, which no partial marker allows.
  const bracket = text.lastIndexOf('[')
  if (bracket >= 0 && PARTIAL_BRACKET.test(text.slice(bracket))) starts.push(bracket)
  // Any "【" after the last "】" starts an unclosed marker; the earliest one counts.
  const lenticular = text.indexOf('【', text.lastIndexOf('】') + 1)
  if (lenticular >= 0) starts.push(lenticular)
  return starts.length ? text.slice(0, Math.min(...starts)).trimEnd() : text
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

/**
 * The chunk id a shared link carries (?chunk=), when it is one: letters,
 * digits, "_" and "-". It goes into an API path, where "../health" would
 * fetch another route. Lower-cased, since the API accepts only the canonical
 * lower-case uuid and a hand-typed link may not use it.
 */
export function sharedChunkId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w-]+$/.test(value) ? value.toLowerCase() : undefined
}

/** Longest claim a shared link carries, in characters. */
export const MAX_CLAIM = 300

/**
 * A claim as a shared link carries it: whitespace collapsed, bidi controls
 * and zero-width characters removed (a link is anyone's text, and an unclosed
 * U+202E would reorder what follows), cut to MAX_CLAIM code points with "…".
 */
export function cleanClaim(text: string): string {
  const chars = [...text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/\s+/g, ' ').trim()]
  return chars.length > MAX_CLAIM ? `${chars.slice(0, MAX_CLAIM - 1).join('').trimEnd()}…` : chars.join('')
}
