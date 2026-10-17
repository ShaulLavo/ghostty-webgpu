import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import {
  GhosttyRuntime,
  calculateTerminalFittedFont,
  renderFrameToHtml,
  snapshotRenderState,
} from '../../dist/index.js'
import { clearScreen, hideCursor } from './ansi.js'
import { CellBuffer } from './cells.js'
import { drawGhostFrame, GHOST_GRID } from './ghost-drawing.js'
import { parseGhostFrames } from './ghost-frames.js'
import { terminalTheme } from './theme.js'
import { compactGhostHtml } from './first-frame-html.js'

export async function firstGhostFrame(): Promise<string> {
  const frames = parseGhostFrames(
    gunzipSync(await readFile(resolve('public/ghost-frames.txt.gz'))).toString('utf8'),
  )
  const runtime = await GhosttyRuntime.create({
    wasm: await readFile(resolve('../ghostty-vt.wasm')),
    bridge: await readFile(resolve('../bridge.wasm')),
  })
  try {
    const terminal = runtime.createTerminal({ columns: GHOST_GRID.cols, rows: GHOST_GRID.rows })
    const theme = terminalTheme()
    terminal.setDefaultForegroundColor(theme.foreground)
    terminal.setDefaultBackgroundColor(theme.background)
    terminal.setDefaultPalette(theme.palette)
    terminal.write(clearScreen + hideCursor)
    const buffer = new CellBuffer()
    drawGhostFrame(buffer, frames, GHOST_GRID, 0)
    buffer.flush((data) => terminal.write(data))
    const snapshot = snapshotRenderState(runtime.createRenderState(terminal))
    // Chromium's 10px measurements of the checked-in JetBrains Mono Latin subset.
    const font = calculateTerminalFittedFont(
      {
        family: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
        size: 10,
        lineHeight: 1,
        weight: 400,
        boldWeight: 600,
        letterSpacing: 0,
      },
      { advanceWidth: 6, fontAscent: 10, fontDescent: 3 },
      1,
    )
    return compactGhostHtml(
      renderFrameToHtml(snapshot, {
        font,
        columns: GHOST_GRID.cols,
        rows: GHOST_GRID.rows,
        theme,
      }),
    )
  } finally {
    runtime.dispose()
  }
}
