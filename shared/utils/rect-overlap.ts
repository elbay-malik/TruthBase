// Area metrics between two sets of axis-aligned rects (any one coordinate
// system). Used to score highlight geometry: stored rects vs exact glyph boxes
// from the PDF.js text layer (Phase 3.5 spike, Phase 5 acceptance).
//
// Areas are of the UNION of each set, computed exactly by coordinate
// compression, so overlapping line boxes are never double-counted.

export interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface OverlapMetrics {
  /** |A ∩ B| / |A ∪ B| */
  iou: number
  /** |A ∩ B| / |B|: how much of the truth (B) the highlight (A) covers. */
  coverage: number
  /** |A ∩ B| / |A|: how much of the highlight (A) lies on the truth (B). */
  precision: number
}

const normalize = (b: Box): Box => ({
  x1: Math.min(b.x1, b.x2), y1: Math.min(b.y1, b.y2),
  x2: Math.max(b.x1, b.x2), y2: Math.max(b.y1, b.y2),
})

/** Union area of A, of B, and of A∩B in one sweep over the compressed grid. */
export function overlapAreas(a: Box[], b: Box[]): { a: number, b: number, both: number } {
  const A = a.map(normalize)
  const B = b.map(normalize)
  const xs = [...new Set([...A, ...B].flatMap(r => [r.x1, r.x2]))].sort((p, q) => p - q)
  const ys = [...new Set([...A, ...B].flatMap(r => [r.y1, r.y2]))].sort((p, q) => p - q)
  const inside = (set: Box[], x: number, y: number) => set.some(r => r.x1 <= x && x < r.x2 && r.y1 <= y && y < r.y2)

  let areaA = 0
  let areaB = 0
  let both = 0
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cell = (xs[i + 1]! - xs[i]!) * (ys[j + 1]! - ys[j]!)
      if (cell === 0) continue
      const inA = inside(A, xs[i]!, ys[j]!)
      const inB = inside(B, xs[i]!, ys[j]!)
      if (inA) areaA += cell
      if (inB) areaB += cell
      if (inA && inB) both += cell
    }
  }
  return { a: areaA, b: areaB, both }
}

export function overlapMetrics(highlight: Box[], truth: Box[]): OverlapMetrics {
  const { a, b, both } = overlapAreas(highlight, truth)
  const union = a + b - both
  return {
    iou: union > 0 ? both / union : 0,
    coverage: b > 0 ? both / b : 0,
    precision: a > 0 ? both / a : 0,
  }
}
