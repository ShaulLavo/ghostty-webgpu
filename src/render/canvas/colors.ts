import type { RenderCell, RgbColor } from '../../core/types.js'
import { contrastAdjustedColor } from '../shared/contrast.js'
import type { CanonicalRendererTheme } from '../shared/instances/types.js'

export interface CanvasCellColors {
  background: RgbColor
  drawBackground: boolean
  foreground: RgbColor
}

function cssRgb(color: RgbColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

function rgbKey(color: RgbColor): number | string {
  if (color.r !== (color.r & 255) || color.g !== (color.g & 255) || color.b !== (color.b & 255)) {
    return cssRgb(color)
  }
  return color.r * 65_536 + color.g * 256 + color.b
}

function sameRgb(left: RgbColor, right: RgbColor): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b
}

function copyRgb(target: RgbColor, color: RgbColor): void {
  target.r = color.r
  target.g = color.g
  target.b = color.b
}

export class CanvasColorCache {
  private readonly foregrounds = new Map<number | string, string>()
  private readonly colors = new Map<number | string, string>()
  // Packed rows can reuse RGB objects for different values.
  private readonly lastColor: RgbColor = { r: 0, g: 0, b: 0 }
  private readonly lastForeground: RgbColor = { r: 0, g: 0, b: 0 }
  private readonly lastBackground: RgbColor = { r: 0, g: 0, b: 0 }
  private lastCss?: string
  private lastAdjusted?: string

  constructor(private readonly minimumContrast: number) {}

  css(color: RgbColor): string {
    if (this.lastCss !== undefined && sameRgb(color, this.lastColor)) return this.lastCss
    copyRgb(this.lastColor, color)
    this.lastCss = this.lookupCss(color)
    return this.lastCss
  }

  private lookupCss(color: RgbColor): string {
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
    if (
      this.lastAdjusted !== undefined &&
      sameRgb(colors.foreground, this.lastForeground) &&
      sameRgb(colors.background, this.lastBackground)
    )
      return this.lastAdjusted
    copyRgb(this.lastForeground, colors.foreground)
    copyRgb(this.lastBackground, colors.background)
    this.lastAdjusted = this.lookupForeground(colors)
    return this.lastAdjusted
  }

  private lookupForeground(colors: CanvasCellColors): string {
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
  target?: CanvasCellColors,
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
  if (blockCursor) {
    foreground = theme.cursorText
    background = theme.cursor
    drawBackground = true
  }
  if (!target) return { background, drawBackground, foreground }
  target.background = background
  target.drawBackground = drawBackground
  target.foreground = foreground
  return target
}
