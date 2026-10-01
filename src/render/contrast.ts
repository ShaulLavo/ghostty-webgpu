import type { RgbColor } from '../core/types.js'

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
