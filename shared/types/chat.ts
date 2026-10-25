import type { UIMessage } from 'ai'
import type { ChunkHighlight } from './index'

// Chat wire types shared by POST /api/chat and the chat UI.

/** One numbered source the answer may cite as `[index]`. */
export interface SourceRef {
  /** 1-based number used in the answer's citation markers. */
  index: number
  chunkId: string
  documentId: string
  filename: string
  pageNumber: number | null
  /** Chunk text, for previews and to verify a citation. */
  content: string
  /** Stored PDF-space rects (per line, plus big-operator glyphs): what Phase 5 draws on click. */
  highlight: ChunkHighlight | null
}

/** Custom data parts streamed before the answer text (a type alias, so it satisfies the SDK's Record<string, unknown> constraint). */
export type ChatDataParts = {
  sources: { sources: SourceRef[] }
}

export type ChatMessage = UIMessage<never, ChatDataParts>

/** The exact reply the model gives when the sources don't contain the answer. */
export const NO_ANSWER = 'NO_ANSWER'
