// The title goes in front of each chunk before embedding, not into the stored
// text. Without it bge-m3 lost 5-8 golden records in the 2026-11-02 bake-off,
// because a chunk often doesn't name its own document. The hosted documents
// have no title, so the corpus's are listed here, and the stored vectors embed
// exactly these strings.

const CORPUS_TITLES: Readonly<Record<string, string>> = {
  'nist-csf-2.0.pdf': 'The NIST Cybersecurity Framework (CSF) 2.0',
  'self-rag.pdf': 'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection',
  'nist-ai-rmf-1.0.pdf': 'Artificial Intelligence Risk Management Framework (AI RMF 1.0)',
  'raptor.pdf': 'RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval',
}

/** The corpus title, or the filename without its extension for any other PDF. */
export function documentTitle(filename: string): string {
  return CORPUS_TITLES[filename] ?? filename.replace(/\.pdf$/i, '')
}

/**
 * The text embedded for a chunk: the title, then the opening of the run it
 * continues (chunk.ts `context`) if any, then the chunk. Without context the
 * string is unchanged, so the stored vectors of such chunks stay reproducible.
 */
export function embeddingText(filename: string, content: string, context = ''): string {
  return `${documentTitle(filename)}\n\n${context ? `${context}\n\n` : ''}${content}`
}
