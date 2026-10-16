// Phase 3, step 2: page text → chunk character ranges (docs/adr/0003).
//
// Chunks never cross a page boundary, so every chunk has exactly one page and
// one set of highlight rects. Normalized page text has no line or paragraph
// breaks left, so the splitter packs whole sentences greedily up to `maxChars`,
// splits an over-long sentence at word boundaries, and starts each next chunk
// with up to `overlapChars` of trailing sentences from the previous one.

export interface ChunkOptions {
  /** Upper bound on chunk length in characters (≈ 4 chars per token). */
  maxChars: number
  /** Trailing context repeated at the start of the next chunk. */
  overlapChars: number
  /** A final chunk shorter than this is merged into the previous one. */
  minChars: number
}

/**
 * ~200 tokens ≈ one paragraph: the smallest size that kept every golden
 * evidence span inside a single chunk (60/60), while staying tight enough
 * that a highlight marks a passage rather than half a page. See ADR-0003.
 * A merged short tail can push one chunk to maxChars + minChars.
 */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 800, overlapChars: 120, minChars: 150 }

/** Half-open character range [start, end) into the page text. */
export interface ChunkSpan {
  start: number
  end: number
}

// A sentence ends at . ! ? (optionally followed by a closing quote/bracket)
// and the next one starts after a space. Over-splitting on "e.g." or "et al."
// is harmless: pieces are packed back together up to maxChars.
const SENTENCE_END = /[.!?][”’")\]]?(?= )/g

export function chunkPage(text: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): ChunkSpan[] {
  const { maxChars, overlapChars, minChars } = options
  if (text.length === 0) return []

  const pieces = splitLong(sentenceSpans(text), text, maxChars)
  const chunks: ChunkSpan[] = []
  let first = 0 // index of the first piece in the current chunk

  while (first < pieces.length) {
    let last = first
    while (last + 1 < pieces.length && pieces[last + 1]!.end - pieces[first]!.start <= maxChars) last++
    chunks.push({ start: pieces[first]!.start, end: pieces[last]!.end })
    if (last === pieces.length - 1) break

    // Next chunk starts at the earliest trailing piece that fits in the overlap
    // budget, but always after `first` so the loop makes progress.
    let next = last + 1
    while (next - 1 > first && pieces[last]!.end - pieces[next - 1]!.start <= overlapChars) next--
    first = next
  }

  const tail = chunks.at(-1)!
  if (chunks.length > 1 && tail.end - tail.start < minChars) {
    chunks.pop()
    chunks.at(-1)!.end = tail.end
  }
  return chunks
}

function sentenceSpans(text: string): ChunkSpan[] {
  const spans: ChunkSpan[] = []
  let start = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    spans.push({ start, end })
    start = end + 1 // skip the separating space
  }
  if (start < text.length) spans.push({ start, end: text.length })
  return spans
}

/** Splits pieces longer than maxChars at the last space that fits. */
function splitLong(spans: ChunkSpan[], text: string, maxChars: number): ChunkSpan[] {
  const out: ChunkSpan[] = []
  for (const span of spans) {
    let start = span.start
    while (span.end - start > maxChars) {
      const space = text.lastIndexOf(' ', start + maxChars)
      const cut = space > start ? space : start + maxChars // no space: hard cut
      out.push({ start, end: cut })
      start = text[cut] === ' ' ? cut + 1 : cut
    }
    out.push({ start, end: span.end })
  }
  return out
}
