import type { RenderCell, RgbColor } from '../../core/types.js'
import type { RendererTheme } from '../instances/types.js'

export interface CanvasCellColors {
  readonly background: RgbColor
  readonly drawBackground: boolean
  readonly foreground: RgbColor
}

function srgbChannelToLinear(value: number): number {
  const normalized = value / 255
  if (normalized <= 0.04045) return normalized / 12.92
  return ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(color: RgbColor): number {
  return (
    srgbChannelToLinear(color.r) * 0.2126 +
    srgbChannelToLinear(color.g) * 0.7152 +
    srgbChannelToLinear(color.b) * 0.0722
  )
}

function contrastRatio(first: RgbColor, second: RgbColor): number {
  const bright = Math.max(luminance(first), luminance(second))
  const dark = Math.min(luminance(first), luminance(second))
  return (bright + 0.05) / (dark + 0.05)
}

export function contrastAdjustedColor(
  foreground: RgbColor,
  background: RgbColor,
  minimum: number,
): RgbColor {
  if (minimum <= 1 || contrastRatio(foreground, background) >= minimum) return foreground
  const black = { b: 0, g: 0, r: 0 }
  const white = { b: 255, g: 255, r: 255 }
  if (contrastRatio(white, background) >= contrastRatio(black, background)) return white
  return black
}

export function cssRgb(color: RgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

export function resolveCanvasCellColors(
  cell: RenderCell,
  theme: RendererTheme,
  blockCursor: boolean,
): CanvasCellColors {
  let foreground = cell.foreground ?? theme.foreground
  let background = cell.background ?? theme.background
  let drawBackground = cell.background !== undefined
  if (cell.style?.inverse) {
    const previousForeground = foreground
    foreground = background
    background = previousForeground
    drawBackground = true
  }
  if (cell.selected) {
    foreground = theme.selectionForeground
    background = theme.selectionBackground
    drawBackground = true
  }
  if (!blockCursor) return { background, drawBackground, foreground }
  return { background: theme.cursor, drawBackground: true, foreground: theme.background }
}
