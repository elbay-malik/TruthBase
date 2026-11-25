import { createHash } from 'node:crypto'
import corpusNotes from './corpus-notes.json'

// Contextual retrieval (ADR-0014): each chunk of the four corpus PDFs has a
// one- or two-sentence note that places it in its document ("Self-RAG paper,
// Section 3.2 Training: …"). The note is embedded with the chunk, not stored
// or keyword-indexed, and not shown to the answer model. The notes were
// written offline, once (ADR-0014), and are keyed by the chunk's page and exact
// text (RAPTOR repeats a passage on two pages), so a chunking change that alters
// a chunk drops its note instead of pairing it with the wrong text. Any other PDF (an upload) gets no notes.

const NOTES: Readonly<Record<string, Readonly<Record<string, string>>>> = corpusNotes

/** The lookup key of a chunk: its page, then the first 16 hex digits of its text's SHA-256. */
export function noteKey(pageNumber: number, content: string): string {
  return `${pageNumber}:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`
}

/** The chunk's note, or '' when the corpus has none for this page and text. */
export function chunkNote(filename: string, pageNumber: number, content: string): string {
  return NOTES[filename]?.[noteKey(pageNumber, content)] ?? ''
}
