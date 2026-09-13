import { clearScreen, fg, hideCursor } from '../ansi.js'
import { CellBuffer } from '../cells.js'
import {
  GHOST_BODY_STYLE as BODY_STYLE,
  GHOST_GLOW_STYLE as GLOW_STYLE,
  loadGhostFrames,
  type GhostFrames,
  type Run,
} from '../ghost-frames.js'
import { dusk } from '../theme.js'
import { AnimatedDemo } from './types.js'

const FRAME_SECONDS = 0.031
const DRIFT_PERIOD_SECONDS = 22
const numberFormat = new Intl.NumberFormat('en-US')

export class GhostDemo extends AnimatedDemo {
  readonly id = 'ghost'
  readonly label = 'Ghost'
  readonly caption =
    'The ghost from ghostty.org, all 235 frames of it, played at their frame rate. The figure on the right is how many cells actually changed per frame.'
  readonly fit = { cols: 78, rows: 40 }

  private readonly buffer = new CellBuffer()
  private frames: GhostFrames | undefined
  private failure: string | undefined
  private redrawn = 0
  private redrawSampleIn = 0
  private redrawSum = 0
  private redrawFrames = 0

  protected layout(): void {
    this.context!.write(clearScreen + hideCursor)
    this.buffer.forget()
    if (this.frames || this.failure) return
    loadGhostFrames()
      .then((frames) => {
        this.frames = frames
      })
      .catch((cause: unknown) => {
        this.failure = cause instanceof Error ? cause.message : String(cause)
      })
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

    const index = Math.floor(elapsed / FRAME_SECONDS) % frames.frames.length
    const frame = frames.frames[index]!
    // Drift left and right through whatever room the grid has beyond the frame.
    const amplitude = Math.max(0, (cols - frames.width) / 2 - 1)
    const drift = Math.sin((elapsed / DRIFT_PERIOD_SECONDS) * Math.PI * 2) * amplitude
    const originCol = Math.round((cols - frames.width) / 2 + drift)
    const originRow = Math.floor((rows - frames.rows) / 2)

    for (let r = 0; r < frame.length; r += 1) {
      const row = originRow + r
      if (row < 0 || row >= rows) continue
      for (const run of frame[r]!) this.drawRun(row, originCol + run.col, run, cols)
    }
    const written = this.buffer.flush((data) => context.write(data))
    this.sampleRedraw(written, delta)
    if (this.redrawSampleIn > 0) return
    context.stat(
      `${numberFormat.format(this.redrawn)} of ${numberFormat.format(cols * rows)} cells redrawn per frame`,
    )
    this.resetSample()
  }

  private drawRun(row: number, col: number, run: Run, cols: number): void {
    const start = Math.max(0, -col)
    const end = Math.min(run.text.length, cols - col)
    if (end <= start) return
    const text = start === 0 && end === run.text.length ? run.text : run.text.slice(start, end)
    this.buffer.text(row, col + start, text, run.glow ? GLOW_STYLE : BODY_STYLE)
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
