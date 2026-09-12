import { clearScreen, fg, hideCursor, rgb } from '../ansi.js'
import { CellBuffer } from '../cells.js'
import { dusk } from '../theme.js'
import { AnimatedDemo } from './types.js'

// The frames are the ghostty.org home animation, packed by
// site/scripts/pack-ghost-frames.ts from ghostty-org/website (MIT).
const FRAMES_URL = 'ghost-frames.txt.gz'
const FRAME_SECONDS = 0.031
const DRIFT_PERIOD_SECONDS = 16
const GLOW_START = String.fromCharCode(1)
const GLOW_END = String.fromCharCode(2)
const FRAME_SEPARATOR = String.fromCharCode(12)
const BODY_STYLE = fg(rgb('#FFFFFF'))
const GLOW_STYLE = fg(rgb('#3551F3'))
const numberFormat = new Intl.NumberFormat('en-US')

interface Run {
  readonly col: number
  readonly glow: boolean
  readonly text: string
}

interface GhostFrames {
  readonly frames: readonly (readonly (readonly Run[])[])[]
  readonly rows: number
  readonly width: number
}

let framesPromise: Promise<GhostFrames> | undefined

function parseLine(line: string): Run[] {
  const runs: Run[] = []
  let glow = false
  let col = 0
  let start = 0
  let text = ''
  const flush = () => {
    if (text !== '') runs.push({ col: start, glow, text })
    text = ''
  }
  for (const char of line) {
    if (char === GLOW_START || char === GLOW_END) {
      flush()
      glow = char === GLOW_START
      continue
    }
    if (char === ' ') {
      flush()
      col += 1
      continue
    }
    if (text === '') start = col
    text += char
    col += 1
  }
  flush()
  return runs
}

function parseFrames(packed: string): GhostFrames {
  const newline = packed.indexOf('\n')
  const [width = 0, rows = 0] = packed.slice(0, newline).split(' ').map(Number)
  const frames = packed
    .slice(newline + 1)
    .split(FRAME_SEPARATOR)
    .map((frame) => frame.split('\n').map(parseLine))
  return { frames, rows, width }
}

async function inflate(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer)
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b
  if (!isGzip) return new TextDecoder().decode(buffer)
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

function loadFrames(): Promise<GhostFrames> {
  framesPromise ??= fetch(new URL(FRAMES_URL, document.baseURI))
    .then(async (response) => {
      if (!response.ok) throw new Error(`Frames request failed: ${response.status}`)
      return inflate(await response.arrayBuffer())
    })
    .then(parseFrames)
  return framesPromise
}

export class GhostDemo extends AnimatedDemo {
  readonly id = 'ghost'
  readonly label = 'Ghost'
  readonly caption =
    'The ghost from ghostty.org, all 235 frames of it, drifting across the grid. The count at the bottom is how many cells actually changed each frame.'
  readonly fit = { cols: 80, rows: 42 }

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
    loadFrames()
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
    const spare = Math.max(0, (cols - frames.width) / 2 - 1)
    const drift = Math.sin((elapsed / DRIFT_PERIOD_SECONDS) * Math.PI * 2) * spare
    const originCol = Math.round((cols - frames.width) / 2 + drift)
    const originRow = Math.max(0, Math.floor((rows - 1 - frames.rows) / 2))
    const lastRow = rows - 2

    for (let r = 0; r < frame.length; r += 1) {
      const row = originRow + r
      if (row < 0 || row > lastRow) continue
      for (const run of frame[r]!) this.drawRun(row, originCol + run.col, run, cols)
    }
    this.buffer.text(
      rows - 1,
      1,
      `${numberFormat.format(this.redrawn)} of ${numberFormat.format(cols * rows)} cells redrawn per frame`,
      fg(dusk),
    )
    const written = this.buffer.flush((data) => context.write(data))
    this.sampleRedraw(written, delta)
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
    this.redrawSampleIn = 0.5
    this.redrawn = Math.round(this.redrawSum / this.redrawFrames)
    this.redrawSum = 0
    this.redrawFrames = 0
  }
}
