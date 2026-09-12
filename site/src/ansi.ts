export const ESC = '\x1b'
export const CSI = `${ESC}[`

export const reset = `${CSI}0m`
export const hideCursor = `${CSI}?25l`
export const showCursor = `${CSI}?25h`
export const clearScreen = `${CSI}2J${CSI}H`
export const syncStart = `${CSI}?2026h`
export const syncEnd = `${CSI}?2026l`

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export function rgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = Math.min(1, Math.max(0, amount))
  return {
    r: Math.round(from.r + (to.r - from.r) * t),
    g: Math.round(from.g + (to.g - from.g) * t),
    b: Math.round(from.b + (to.b - from.b) * t),
  }
}

export function fg(color: Rgb): string {
  return `${CSI}38;2;${color.r};${color.g};${color.b}m`
}

export function bg(color: Rgb): string {
  return `${CSI}48;2;${color.r};${color.g};${color.b}m`
}

/** Rows and columns are zero-based here; the terminal wants one-based. */
export function cup(row: number, col: number): string {
  return `${CSI}${row + 1};${col + 1}H`
}
