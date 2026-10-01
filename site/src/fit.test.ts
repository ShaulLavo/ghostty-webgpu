import { expect, test } from 'vitest'
import { fittedScreenHeight, roundedFitPadding } from './fit'

const padding = { bottom: 12, left: 16, right: 16, top: 12 }

test('rounds each inset independently before fitting the screen height', () => {
  const ratio = 1.3
  const rounded = roundedFitPadding(padding, ratio)
  expect(rounded).toEqual({
    bottom: 16 / ratio,
    left: 21 / ratio,
    right: 21 / ratio,
    top: 16 / ratio,
  })
  const cellHeight = 18 / ratio
  const oldHeight = Math.ceil(40 * cellHeight) + padding.top + padding.bottom
  expect(Math.floor((oldHeight - rounded.top - rounded.bottom) / cellHeight)).toBe(39)
  expect(fittedScreenHeight(40, cellHeight, rounded)).toBe(580)
})

test.each([1, 1.1, 1.25, 1.3, 1.2999999523162842, 1.5, 1.75, 2, 2.625, 3])(
  'keeps exactly forty rows with whole and fractional pixel ratio %s',
  (ratio) => {
    const rounded = roundedFitPadding(padding, ratio)
    const cellHeight = Math.ceil(13 * ratio) / ratio
    const height = fittedScreenHeight(40, cellHeight, rounded)
    const rows = Math.floor((height - rounded.top - rounded.bottom) / cellHeight)
    expect(Number.isInteger(height)).toBe(true)
    expect(rows).toBe(40)
  },
)
