import { clearScreen, fg, hideCursor } from '../ansi.js'
import { CellBuffer } from '../cells.js'
import type { GhostFrames } from '../ghost-frames.js'
import { drawGhostFrame, GHOST_GRID } from '../ghost-drawing.js'
import { dusk } from '../theme.js'
import { AnimatedDemo } from './types.js'

const numberFormat = new Intl.NumberFormat('en-US')

export class GhostDemo extends AnimatedDemo {
  readonly id = 'ghost'
  readonly label = 'Ghost'
  readonly caption = ''
  readonly fit = GHOST_GRID

  private readonly buffer = new CellBuffer()
  private frames: GhostFrames | undefined
  private failure: string | undefined
  private redrawn = 0
  private redrawSampleIn = 0
  private redrawSum = 0
  private redrawFrames = 0

  prepare(frames: Promise<GhostFrames>): void {
    frames
      .then((loaded) => {
        this.frames = loaded
        this.paintStill()
      })
      .catch((cause: unknown) => {
        this.failure = cause instanceof Error ? cause.message : String(cause)
        this.paintStill()
      })
  }

  protected layout(): void {
    this.context!.write(clearScreen + hideCursor)
    this.buffer.forget()
    this.redrawSampleIn = 0
    this.redrawSum = 0
    this.redrawFrames = 0
    this.frame(0, 0)
  }

  protected frame(delta: number, elapsed: number): void {
    const context = this.context!
    const { cols, rows } = context.grid()
    if (this.failure) {
      this.buffer.text(1, 1, `The ghost did not load. ${this.failure}`, fg(dusk))
      this.buffer.flush((data) => context.write(data))
      return
    }
    const frames = this.frames
    if (!frames) {
      this.buffer.text(1, 1, 'Summoning the ghost.', fg(dusk))
      this.buffer.flush((data) => context.write(data))
      return
    }

    drawGhostFrame(this.buffer, frames, { cols, rows }, elapsed)
    if (performance.getEntriesByName('ghost:first-write').length === 0) {
      performance.mark('ghost:first-write')
    }
    const written = this.buffer.flush((data) => context.write(data))
    this.sampleRedraw(written, delta)
    if (this.redrawSampleIn > 0) return
    context.stat(
      `${numberFormat.format(this.redrawn)} of ${numberFormat.format(cols * rows)} cells redrawn per frame`,
    )
    this.resetSample()
  }

  private sampleRedraw(written: number, delta: number): void {
    this.redrawSum += written
    this.redrawFrames += 1
    this.redrawSampleIn -= delta
    if (this.redrawSampleIn > 0) return
    this.redrawn = Math.round(this.redrawSum / this.redrawFrames)
    this.redrawSum = 0
    this.redrawFrames = 0
  }

  private resetSample(): void {
    this.redrawSampleIn = 0.5
  }
}
