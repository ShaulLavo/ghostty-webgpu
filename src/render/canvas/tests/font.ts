import type { TerminalFittedFont } from '../../../term/types.js'

export function fittedFont(pixelRatio = 1): TerminalFittedFont {
  return {
    charLeft: 0,
    charTop: 2 * pixelRatio,
    cssCellWidth: 10,
    cssCellHeight: 20,
    deviceCellWidth: 10 * pixelRatio,
    deviceCellHeight: 20 * pixelRatio,
    deviceCharWidth: 10 * pixelRatio,
    deviceCharHeight: 16 * pixelRatio,
    deviceBaseline: 16 * pixelRatio,
    pixelRatio,
    settings: {
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: 1.25,
      size: 16,
      weight: 400,
    },
  }
}
