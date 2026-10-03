import { describe, expect, it } from 'vitest'
import { canvasScrollPlan } from './scroll.js'

function keys(values: readonly string[], firstRow = 0): ReadonlyMap<number, string> {
  return new Map(values.map((value, index) => [firstRow + index, value]))
}

describe('canvasScrollPlan', () => {
  it('verifies one signed shift and every reused row exactly', () => {
    const previous = keys(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(canvasScrollPlan(previous, keys(['b', 'c', 'changed', 'e', 'f', 'new']), 6)).toEqual({
      offset: -1,
      reused: new Set([0, 1, 3, 4]),
    })
    expect(canvasScrollPlan(previous, keys(['new', 'a', 'b', 'c', 'd', 'e']), 6)).toEqual({
      offset: 1,
      reused: new Set([1, 2, 3, 4, 5]),
    })
    expect(canvasScrollPlan(previous, keys(['c', 'd', 'e', 'f', 'x', 'y']), 6)).toEqual({
      offset: -2,
      reused: new Set([0, 1, 2, 3]),
    })
  })

  it('keeps partial updates and stationary rewrites at their coordinates', () => {
    const previous = keys(['a', 'b', 'c', 'd'])
    expect(canvasScrollPlan(previous, keys(['c'], 2), 4)).toEqual({
      offset: 0,
      reused: new Set([2]),
    })
    expect(canvasScrollPlan(previous, keys(['a', 'x', 'c', 'd']), 4)).toEqual({
      offset: 0,
      reused: new Set([0, 2, 3]),
    })
  })

  it('does not infer shifts from repeated blanks or a single matching row', () => {
    expect(canvasScrollPlan(keys(['', '', '', '']), keys(['', '', '', 'new']), 4).offset).toBe(0)
    expect(canvasScrollPlan(keys(['a', 'b', 'c', 'd']), keys(['x', 'a', 'y', 'z']), 4).offset).toBe(
      0,
    )
  })

  it('does not reuse mismatched keys, including ambiguous delimiter content', () => {
    expect(
      canvasScrollPlan(keys(['["ab","c"]', '["a","bc"]']), keys(['["a","bc"]', '["ab","c"]']), 2)
        .reused.size,
    ).toBe(0)
    expect(canvasScrollPlan(new Map(), keys(['a', 'b']), 2).reused.size).toBe(0)
  })
})
