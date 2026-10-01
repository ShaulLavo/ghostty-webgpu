import { clearScreen, fg, hideCursor, type Rgb } from '../ansi.js'
import { CellBuffer } from '../cells.js'
import { ink, pale, spectre } from '../theme.js'
import { AnimatedDemo } from './types.js'

// Half-width katakana and digits are one cell wide everywhere.
const GLYPHS = [...'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:=*+<>']
const SHADES = 10
const MUTATION_CHANCE = 0.12
const numberFormat = new Intl.NumberFormat('en-US')

interface Drop {
  head: number
  length: number
  speed: number
  /** Seconds to wait before falling again after leaving the screen. */
  rest: number
}

function lerp(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    b: Math.round(from.b + (to.b - from.b) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    r: Math.round(from.r + (to.r - from.r) * amount),
  }
}

// Shade 0 is the head; the trail fades from spectre toward the background.
const shadeStyles = Array.from({ length: SHADES }, (_, shade) => {
  if (shade === 0) return fg(pale)
  return fg(lerp(spectre, ink, (shade / SHADES) ** 1.4))
})

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!
}

export class MatrixDemo extends AnimatedDemo {
  readonly id = 'matrix'
  readonly label = 'Matrix'
  readonly caption =
    'Rain in every column at once. The figure under the window counts the cells each frame changes.'
  // The ghost's grid, so switching tabs keeps the window still.
  readonly fit = { cols: 78, rows: 40 }

  private readonly buffer = new CellBuffer()
  private drops: Drop[] = []
  private glyphs: string[][] = []

  protected layout(): void {
    const { cols, rows } = this.context!.grid()
    this.context!.write(clearScreen + hideCursor)
    this.buffer.forget()
    this.glyphs = Array.from({ length: rows }, () => Array.from({ length: cols }, randomGlyph))
    this.drops = Array.from({ length: cols }, () => this.newDrop(rows, true))
  }

  protected frame(delta: number): void {
    const context = this.context!
    const { cols, rows } = context.grid()
    if (this.drops.length !== cols || this.glyphs.length !== rows) this.layout()
    this.mutate(rows, cols)
    for (let col = 0; col < cols; col += 1) this.drawDrop(col, rows, delta)
    const written = this.buffer.flush((data) => context.write(data))
    context.stat(
      `${numberFormat.format(written)} of ${numberFormat.format(cols * rows)} cells redrawn this frame`,
    )
  }

  private newDrop(rows: number, scatter: boolean): Drop {
    const length = 6 + Math.floor(Math.random() * Math.max(6, rows * 0.6))
    return {
      head: scatter ? Math.random() * (rows + length) : -1,
      length,
      rest: scatter ? 0 : Math.random() * 1.5,
      speed: 12 + Math.random() * 30,
    }
  }

  private mutate(rows: number, cols: number): void {
    const count = Math.ceil(rows * cols * MUTATION_CHANCE)
    for (let i = 0; i < count; i += 1) {
      const row = this.glyphs[Math.floor(Math.random() * rows)]!
      row[Math.floor(Math.random() * cols)] = randomGlyph()
    }
  }

  private drawDrop(col: number, rows: number, delta: number): void {
    const drop = this.drops[col]!
    if (drop.rest > 0) {
      drop.rest -= delta
      return
    }
    drop.head += drop.speed * delta
    if (drop.head - drop.length > rows) {
      this.drops[col] = this.newDrop(rows, false)
      return
    }
    const head = Math.floor(drop.head)
    for (let offset = 0; offset < drop.length; offset += 1) {
      const row = head - offset
      if (row < 0 || row >= rows) continue
      const shade = offset === 0 ? 0 : 1 + Math.floor((offset / drop.length) * (SHADES - 1))
      this.buffer.set(row, col, this.glyphs[row]![col]!, shadeStyles[shade])
    }
  }
}
