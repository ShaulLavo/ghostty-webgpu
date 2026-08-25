import { describe, expect, it } from 'vitest'
import type { RenderCell } from '../../core/types.js'
import { defaultRendererTheme } from '../instances/types.js'
import { contrastAdjustedColor, resolveCanvasCellColors } from './colors.js'

function cell(overrides: Partial<RenderCell> = {}): RenderCell {
  return { continuation: false, selected: false, text: '', x: 0, ...overrides }
}

describe('Canvas cell colors', () => {
  it('preserves inverse, selection, and block-cursor precedence', () => {
    const inverse = resolveCanvasCellColors(
      cell({
        background: { b: 30, g: 20, r: 10 },
        foreground: { b: 60, g: 50, r: 40 },
        style: {
          blink: false,
          bold: false,
          faint: false,
          invisible: false,
          inverse: true,
          italic: false,
          overline: false,
          strikethrough: false,
          underline: 0,
        },
      }),
      defaultRendererTheme,
      false,
    )
    expect(inverse).toEqual({
      background: { b: 60, g: 50, r: 40 },
      drawBackground: true,
      foreground: { b: 30, g: 20, r: 10 },
    })

    const selected = resolveCanvasCellColors(cell({ selected: true }), defaultRendererTheme, false)
    expect(selected.background).toBe(defaultRendererTheme.selectionBackground)
    expect(selected.foreground).toBe(defaultRendererTheme.selectionForeground)
    expect(selected.drawBackground).toBe(true)

    const cursor = resolveCanvasCellColors(cell({ selected: true }), defaultRendererTheme, true)
    expect(cursor.background).toBe(defaultRendererTheme.cursor)
    expect(cursor.foreground).toBe(defaultRendererTheme.background)
  })

  it('uses the same black-or-white minimum-contrast fallback as the shaders', () => {
    expect(contrastAdjustedColor({ b: 120, g: 120, r: 120 }, { b: 0, g: 0, r: 0 }, 21)).toEqual({
      b: 255,
      g: 255,
      r: 255,
    })
    expect(
      contrastAdjustedColor({ b: 120, g: 120, r: 120 }, { b: 255, g: 255, r: 255 }, 21),
    ).toEqual({ b: 0, g: 0, r: 0 })
  })
})
