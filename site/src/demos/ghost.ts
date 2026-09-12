import { clearScreen, fg, hideCursor, mix } from '../ansi.js'
import { CellBuffer } from '../cells.js'
import { drawGhost, SPRITE_ROWS, SPRITE_WIDTH } from '../sprite.js'
import { dusk, ink, spectre } from '../theme.js'
import { AnimatedDemo } from './types.js'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
}

const SPEED_COLS = 7
const SPEED_ROWS = 2.2
const CURSOR_ON_SECONDS = 0.75
const CURSOR_OFF_SECONDS = 0.4
const numberFormat = new Intl.NumberFormat('en-US')

function random(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

export class GhostDemo extends AnimatedDemo {
  readonly id = 'ghost'
  readonly label = 'Ghost'
  readonly caption =
    'The ghost drifts across the grid. Only the cells it touches are redrawn, and the count at the bottom says how many.'

  private readonly buffer = new CellBuffer()
  private x = 0
  private y = 0
  private vx = SPEED_COLS
  private vy = SPEED_ROWS * 0.4
  private targetVx = SPEED_COLS
  private targetVy = SPEED_ROWS * 0.4
  private retargetIn = 2
  private cursorPhase = 0
  private particles: Particle[] = []
  private redrawn = 0
  private redrawSampleIn = 0
  private redrawSum = 0
  private redrawFrames = 0

  protected layout(): void {
    const { cols, rows } = this.context!.grid()
    this.context!.write(clearScreen + hideCursor)
    this.buffer.forget()
    this.x = Math.min(this.x, Math.max(0, cols - SPRITE_WIDTH))
    this.y = Math.min(this.y, Math.max(0, rows - SPRITE_ROWS - 1))
    if (this.x === 0 && this.y === 0) {
      this.x = -SPRITE_WIDTH
      this.y = Math.max(0, (rows - SPRITE_ROWS) / 2)
    }
  }

  protected frame(delta: number, elapsed: number): void {
    const context = this.context!
    const { cols, rows } = context.grid()
    this.steer(delta)
    this.move(delta, cols, rows - 1)
    this.blink(delta)
    this.spawnParticles(delta)

    const bob = Math.sin(elapsed * 2.6) * 0.9
    const col = Math.round(this.x)
    const row = Math.round(this.y + bob)
    for (const particle of this.particles) {
      const fade = 1 - particle.age / particle.life
      const color = mix(ink, spectre, fade * 0.9)
      this.buffer.set(
        Math.round(particle.y),
        Math.round(particle.x),
        fade > 0.5 ? '∘' : '·',
        fg(color),
      )
    }
    drawGhost(this.buffer, col, row, { cursorVisible: this.cursorPhase < CURSOR_ON_SECONDS })
    this.buffer.text(
      rows - 1,
      1,
      `${numberFormat.format(this.redrawn)} of ${numberFormat.format(cols * rows)} cells redrawn per frame`,
      fg(dusk),
    )
    const written = this.buffer.flush((data) => context.write(data))
    this.redrawSum += written
    this.redrawFrames += 1
    this.redrawSampleIn -= delta
    if (this.redrawSampleIn > 0) return
    this.redrawSampleIn = 0.5
    this.redrawn = Math.round(this.redrawSum / this.redrawFrames)
    this.redrawSum = 0
    this.redrawFrames = 0
  }

  private steer(delta: number): void {
    this.retargetIn -= delta
    if (this.retargetIn <= 0) {
      this.retargetIn = random(1.5, 3.5)
      const angle = random(0, Math.PI * 2)
      this.targetVx = Math.cos(angle) * SPEED_COLS
      this.targetVy = Math.sin(angle) * SPEED_ROWS
      if (Math.abs(this.targetVx) < SPEED_COLS * 0.35) {
        this.targetVx = Math.sign(this.targetVx || 1) * SPEED_COLS * 0.35
      }
    }
    const ease = 1 - Math.exp(-delta * 1.6)
    this.vx += (this.targetVx - this.vx) * ease
    this.vy += (this.targetVy - this.vy) * ease
  }

  private move(delta: number, cols: number, rows: number): void {
    this.x += this.vx * delta
    this.y += this.vy * delta
    const maxX = Math.max(1, cols - SPRITE_WIDTH - 1)
    const maxY = Math.max(1, rows - SPRITE_ROWS - 2)
    if (this.x < 1 && this.vx < 0) {
      this.x = 1
      this.vx = Math.abs(this.vx)
      this.targetVx = Math.abs(this.targetVx)
    }
    if (this.x > maxX && this.vx > 0) {
      this.x = maxX
      this.vx = -Math.abs(this.vx)
      this.targetVx = -Math.abs(this.targetVx)
    }
    if (this.y < 1 && this.vy < 0) {
      this.y = 1
      this.vy = Math.abs(this.vy)
      this.targetVy = Math.abs(this.targetVy)
    }
    if (this.y > maxY && this.vy > 0) {
      this.y = maxY
      this.vy = -Math.abs(this.vy)
      this.targetVy = -Math.abs(this.targetVy)
    }
  }

  private blink(delta: number): void {
    this.cursorPhase = (this.cursorPhase + delta) % (CURSOR_ON_SECONDS + CURSOR_OFF_SECONDS)
  }

  private spawnParticles(delta: number): void {
    for (const particle of this.particles) {
      particle.age += delta
      particle.x += particle.vx * delta
      particle.y += particle.vy * delta
    }
    this.particles = this.particles.filter((particle) => particle.age < particle.life)
    if (Math.random() > delta * 9 || this.particles.length >= 28) return
    const behind = this.vx > 0 ? -1 : SPRITE_WIDTH
    this.particles.push({
      age: 0,
      life: random(0.9, 1.6),
      vx: -this.vx * 0.25 + random(-1.5, 1.5),
      vy: random(-1.2, -0.2),
      x: this.x + behind + random(-1, 1),
      y: this.y + random(SPRITE_ROWS * 0.5, SPRITE_ROWS),
    })
  }
}
