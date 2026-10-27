import { describe, expect, it } from 'vitest'
import {
  constrainGlyph,
  glyphConstraint,
  isSymbol,
  neighborConstraintWidth,
  type GlyphBounds,
  type GlyphConstraintMetrics,
} from './glyph-constraints.js'

const metrics: GlyphConstraintMetrics = {
  cellHeight: 22,
  cellWidth: 10,
  faceHeight: 21.12,
  faceWidth: 9.6,
  faceY: 0.2,
  iconHeight: 21.12,
  iconHeightSingle: 44.48 / 3,
}

function expectBounds(actual: GlyphBounds, expected: GlyphBounds): void {
  expect(actual.x).toBeCloseTo(expected.x, 10)
  expect(actual.y).toBeCloseTo(expected.y, 10)
  expect(actual.width).toBeCloseTo(expected.width, 10)
  expect(actual.height).toBeCloseTo(expected.height, 10)
}

describe('pinned Ghostty constraint vectors', () => {
  it('fits a symbol only when it exceeds the available width', () => {
    const glyph = { width: 10.272, height: 10.272, x: 2.864, y: 5.304 }
    const constraint = glyphConstraint(0x2190)!

    expectBounds(constrainGlyph(glyph, constraint, metrics, 1), {
      width: 9.6,
      height: 9.6,
      x: 0,
      y: 5.64,
    })
    expectBounds(constrainGlyph(glyph, constraint, metrics, 2), glyph)
  })

  it('applies the default Nerd Font group scale and center1 alignment', () => {
    const glyph = { width: 9.015625, height: 13.015625, x: 3.015625, y: 3.76525 }
    const constraint = glyphConstraint(0xea61)!
    expect(constraint).toMatchObject({
      alignHorizontal: 'center1',
      alignVertical: 'center1',
      height: 'icon',
      size: 'fit_cover1',
    })

    expectBounds(constrainGlyph(glyph, constraint, metrics, 1), {
      width: 7.2125,
      height: 10.4125,
      x: 0.8125,
      y: 5.950695224719102,
    })
    expectBounds(constrainGlyph(glyph, constraint, metrics, 2), {
      width: glyph.width,
      height: glyph.height,
      x: 1.015625,
      y: 4.7483690308988775,
    })
  })

  it('stretches powerline glyphs to the grid in both axes', () => {
    const glyph = { width: 16.796875, height: 16.46875, x: -0.796875, y: 1.7109375 }
    const constraint = glyphConstraint(0xe0c0)!
    expect(constraint).toMatchObject({
      alignHorizontal: 'start',
      alignVertical: 'center1',
      height: 'cell',
      size: 'stretch',
    })

    expectBounds(constrainGlyph(glyph, constraint, metrics, 1), {
      width: 10,
      height: 22,
      x: 0,
      y: 0,
    })
    expectBounds(constrainGlyph(glyph, constraint, metrics, 2), {
      width: 20,
      height: 22,
      x: 0,
      y: 0,
    })
  })
})

it('derives available width from native neighbor rules', () => {
  const symbol = 0xe8ef
  const powerline = 0xe0b2
  expect(neighborConstraintWidth([symbol, 0, 0, 0], 0)).toBe(2)
  expect(neighborConstraintWidth([symbol, 0x7a, 0, 0], 0)).toBe(1)
  expect(neighborConstraintWidth([symbol, 0x20, 0x7a, 0], 0)).toBe(2)
  expect(neighborConstraintWidth([symbol, 0xa0, 0x7a, 0], 0)).toBe(1)
  expect(neighborConstraintWidth([0x20, 0x20, 0x20, symbol], 3)).toBe(1)
  expect(neighborConstraintWidth([0x7a, symbol, 0, 0], 1)).toBe(2)
  expect(neighborConstraintWidth([symbol, symbol, 0, 0], 0)).toBe(1)
  expect(neighborConstraintWidth([symbol, symbol, 0, 0], 1)).toBe(1)
  expect(neighborConstraintWidth([symbol, 0x20, symbol, 0], 0)).toBe(2)
  expect(neighborConstraintWidth([symbol, 0x20, symbol, 0], 2)).toBe(2)
  expect(neighborConstraintWidth([symbol, 0xe0b0, 0, 0], 0)).toBe(1)
  expect(neighborConstraintWidth([powerline, symbol, 0, 0], 1)).toBe(2)
  expect(neighborConstraintWidth([0x41, 0, 0, 0], 0)).toBe(1)
})

it('uses native symbol blocks and leaves ordinary text unconstrained', () => {
  expect(glyphConstraint(0x41)).toBeUndefined()
  expect(glyphConstraint(0x30a2)).toBeUndefined()
  expect(glyphConstraint(0x2630)).toBeDefined()
  expect(isSymbol(0x2190)).toBe(true)
  expect(isSymbol(0x2b00)).toBe(false)
  expect(isSymbol(0xe000)).toBe(true)
  expect(isSymbol(0xf0000)).toBe(true)
})
