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

  it.each([
    { text: 'abc (123), $2', continuations: [], identity: true },
    { text: 'éå ΩЖ ㌀', continuations: [], identity: false },
    { text: 'éå ΩЖ 5', continuations: [2], identity: true },
    { text: ' abc', continuations: [0], identity: false },
    { text: 'A  B', continuations: [1, 2], identity: false },
    { text: 'ab א(ב)ج ١٢', continuations: [], identity: false },
    { text: 'aא😀 ב𐤀', continuations: [3], identity: false },
    { text: '', continuations: [], identity: true },
  ])(
    'matches the full BiDi algorithm for $text with continuations at $continuations',
    ({ text, continuations, identity }) => {
      const cells = Array.from(text, (text, index) => ({
        text,
        continuation: continuations.includes(index),
      }))
      const mapper = new RowBidiMapper()
      const map = mapper.getMap(cells)
      const full = mapper['compute'](cells)
      expect(map).toEqual({ ...full, identity })
    },
  )

  it('reuses identity maps for different rows of the same width', () => {
    const mapper = new RowBidiMapper()
    const map = mapper.getMap([
      { text: 'A', continuation: false },
      { text: '', continuation: false },
    ])
    expect(
      mapper.getMap([
        { text: 'Ω', continuation: false },
        { text: '', continuation: true },
      ]),
    ).toBe(map)
    expect(mapper.getMap([])).not.toBe(map)
  })

  it('keys complex maps by the first code point and effective continuation', () => {
    const mapper = new RowBidiMapper()
    const cells = [
      { text: 'א', continuation: false },
      { text: '𐤀', continuation: false },
      { text: '', continuation: true },
    ]
    const map = mapper.getMap(cells)
    expect(
      mapper.getMap([
        { text: 'א\u0301', continuation: false },
        { text: '𐤀 extra', continuation: false },
        { text: 'ignored', continuation: true },
      ]),
    ).toBe(map)

    const differentScalar = [cells[0]!, { text: '\u0900', continuation: false }, cells[2]!]
    expect(mapper.getMap(differentScalar)).not.toBe(map)
    expect(mapper.getMap(differentScalar)).toEqual(mapper['compute'](differentScalar))
    const split = [
      cells[0]!,
      { text: cells[1]!.text[0]!, continuation: false },
      { text: cells[1]!.text[1]!, continuation: false },
    ]
    expect(mapper.getMap(split)).not.toBe(map)
    expect(mapper.getMap(split)).toEqual(mapper['compute'](split))
    expect(mapper.getMap([cells[0]!, cells[1]!, { text: '', continuation: false }])).not.toBe(map)
  })
})
