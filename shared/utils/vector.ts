// Embedding helpers shared by app and server. Import via #shared/utils/vector.

/**
 * L2-normalize a vector to unit length.
 *
 * The AI SDK does not normalize embeddings, so do it before storing or
 * searching, whatever the provider returns, so cosine and inner-product
 * distances behave. A zero vector is returned unchanged (no division by zero).
 */
export function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0
  for (const value of vector) sumSquares += value * value
  const norm = Math.sqrt(sumSquares)
  if (norm === 0) return vector.slice()
  return vector.map(value => value / norm)
}
