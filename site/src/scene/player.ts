import { load, type Piece, type PieceName } from 'ascii.rest'
import { fitTerminalFont, Terminal } from '../../../dist/index.js'
import { coverMap, sceneGrid, SCROLLBAR } from './grid.js'
import type { SceneTheme } from './theme'

export const SCENE_FONT = '"Paper Mono", ui-monospace, monospace'

const font = (size: number, lineHeight: number, letterSpacing = 0) =>
  fitTerminalFont(
    document,
    { boldWeight: 600, family: SCENE_FONT, letterSpacing, lineHeight, size, weight: 400 },
    devicePixelRatio,
  )

const int = (hex: string) => Number.parseInt(hex.slice(1, 7), 16)
const rgb = (hex: string) => {
  const value = int(hex)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}
const sgr = (layer: number, color: number) =>
  `\x1b[${layer};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}m`

/**
 * Font settings whose cell is exactly `cell` CSS pixels square: the largest face whose half-height line fits, its
 * line raised to the cell's height and its advance widened to the cell's width.
 */
function exactCell(cell: number) {
  let size = cell * 2
  while (size > 1 && (font(size, 0.5).cssCellHeight > cell || font(size, 0.5).cssCellWidth > cell))
    size -= 1 / 16
  let lineHeight = 0.5
  while (lineHeight < 2 && font(size, lineHeight + 0.005).cssCellHeight <= cell) lineHeight += 0.005
  const letterSpacing = cell - font(size, lineHeight).cssCellWidth
  return { letterSpacing, lineHeight, size }
}

/** The grid for the host's width; sets the host's height to its whole rows. */
function fitHost(host: HTMLElement, cols: number, rows: number) {
  const grid = sceneGrid(host.clientWidth, devicePixelRatio, cols, rows)
  host.style.height = `${grid.height}px`
  return exactCell(grid.cell)
}

interface Grid {
  readonly mapX: Int32Array
  readonly mapY: Int32Array
  readonly sentCh: Int32Array
  readonly sentFg: Int32Array
}

function coverGrid(columns: number, rows: number, cols: number, sceneRows: number): Grid {
  return {
    ...coverMap(columns, rows, cols, sceneRows),
    sentCh: new Int32Array(columns * rows).fill(-1),
    sentFg: new Int32Array(columns * rows).fill(-1),
  }
}

/** One frame's changed cells as terminal output. */
function frameOutput(
  lines: readonly string[],
  color: Uint8Array,
  cols: number,
  inks: readonly number[],
  grid: Grid,
) {
  const columns = grid.mapX.length
  let out = ''
  for (let y = 0; y < grid.mapY.length; y++) {
    const sy = grid.mapY[y]!
    const line = lines[sy] ?? ''
    let at = -1
    for (let x = 0; x < columns; x++) {
      const sx = grid.mapX[x]!
      const ch = line.charCodeAt(sx) || 32
      const fg = ch === 32 ? -1 : (inks[color[sy * cols + sx]!] ?? inks[0]!)
      const k = y * columns + x
      if (grid.sentCh[k] === ch && grid.sentFg[k] === fg) continue
      grid.sentCh[k] = ch
      grid.sentFg[k] = fg
      if (at !== x) out += `\x1b[${y + 1};${x + 1}H`
      if (fg >= 0) out += sgr(38, fg)
      out += String.fromCharCode(ch)
      at = x + 1
    }
  }
  return out
}

/** Plays an ascii.rest scene in a ghostty-webgpu terminal, cell for cell, while it is on screen. */
export async function mountScene(
  host: HTMLElement,
  name: PieceName,
  theme: SceneTheme,
  reducedMotion: boolean,
) {
  const piece = (await load[name]()) as Piece
  const { cols, rows, palette = [], fps } = piece.meta
  await document.fonts.load(`400 14px ${SCENE_FONT}`).catch(() => undefined)
  const cellFont = fitHost(host, cols, rows)
  const ground = rgb(theme.ground)
  const terminal = await Terminal.create({
    appearance: {
      cursor: { blink: false, style: 'block' },
      font: { family: SCENE_FONT, ...cellFont },
      scrollbackLimit: 0,
      theme: {
        background: ground,
        cursor: ground,
        cursorText: ground,
        foreground: rgb(theme.text),
        minimumContrast: 1,
        // The scene writes exact colours, so the indexed palette is never read.
        palette: new Array(256).fill(ground),
        selectionBackground: rgb(theme.line),
        selectionForeground: rgb(theme.text),
      },
    },
    padding: { top: 0, bottom: 0, left: 0, right: 0 },
    scrollbar: { width: SCROLLBAR },
    // The same URLs the page preloads, so the browser fetches each file once.
    runtime: {
      kind: 'owned',
      options: {
        bridge: new URL('bridge.wasm', document.baseURI),
        wasm: new URL('ghostty-vt.wasm', document.baseURI),
      },
    },
  })
  await terminal.open(host)
  for (const type of ['wheel', 'pointerdown', 'pointermove', 'pointerup', 'click'] as const) {
    host.addEventListener(type, (event) => event.stopPropagation(), { capture: true })
  }
  terminal.write('\x1b[?25l\x1b[?7l\x1b[2J')

  const inks = palette.map(int)
  const frame = piece.default(piece.meta.options)
  const color = new Uint8Array(cols * rows)
  let grid: Grid | undefined
  const draw = (t: number) => {
    const { columns, rows: height } = terminal.appearance.grid
    if (grid?.mapX.length !== columns || grid.mapY.length !== height) {
      grid = coverGrid(columns, height, cols, rows)
      // Beside the first frame's data-grid: the two must agree for the hand-over to keep its picture.
      host.dataset.terminalGrid = `${columns}x${height}`
      terminal.write('\x1b[2J')
    }
    const out = frameOutput(frame(t, { paper: false, color }).split('\n'), color, cols, inks, grid)
    if (out) terminal.write(out)
  }

  // The baked first frame stays until the terminal has painted its own.
  const baked = host.querySelector('.scene-first')
  const painted = terminal.onFrame(() => {
    painted.dispose()
    requestAnimationFrame(() => baked?.remove())
  })
  let t = piece.meta.still ?? 0
  draw(t)
  // A new width (a resized window, a turned phone) needs a new grid; the terminal's resize redraws the scene.
  terminal.onResize(() => draw(t))
  let width = host.clientWidth
  new ResizeObserver(() => {
    if (host.clientWidth === width) return
    width = host.clientWidth
    terminal.setFont(fitHost(host, cols, rows))
  }).observe(host)
  if (reducedMotion || !fps) return terminal

  const interval = 1000 / fps
  let visible = true
  let handle = 0
  let last = 0
  const tick = (now: number) => {
    handle = 0
    if (!visible) return
    if (now - last >= interval - 1) {
      t += last ? Math.min(now - last, 100) / 1000 : 0
      last = now
      draw(t)
    }
    handle = requestAnimationFrame(tick)
  }
  new IntersectionObserver(([entry]) => {
    visible = entry!.isIntersecting && !document.hidden
    last = 0
    if (visible && !handle) handle = requestAnimationFrame(tick)
  }).observe(host)
  handle = requestAnimationFrame(tick)
  return terminal
}
