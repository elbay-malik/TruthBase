import { describe, expect, it } from 'vitest'
import { overlapAreas, overlapMetrics } from '../../shared/utils/rect-overlap'

describe('overlapAreas / overlapMetrics', () => {
  it('identical sets score 1 everywhere', () => {
    const r = [{ x1: 0, y1: 0, x2: 10, y2: 2 }, { x1: 0, y1: 3, x2: 6, y2: 5 }]
    expect(overlapMetrics(r, r)).toEqual({ iou: 1, coverage: 1, precision: 1 })
  })

  it('does not double-count overlapping rects within a set', () => {
    const a = [{ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 5, y1: 0, x2: 15, y2: 10 }]
    expect(overlapAreas(a, []).a).toBe(150)
  })

  it('separates coverage (of truth) from precision (of highlight)', () => {
    const highlight = [{ x1: 0, y1: 0, x2: 10, y2: 10 }] // 100
    const truth = [{ x1: 5, y1: 0, x2: 25, y2: 10 }] // 200, overlap 50
    const m = overlapMetrics(highlight, truth)
    expect(m.coverage).toBeCloseTo(50 / 200)
    expect(m.precision).toBeCloseTo(50 / 100)
    expect(m.iou).toBeCloseTo(50 / 250)
  })

  it('accepts flipped corners (PDF space has y growing upwards)', () => {
    const flipped = [{ x1: 10, y1: 10, x2: 0, y2: 0 }]
    expect(overlapMetrics(flipped, [{ x1: 0, y1: 0, x2: 10, y2: 10 }]).iou).toBe(1)
  })

  it('returns zeros for disjoint or empty sets', () => {
    expect(overlapMetrics([{ x1: 0, y1: 0, x2: 1, y2: 1 }], [{ x1: 2, y1: 2, x2: 3, y2: 3 }]).iou).toBe(0)
    expect(overlapMetrics([], [])).toEqual({ iou: 0, coverage: 0, precision: 0 })
  })
})
