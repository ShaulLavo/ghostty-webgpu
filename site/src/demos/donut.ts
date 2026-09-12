import { clearScreen, fg, hideCursor, mix, type Rgb } from '../ansi.js'
import { CellBuffer } from '../cells.js'
import { dusk, pale, spectre } from '../theme.js'
import { AnimatedDemo } from './types.js'

const SHADES = '.,-~:;=!*#$@'
const R1 = 1
const R2 = 2
const K2 = 5

export class DonutDemo extends AnimatedDemo {
  readonly id = 'donut'
  readonly label = 'Donut'
  readonly caption =
    'The torus everyone writes once, shaded in 24-bit color. Every visible cell changes every frame, so this is the busy case.'

  private readonly buffer = new CellBuffer()
  private cols = 0
  private rows = 0
  private depth = new Float32Array(0)
  private shade = new Float32Array(0)
  private readonly ramp: Rgb[] = []

  protected layout(): void {
    const { cols, rows } = this.context!.grid()
    this.cols = cols
    this.rows = rows
    this.depth = new Float32Array(cols * rows)
    this.shade = new Float32Array(cols * rows)
    this.context!.write(clearScreen + hideCursor)
    this.buffer.forget()
    if (this.ramp.length > 0) return
    for (let i = 0; i < SHADES.length; i += 1) {
      const t = i / (SHADES.length - 1)
      this.ramp.push(t < 0.6 ? mix(dusk, pale, t / 0.6) : mix(pale, spectre, (t - 0.6) / 0.4))
    }
  }

  protected frame(_delta: number, elapsed: number): void {
    const a = elapsed * 0.9
    const b = elapsed * 0.45
    const cols = this.cols
    const rows = this.rows
    this.depth.fill(0)
    this.shade.fill(-2)

    // Fit the outer ring inside the grid; cells are about twice as tall as wide.
    const k1 = Math.min(rows * 1.15, cols * 0.58)
    const cosA = Math.cos(a)
    const sinA = Math.sin(a)
    const cosB = Math.cos(b)
    const sinB = Math.sin(b)
    for (let theta = 0; theta < Math.PI * 2; theta += 0.07) {
      const cosT = Math.cos(theta)
      const sinT = Math.sin(theta)
      for (let phi = 0; phi < Math.PI * 2; phi += 0.02) {
        const cosP = Math.cos(phi)
        const sinP = Math.sin(phi)
        const circleX = R2 + R1 * cosT
        const circleY = R1 * sinT
        const x = circleX * (cosB * cosP + sinA * sinB * sinP) - circleY * cosA * sinB
        const y = circleX * (sinB * cosP - sinA * cosB * sinP) + circleY * cosA * cosB
        const z = K2 + cosA * circleX * sinP + circleY * sinA
        const ooz = 1 / z
        const col = Math.floor(cols / 2 + k1 * ooz * x)
        const row = Math.floor(rows / 2 - k1 * ooz * y * 0.5)
        if (col < 0 || col >= cols || row < 0 || row >= rows) continue
        const index = row * cols + col
        if (ooz <= this.depth[index]!) continue
        const luminance =
          cosP * cosT * sinB -
          cosA * cosT * sinP -
          sinA * sinT +
          cosB * (cosA * sinT - cosT * sinA * sinP)
        this.depth[index] = ooz
        this.shade[index] = luminance
      }
    }

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const luminance = this.shade[row * cols + col]!
        if (luminance <= 0) continue
        const level = Math.min(SHADES.length - 1, Math.floor(luminance * 8))
        this.buffer.set(row, col, SHADES[level]!, fg(this.ramp[level]!))
      }
    }
    this.buffer.flush((data) => this.context!.write(data))
  }
}
