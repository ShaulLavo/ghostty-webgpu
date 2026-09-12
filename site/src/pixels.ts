import { bg, fg, type Rgb } from './ansi.js'
import type { CellBuffer } from './cells.js'

/**
 * A pixel canvas with twice the vertical resolution of the cell grid.
 * Each cell shows two pixels stacked, using the upper and lower half blocks.
 */
export class PixelCanvas {
  readonly width: number
  readonly height: number
  private readonly pixels: (Rgb | undefined)[]

  constructor(cols: number, rows: number) {
    this.width = cols
    this.height = rows * 2
    this.pixels = Array.from({ length: this.width * this.height }, () => undefined)
  }

  clear(): void {
    this.pixels.fill(undefined)
  }

  put(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    this.pixels[y * this.width + x] = color
  }

  get(x: number, y: number): Rgb | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined
    return this.pixels[y * this.width + x]
  }

  line(x0: number, y0: number, x1: number, y1: number, color: (t: number) => Rgb): void {
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const steps = Math.max(dx, dy, 1)
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      this.put(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), color(t))
    }
  }

  blit(buffer: CellBuffer, originCol = 0, originRow = 0): void {
    for (let row = 0; row < this.height / 2; row += 1) {
      for (let col = 0; col < this.width; col += 1) {
        const top = this.pixels[row * 2 * this.width + col]
        const bottom = this.pixels[(row * 2 + 1) * this.width + col]
        if (!top && !bottom) continue
        buffer.set(originRow + row, originCol + col, ...halfBlock(top, bottom))
      }
    }
  }
}

export function halfBlock(top: Rgb | undefined, bottom: Rgb | undefined): [string, string] {
  if (top && bottom) {
    if (top.r === bottom.r && top.g === bottom.g && top.b === bottom.b) return ['█', fg(top)]
    return ['▀', fg(top) + bg(bottom)]
  }
  if (top) return ['▀', fg(top)]
  if (bottom) return ['▄', fg(bottom)]
  return [' ', '']
}
