import { CellBuffer } from './cells.js'
import { GHOST_BODY_STYLE, GHOST_GLOW_STYLE, type GhostFrames, type Run } from './ghost-frames.js'

export const GHOST_GRID = { cols: 78, rows: 40 } as const
const GHOST_FRAME_SECONDS = 0.031
const DRIFT_PERIOD_SECONDS = 22

function drawRun(buffer: CellBuffer, row: number, col: number, run: Run, cols: number): void {
  const start = Math.max(0, -col)
  const end = Math.min(run.text.length, cols - col)
  if (end <= start) return
  const text = start === 0 && end === run.text.length ? run.text : run.text.slice(start, end)
  buffer.text(row, col + start, text, run.glow ? GHOST_GLOW_STYLE : GHOST_BODY_STYLE)
}

export function drawGhostFrame(
  buffer: CellBuffer,
  frames: GhostFrames,
  grid: { readonly cols: number; readonly rows: number },
  elapsed: number,
): void {
  const index = Math.floor(elapsed / GHOST_FRAME_SECONDS) % frames.frames.length
  const frame = frames.frames[index]!
  const amplitude = Math.max(0, (grid.cols - frames.width) / 2 - 1)
  const drift = Math.sin((elapsed / DRIFT_PERIOD_SECONDS) * Math.PI * 2) * amplitude
  const originCol = Math.round((grid.cols - frames.width) / 2 + drift)
  const originRow = Math.floor((grid.rows - frames.rows) / 2)
  for (let r = 0; r < frame.length; r += 1) {
    const row = originRow + r
    if (row < 0 || row >= grid.rows) continue
    for (const run of frame[r]!) drawRun(buffer, row, originCol + run.col, run, grid.cols)
  }
}
