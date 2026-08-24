import { describe, expect, it } from 'vitest'
import type { TerminalFontSettings } from '../../term/types.js'
import { calculateTerminalFittedFont, type TerminalFontMeasurement } from '../fit.js'
import { projectPointerPosition, type CommittedPointerLayout } from '../pointer.js'

const measurement: TerminalFontMeasurement = {
  advanceWidth: 8.4,
  fontAscent: 10.25,
  fontDescent: 3.75,
}

function font(overrides: Partial<TerminalFontSettings> = {}): TerminalFontSettings {
  return {
    boldWeight: 700,
    family: 'monospace',
    letterSpacing: 0,
    lineHeight: 1.2,
    size: 14,
    weight: 400,
    ...overrides,
  }
}

function pointerLayout(
  fitted: ReturnType<typeof calculateTerminalFittedFont>,
  columns: number,
  rows: number,
): CommittedPointerLayout {
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as unknown as HTMLCanvasElement
  return {
    canvas,
    grid: {
      cellHeight: fitted.cssCellHeight,
      cellWidth: fitted.cssCellWidth,
      columns,
      pixelRatio: fitted.pixelRatio,
      rows,
    },
    physical: {
      deviceCellHeight: fitted.deviceCellHeight,
      deviceCellWidth: fitted.deviceCellWidth,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      screenHeight: fitted.deviceCellHeight * rows,
      screenWidth: fitted.deviceCellWidth * columns,
    },
  }
}

describe('calculateTerminalFittedFont', () => {
  it('derives one integer device grid without cumulative CSS drift at target DPRs', () => {
    for (const pixelRatio of [1, 1.25, 1.5, 2, 2.2]) {
      for (const settings of [
        font(),
        font({ letterSpacing: 0.75, lineHeight: 1 }),
        font({ letterSpacing: -0.5, lineHeight: 1.5, size: 17 }),
      ]) {
        const fitted = calculateTerminalFittedFont(settings, measurement, pixelRatio)
        expect(Number.isSafeInteger(fitted.deviceCharWidth)).toBe(true)
        expect(Number.isSafeInteger(fitted.deviceCharHeight)).toBe(true)
        expect(Number.isSafeInteger(fitted.deviceCellWidth)).toBe(true)
        expect(Number.isSafeInteger(fitted.deviceCellHeight)).toBe(true)
        expect(fitted.cssCellWidth * pixelRatio).toBeCloseTo(fitted.deviceCellWidth, 12)
        expect(fitted.cssCellHeight * pixelRatio).toBeCloseTo(fitted.deviceCellHeight, 12)
        expect(fitted.cssCellWidth * pixelRatio * 200).toBeCloseTo(fitted.deviceCellWidth * 200, 10)
        expect(fitted.cssCellHeight * pixelRatio * 100).toBeCloseTo(
          fitted.deviceCellHeight * 100,
          10,
        )
        expect(calculateTerminalFittedFont(settings, measurement, pixelRatio)).toEqual(fitted)
        expect(Object.isFrozen(fitted)).toBe(true)
        expect(Object.isFrozen(fitted.settings)).toBe(true)
      }
    }
  })

  it('keeps character geometry distinct from spacing and line-height placement', () => {
    const regular = calculateTerminalFittedFont(font(), measurement, 2)
    const spaced = calculateTerminalFittedFont(
      font({ letterSpacing: 1.25, lineHeight: 1.5 }),
      measurement,
      2,
    )

    expect(spaced.deviceCharWidth).toBe(regular.deviceCharWidth)
    expect(spaced.deviceCharHeight).toBe(regular.deviceCharHeight)
    expect(spaced.deviceCellWidth).toBe(regular.deviceCellWidth + 3)
    expect(spaced.deviceCellHeight).toBe(Math.floor(spaced.deviceCharHeight * 1.5))
    expect(spaced.charLeft).toBe(1)
    expect(spaced.charTop).toBe(Math.round((spaced.deviceCellHeight - spaced.deviceCharHeight) / 2))
    expect(calculateTerminalFittedFont(font({ lineHeight: 1 }), measurement, 2).charTop).toBe(0)
  })

  it('rejects negative spacing only when it collapses the fitted device cell', () => {
    expect(
      calculateTerminalFittedFont(font({ letterSpacing: -1 }), measurement, 1).deviceCellWidth,
    ).toBe(7)
    expect(() => calculateTerminalFittedFont(font({ letterSpacing: -9 }), measurement, 1)).toThrow(
      /device cell width/u,
    )
  })

  it('projects the first and last CSS pixels through the same device grid', () => {
    const fitted = calculateTerminalFittedFont(font({ letterSpacing: 0.5 }), measurement, 1.5)
    const layout = pointerLayout(fitted, 80, 24)
    const first = projectPointerPosition({ clientX: 0, clientY: 0 } as MouseEvent, layout)
    const last = projectPointerPosition(
      {
        clientX: fitted.cssCellWidth * 80 - Number.EPSILON,
        clientY: fitted.cssCellHeight * 24 - Number.EPSILON,
      } as MouseEvent,
      layout,
    )

    expect(first.selection.viewport).toEqual({ x: 0, y: 0 })
    expect(last.selection.viewport).toEqual({ x: 79, y: 23 })
  })
})
