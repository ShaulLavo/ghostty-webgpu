import { clearScreen, hideCursor, mix, type Rgb } from '../ansi.js'
import { CellBuffer } from '../cells.js'
import { PixelCanvas } from '../pixels.js'
import { dusk, pale, spectre } from '../theme.js'
import { AnimatedDemo } from './types.js'

interface Point {
  x: number
  y: number
  z: number
}

const VERTICES: readonly Point[] = [
  { x: -1, y: -1, z: -1 },
  { x: 1, y: -1, z: -1 },
  { x: 1, y: 1, z: -1 },
  { x: -1, y: 1, z: -1 },
  { x: -1, y: -1, z: 1 },
  { x: 1, y: -1, z: 1 },
  { x: 1, y: 1, z: 1 },
  { x: -1, y: 1, z: 1 },
]

const EDGES: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
]

function rotate(point: Point, ax: number, ay: number, az: number): Point {
  let { x, y, z } = point
  let cos = Math.cos(ax)
  let sin = Math.sin(ax)
  ;[y, z] = [y * cos - z * sin, y * sin + z * cos]
  cos = Math.cos(ay)
  sin = Math.sin(ay)
  ;[x, z] = [x * cos + z * sin, -x * sin + z * cos]
  cos = Math.cos(az)
  sin = Math.sin(az)
  ;[x, y] = [x * cos - y * sin, x * sin + y * cos]
  return { x, y, z }
}

export class CubeDemo extends AnimatedDemo {
  readonly id = 'cube'
  readonly label = 'Cube'
  readonly caption =
    'Two nested cubes turning against each other, drawn with half-block characters for twice the vertical resolution. Nearer edges glow, farther edges fade.'

  private readonly buffer = new CellBuffer()
  private canvas = new PixelCanvas(1, 1)

  protected layout(): void {
    const { cols, rows } = this.context!.grid()
    this.canvas = new PixelCanvas(cols, rows)
    this.context!.write(clearScreen + hideCursor)
    this.buffer.forget()
  }

  protected frame(_delta: number, elapsed: number): void {
    this.canvas.clear()
    const outer = { ax: elapsed * 0.7, ay: elapsed * 0.5, az: elapsed * 0.2, scale: 1 }
    const inner = { ax: -elapsed * 0.9, ay: elapsed * 0.35, az: -elapsed * 0.4, scale: 0.45 }
    this.drawCube(inner, mix(dusk, spectre, 0.5), spectre)
    this.drawCube(outer, dusk, pale)
    this.canvas.blit(this.buffer)
    this.buffer.flush((data) => this.context!.write(data))
  }

  private drawCube(
    spin: { ax: number; ay: number; az: number; scale: number },
    far: Rgb,
    near: Rgb,
  ): void {
    const canvas = this.canvas
    const radius = Math.min(canvas.width / 2, canvas.height / 2) * 0.62 * spin.scale
    const projected = VERTICES.map((vertex) => {
      const point = rotate(vertex, spin.ax, spin.ay, spin.az)
      const perspective = 3.2 / (3.2 + point.z * spin.scale)
      return {
        depth: (1 - point.z) / 2,
        x: canvas.width / 2 + point.x * radius * perspective,
        y: canvas.height / 2 + point.y * radius * perspective,
      }
    })
    for (const [from, to] of EDGES) {
      const a = projected[from]!
      const b = projected[to]!
      canvas.line(a.x, a.y, b.x, b.y, (t) => {
        const depth = a.depth + (b.depth - a.depth) * t
        return mix(far, near, depth)
      })
    }
  }
}
