// Embedding helpers shared by app and server. Import via #shared/utils/vector.

/**
 * L2-normalize a vector to unit length.
 *
 * Gemini `gemini-embedding-001` only returns normalized vectors at the full
 * 3072 dims; Matryoshka-truncated outputs (e.g. 768) are NOT normalized, and
 * the AI SDK does not normalize them (docs/TECH_NOTES.md §2). Normalize before
 * storing so cosine/inner-product distances behave. A zero vector is returned
 * unchanged (no division by zero).
 */
export function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0
  for (const value of vector) sumSquares += value * value
  const norm = Math.sqrt(sumSquares)
  if (norm === 0) return vector.slice()
  return vector.map(value => value / norm)
}
