import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { nerdFontConstraint } from './nerd-font-constraints.js'

it('preserves the Ghostty constraints across the full Unicode range', () => {
  const hash = createHash('sha256')
  let count = 0
  let min = -1
  let max = -1

  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const constraint = nerdFontConstraint(cp)
    if (!constraint) continue
    if (min === -1) min = cp
    max = cp
    count++
    const fields = Object.entries(constraint).sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
    const entry = JSON.stringify([cp, fields], (_key, value: unknown) =>
      Object.is(value, -0) ? '-0' : value,
    )
    hash.update(entry + '\n')
  }

  expect(count).toBe(10_410)
  expect(min).toBe(0x23fb)
  expect(max).toBe(0xf1af0)
  expect(hash.digest('hex')).toBe(
    'f85e76dc8ba9e7a97b43d3708760d4fed729356dd61e3088b684fa2b81028256',
  )
})

it('keeps the Powerline separator settings', () => {
  expect(nerdFontConstraint(0xe0b0)).toEqual({
    alignHorizontal: 'start',
    alignVertical: 'center1',
    height: 'cell',
    maxConstraintWidth: 1,
    maxXyRatio: 0.7,
    padBottom: -0.005,
    padLeft: -0.03,
    padRight: -0.03,
    padTop: -0.005,
    relativeHeight: 1,
    relativeWidth: 1,
    relativeX: 0,
    relativeY: 0,
    size: 'stretch',
  })
})

it('keeps relative sizing for a Nerd Font weather icon', () => {
  expect(nerdFontConstraint(0xe300)).toMatchObject({
    height: 'icon',
    maxXyRatio: null,
    relativeHeight: 0.8984375,
    relativeY: 0.0986328125,
    size: 'fit_cover1',
  })
})

it('returns undefined for unassigned and invalid codepoints', () => {
  for (const cp of [0x41, 0xe9, 0x23fa, 0xe0b0 + 0.5, 0xf0000, 0xf1af1, -1, 0x110000, NaN]) {
    expect(nerdFontConstraint(cp)).toBeUndefined()
  }
})
