// Phase 3, step 2: page text → chunk character ranges (docs/adr/0003).
//
// Chunks never cross a page boundary, so every chunk has exactly one page and
// one set of highlight rects. Normalized page text has no line or paragraph
// breaks left, so the splitter packs whole sentences greedily up to `maxChars`,
// splits an over-long sentence at word boundaries, and starts each next chunk
// with up to `overlapChars` of trailing sentences from the previous one.
//
// Tables and other text without sentence ends become one over-long run, and
// its continuation chunks would lose what opens it (a table's header row).
// Such a chunk gets a `context` range: up to `contextChars` of the run's
// opening, cut at a word boundary. It is a second range into the same page
// text, so the chunk's own range (and its highlight) is unchanged.

export interface ChunkOptions {
  /** Upper bound on chunk length in characters (≈ 4 chars per token). */
  maxChars: number
  /** Trailing context repeated at the start of the next chunk. */
  overlapChars: number
  /** A final chunk shorter than this is merged into the previous one. */
  minChars: number
  /** Most characters of an over-long run's opening kept as a continuation chunk's context (default 240). */
  contextChars?: number
}

/**
 * maxChars ~200 tokens ≈ one paragraph: the smallest size that kept every
 * golden evidence span inside a single chunk (60/60), while staying tight
 * enough that a highlight marks a passage rather than half a page. See
 * ADR-0003. overlapChars 300 carries a long closing sentence or two into the
 * next chunk (best recall@8/@10 of 120-400, measured 2026-11-09). A merged short tail can
 * push one chunk to maxChars + minChars.
 */
export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = { maxChars: 800, overlapChars: 300, minChars: 150, contextChars: 240 }

/** Half-open character range [start, end) into the page text. */
export interface ChunkSpan {
  start: number
  end: number
  /**
   * Set when the chunk starts inside an over-long run that had to be cut at
   * word boundaries (a table or a very long sentence): the run's opening, at
   * most contextChars long and ending before `start`.
   */
  context?: ChunkSpan
}

/** A piece of a sentence span; `run` is the span's start when splitLong cut it. */
interface Piece {
  start: number
  end: number
  run?: number
}

// A sentence ends at . ! ? (optionally followed by a closing quote/bracket)
// and the next one starts after a space. CJK text has no spaces between
// sentences, so 。！？ end one wherever they occur. Over-splitting on "e.g."
// or "et al." is harmless: pieces are packed back together up to maxChars.
const SENTENCE_END = /[.!?][”’")\]]?(?= )|[。！？]+[」』）”’]?/g

export function chunkPage(text: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): ChunkSpan[] {
  const { maxChars, overlapChars, minChars, contextChars = DEFAULT_CHUNK_OPTIONS.contextChars } = options
  if (text.length === 0) return []

  const pieces = splitLong(sentenceSpans(text), text, maxChars)
  const chunks: ChunkSpan[] = []
  let first = 0 // index of the first piece in the current chunk

  while (first < pieces.length) {
    let last = first
    while (last + 1 < pieces.length && pieces[last + 1]!.end - pieces[first]!.start <= maxChars) last++
    const chunk: ChunkSpan = { start: pieces[first]!.start, end: pieces[last]!.end }
    const run = pieces[first]!.run
    const context = run === undefined || run === chunk.start ? undefined : runOpening(text, run, chunk.start, contextChars)
    if (context) chunk.context = context
    chunks.push(chunk)
    if (last === pieces.length - 1) break

    // Next chunk starts at the earliest trailing piece that fits in the overlap
    // budget, but always after `first` so the loop makes progress — and only
    // as far back as still lets it reach past `last`, otherwise it would be a
    // strict subset of this chunk (a duplicate retrieval slot).
    let next = last + 1
    while (next - 1 > first && pieces[last]!.end - pieces[next - 1]!.start <= overlapChars) next--
    while (next <= last && pieces[last + 1]!.end - pieces[next]!.start > maxChars) next++
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
    start = text[end] === ' ' ? end + 1 : end // skip the separating space
  }
  if (start < text.length) spans.push({ start, end: text.length })
  return spans
}

/** Splits pieces longer than maxChars at the last space that fits; the pieces of a cut span remember its start. */
function splitLong(spans: ChunkSpan[], text: string, maxChars: number): Piece[] {
  const out: Piece[] = []
  for (const span of spans) {
    if (span.end - span.start <= maxChars) {
      out.push({ start: span.start, end: span.end })
      continue
    }
    let start = span.start
    while (span.end - start > maxChars) {
      const space = text.lastIndexOf(' ', start + maxChars)
      const cut = space > start ? space : safeCut(text, start, start + maxChars) // no space: hard cut
      out.push({ start, end: cut, run: span.start })
      start = text[cut] === ' ' ? cut + 1 : cut
    }
    out.push({ start, end: span.end, run: span.start })
  }
  return out
}

/**
 * The opening of the run starting at `run`, for a chunk starting at `before`:
 * at most `limit` characters, cut back to the last word boundary (hard-cut if
 * the first word is longer), never reaching `before`, without trailing spaces.
 */
function runOpening(text: string, run: number, before: number, limit: number): ChunkSpan | undefined {
  let end = Math.min(run + limit, before)
  if (end < before && text[end] !== ' ') {
    const space = text.lastIndexOf(' ', end - 1)
    end = space > run ? space : safeCut(text, run, end) // else the first word is too long: hard cut
  }
  while (end > run && text[end - 1] === ' ') end--
  return end > run ? { start: run, end } : undefined
}

/**
 * A hard cut at `at`, moved back one code unit if it would split a surrogate
 * pair (an astral character such as U+1D465 or a CJK Ext-B ideograph): a lone
 * surrogate is not valid text, and Postgres rejects it in a JSON insert body.
 */
function safeCut(text: string, from: number, at: number): number {
  const code = text.charCodeAt(at - 1)
  return at - 1 > from && code >= 0xD800 && code <= 0xDBFF ? at - 1 : at
}
