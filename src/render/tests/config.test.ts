import { calculateTerminalFittedFont } from '../../dom/fit.js'
import { describe, expect, it } from 'vitest'
import { canonicalRendererTheme, copyFittedFont, mergeRendererTheme } from '../config.js'

describe('renderer theme canonicalization', () => {
  it('tracks background while cursor text is omitted and preserves explicit cursor text', () => {
    const firstBackground = { b: 3, g: 2, r: 1 }
    let input = mergeRendererTheme({ background: firstBackground })
    expect(canonicalRendererTheme(input).cursorText).toBe(firstBackground)

    const secondBackground = { b: 6, g: 5, r: 4 }
    input = mergeRendererTheme({ ...input, background: secondBackground })
    expect(canonicalRendererTheme(input).cursorText).toBe(secondBackground)

    const cursorText = { b: 9, g: 8, r: 7 }
    input = mergeRendererTheme({ ...input, cursorText })
    input = mergeRendererTheme({
      ...input,
      selectionBackground: { b: 12, g: 11, r: 10 },
    })
    expect(canonicalRendererTheme(input).cursorText).toBe(cursorText)
  })
})

it('accepts centred short-line fitted geometry', () => {
  const font = calculateTerminalFittedFont(
    {
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: 0.6,
      size: 20,
      weight: 400,
    },
    { advanceWidth: 12, fontAscent: 16, fontDescent: 4 },
    1,
  )
  expect(copyFittedFont(font)).toEqual(font)
  expect(font.deviceCellHeight).toBe(12)
  expect(font.charTop).toBe(-4)
  for (const lineHeight of [0.49, 0, -1, NaN, Infinity]) {
    expect(() => copyFittedFont({ ...font, settings: { ...font.settings, lineHeight } })).toThrow(
      /lineHeight/u,
    )
  }
  expect(() => copyFittedFont({ ...font, charTop: -4.5 })).toThrow(/charTop/u)
  expect(() => copyFittedFont({ ...font, deviceBaseline: 0 })).toThrow(/deviceBaseline/u)
})
