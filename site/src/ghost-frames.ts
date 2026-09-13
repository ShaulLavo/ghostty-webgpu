import { fg, rgb } from './ansi.js'

// The ghostty.org home animation, packed by site/scripts/pack-ghost-frames.ts
// from ghostty-org/website (MIT).
const FRAMES_URL = 'ghost-frames.txt.gz'
const GLOW_START = String.fromCharCode(1)
const GLOW_END = String.fromCharCode(2)
const FRAME_SEPARATOR = String.fromCharCode(12)

export const GHOST_BODY_STYLE = fg(rgb('#FFFFFF'))
export const GHOST_GLOW_STYLE = fg(rgb('#3551F3'))

export interface Run {
  readonly col: number
  readonly glow: boolean
  readonly text: string
}

export interface GhostFrames {
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

export function loadGhostFrames(): Promise<GhostFrames> {
  framesPromise ??= fetch(new URL(FRAMES_URL, document.baseURI))
    .then(async (response) => {
      if (!response.ok) throw new Error(`Frames request failed: ${response.status}`)
      return inflate(await response.arrayBuffer())
    })
    .then(parseFrames)
  return framesPromise
}

/** One frame as colored text lines: white body, blue glow, one string per row. */
export function frameToLines(frames: GhostFrames, index: number): string[] {
  const frame =
    frames.frames[((index % frames.frames.length) + frames.frames.length) % frames.frames.length]!
  const lines: string[] = []
  for (let row = 0; row < frames.rows; row += 1) {
    const runs = frame[row] ?? []
    let line = ''
    let col = 0
    for (const run of runs) {
      if (run.col > col) line += ' '.repeat(run.col - col)
      line += `${run.glow ? GHOST_GLOW_STYLE : GHOST_BODY_STYLE}${run.text}\x1b[0m`
      col = run.col + run.text.length
    }
    if (col < frames.width) line += ' '.repeat(frames.width - col)
    lines.push(line)
  }
  return lines
}
