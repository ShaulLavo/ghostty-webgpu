import { describe, expect, it } from 'vitest'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'

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
