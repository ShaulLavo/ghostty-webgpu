import { describe, expect, it } from 'vitest'
import type { RenderCell } from '../../core/types.js'
import { canonicalRendererTheme } from '../config.js'
import { defaultRendererTheme as rawDefaultRendererTheme } from '../instances/types.js'
import { CanvasColorCache, contrastAdjustedColor, resolveCanvasCellColors } from './colors.js'

const defaultRendererTheme = canonicalRendererTheme(rawDefaultRendererTheme)

function cell(overrides: Partial<RenderCell> = {}): RenderCell {
  return { continuation: false, selected: false, text: '', x: 0, ...overrides }
}

describe('Canvas cell colors', () => {
  it('keeps fractional RGB channels distinct from packed byte colors in the cache', () => {
    const cache = new CanvasColorCache(1)
    expect(cache.css({ r: 0, g: 0.5, b: 0 })).toBe('rgb(0, 0.5, 0)')
    expect(cache.css({ r: 0, g: 0, b: 128 })).toBe('rgb(0, 0, 128)')
    const contrastCache = new CanvasColorCache(1.2)
    const background = { r: 0, g: 0, b: 0 }
    expect(
      contrastCache.foreground({
        background,
        drawBackground: false,
        foreground: { r: 0, g: 0.5, b: 0 },
      }),
    ).toBe('rgb(255, 255, 255)')
    expect(
      contrastCache.foreground({
        background,
        drawBackground: false,
        foreground: { r: 0, g: 0, b: 128 },
      }),
    ).toBe('rgb(0, 0, 128)')
  })

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
    expect(cursor.foreground).toBe(defaultRendererTheme.cursorText)
  })

  it('uses explicit cursor text and falls back to the current background when omitted', () => {
    const background = { b: 30, g: 20, r: 10 }
    const fallbackTheme = canonicalRendererTheme({ ...rawDefaultRendererTheme, background })
    const fallback = resolveCanvasCellColors(cell(), fallbackTheme, true)
    expect(fallback.foreground).toBe(background)

    const cursorText = { b: 60, g: 50, r: 40 }
    const explicitTheme = canonicalRendererTheme({ ...rawDefaultRendererTheme, cursorText })
    const explicit = resolveCanvasCellColors(cell(), explicitTheme, true)
    expect(explicit.foreground).toBe(cursorText)
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
