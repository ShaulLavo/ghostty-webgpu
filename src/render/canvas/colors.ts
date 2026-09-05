import type { RenderCell, RgbColor } from '../../core/types.js'
import type { CanonicalRendererTheme } from '../instances/types.js'

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
  const firstLuminance = luminance(first)
  const secondLuminance = luminance(second)
  const bright = Math.max(firstLuminance, secondLuminance)
  const dark = Math.min(firstLuminance, secondLuminance)
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

function rgbKey(color: RgbColor): number | string {
  if (color.r !== (color.r & 255) || color.g !== (color.g & 255) || color.b !== (color.b & 255)) {
    return cssRgb(color)
  }
  return color.r * 65_536 + color.g * 256 + color.b
}

export class CanvasColorCache {
  private readonly foregrounds = new Map<number | string, string>()
  private readonly colors = new Map<number | string, string>()

  constructor(private readonly minimumContrast: number) {}

  css(color: RgbColor): string {
    const key = rgbKey(color)
    const cached = this.colors.get(key)
    if (cached !== undefined) return cached
    const value = typeof key === 'string' ? key : cssRgb(color)
    if (this.colors.size >= 1_024) this.colors.clear()
    this.colors.set(key, value)
    return value
  }

  foreground(colors: CanvasCellColors): string {
    if (this.minimumContrast <= 1) return this.css(colors.foreground)
    const foreground = rgbKey(colors.foreground)
    const background = rgbKey(colors.background)
    const key =
      typeof foreground === 'number' && typeof background === 'number'
        ? foreground * 16_777_216 + background
        : `${foreground}/${background}`
    const cached = this.foregrounds.get(key)
    if (cached !== undefined) return cached
    const adjusted = contrastAdjustedColor(
      colors.foreground,
      colors.background,
      this.minimumContrast,
    )
    const value = this.css(adjusted)
    if (this.foregrounds.size >= 1_024) this.foregrounds.clear()
    this.foregrounds.set(key, value)
    return value
  }
}

export function resolveCanvasCellColors(
  cell: RenderCell,
  theme: CanonicalRendererTheme,
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
  return { background: theme.cursor, drawBackground: true, foreground: theme.cursorText }
}
