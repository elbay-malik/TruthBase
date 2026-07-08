import { describe, expect, it } from 'vitest'
import { l2Normalize } from '../../shared/utils/vector'

describe('l2Normalize', () => {
  it('scales a vector to unit length', () => {
    const out = l2Normalize([3, 4])
    expect(out).toEqual([0.6, 0.8])
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0))
    expect(norm).toBeCloseTo(1, 10)
  })

  it('leaves a zero vector unchanged (no division by zero)', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0])
  })

  it('does not mutate the input', () => {
    const input = [1, 2, 2]
    const out = l2Normalize(input)
    expect(input).toEqual([1, 2, 2])
    expect(out).not.toBe(input)
  })

  it('returns an already-normalized vector essentially unchanged', () => {
    const [x, y] = l2Normalize([0, 5])
    expect(x).toBeCloseTo(0, 10)
    expect(y).toBeCloseTo(1, 10)
  })
})
