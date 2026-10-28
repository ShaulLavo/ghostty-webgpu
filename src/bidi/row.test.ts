import { describe, expect, it } from 'vitest'
import { RowBidiMapper } from './row.js'

const cases = [
  ['ab שלום cd', [0, 1, 2, 6, 5, 4, 3, 7, 8, 9]],
  ['אב 12 גד', [7, 6, 5, 3, 4, 2, 1, 0]],
  ['א(ב)ג', [4, 3, 2, 1, 0]],
  ['عربي ٤٥٦', [5, 6, 7, 4, 3, 2, 1, 0]],
  ['א:אa', [2, 1, 0, 3]],
] as const

describe('fixed LTR cell BiDi', () => {
  it.each(cases)('maps %s without changing logical cells', (text, expected) => {
    const cells = Array.from(text, (text) => ({ text, continuation: false })).concat(
      Array.from({ length: 40 - Array.from(text).length }, () => ({
        text: '',
        continuation: false,
      })),
    )
    const map = new RowBidiMapper().getMap(cells)
    expect(map.visualToLogical.slice(0, expected.length)).toEqual(expected)
    expect(map.visualToLogical.slice(expected.length)).toEqual(
      Array.from({ length: 40 - expected.length }, (_, i) => i + expected.length),
    )
    for (const [visual, logical] of map.visualToLogical.entries())
      expect(map.logicalToVisual[logical]).toBe(visual)
  })
  it('fuses wide pairs and mirrors only paint', () => {
    const cells = ['a', 'א', '❤️', '', 'ב', 'z'].map((text, x) => ({ text, continuation: x === 3 }))
    expect(new RowBidiMapper().getMap(cells).visualToLogical).toEqual([0, 4, 2, 3, 1, 5])
    const brackets = Array.from('א(ב)ג', (text) => ({ text, continuation: false }))
    expect(Array.from(new RowBidiMapper().getMap(brackets).mirror)).toEqual([
      [1, ')'],
      [3, '('],
    ])
  })
})
