import { load, type Piece, type PieceName } from 'ascii.rest'
import { fitTerminalFont, Terminal } from '../../../dist/index.js'
import { coverScene, sceneGrid, SCROLLBAR } from './grid.js'
import type { SceneTheme } from './theme'

export const SCENE_FONT = '"Paper Mono", ui-monospace, monospace'

const font = (size: number, lineHeight: number, letterSpacing = 0) =>
  fitTerminalFont(
    document,
    { boldWeight: 600, family: SCENE_FONT, letterSpacing, lineHeight, size, weight: 400 },
    devicePixelRatio,
  )

// ascii.rest's scene dots, smallest to largest, after the blank.
const DOTS = ' ·•●'

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
  readonly cover: ReturnType<typeof coverScene>
  readonly sceneDots: Uint8Array
  readonly sentCh: Int32Array
  readonly sentFg: Int32Array
}

function coverGrid(columns: number, rows: number, cols: number, sceneRows: number): Grid {
  return {
    cover: coverScene(columns, rows, cols, sceneRows),
    sceneDots: new Uint8Array(cols * sceneRows),
    sentCh: new Int32Array(columns * rows).fill(-1),
    sentFg: new Int32Array(columns * rows).fill(-1),
  }
}

/** One frame's changed cells as terminal output. */
function frameOutput(
  frame: string,
  color: Uint8Array,
  cols: number,
  inks: readonly number[],
  grid: Grid,
) {
  const { cover, sceneDots } = grid
  frame.split('\n').forEach((line, y) => {
    for (let x = 0; x < cols; x++)
      sceneDots[y * cols + x] = Math.max(0, DOTS.indexOf(line[x] ?? ' '))
  })
  cover.sample(sceneDots, color)
  let out = ''
  let pen = -1
  for (let y = 0; y < cover.rows; y++) {
    let at = -1
    for (let x = 0; x < cover.columns; x++) {
      const k = y * cover.columns + x
      const ch = DOTS.charCodeAt(cover.dots[k]!)
      const fg = ch === 32 ? -1 : (inks[cover.inks[k]!] ?? inks[0]!)
      if (grid.sentCh[k] === ch && grid.sentFg[k] === fg) continue
      grid.sentCh[k] = ch
      grid.sentFg[k] = fg
      if (at !== x) out += `\x1b[${y + 1};${x + 1}H`
      // Runs of one colour share one pen change; a blank leaves the pen as it was.
      if (fg >= 0 && fg !== pen) {
        out += sgr(38, fg)
        pen = fg
      }
      out += String.fromCharCode(ch)
      at = x + 1
    }
  }
  return out
}

let lastPointer = ''

function mouseOnly(event: Event) {
  if (event instanceof PointerEvent && event.type !== 'click') lastPointer = event.pointerType
  if (lastPointer !== 'mouse') event.stopPropagation()
}

/** Ctrl or Cmd+C copies the scene's selected cells, unless the page has its own text selected. */
function copySelection(event: KeyboardEvent, terminal: Terminal) {
  if (event.key.toLowerCase() !== 'c' || !(event.ctrlKey || event.metaKey) || event.altKey) return
  if (!document.getSelection()?.isCollapsed) return
  const text = terminal.getSelection()
  if (!text) return
  event.preventDefault()
  void navigator.clipboard.writeText(text)
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
        selectionBackground: rgb(theme.accent),
        selectionForeground: ground,
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
  // Only a mouse reaches the terminal, to select cells; touch passes through to the page on any device. Nothing in
  // the scene takes focus, so the keyboard stays with the page, and Ctrl or Cmd+C copies the selected cells.
  host.inert = false
  host.addEventListener('wheel', (event) => event.stopPropagation(), { capture: true })
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click'] as const) {
    host.addEventListener(type, (event) => mouseOnly(event), { capture: true })
  }
  host.addEventListener('focusin', (event) => (event.target as HTMLElement).blur())
  for (const stop of host.querySelectorAll('textarea, [tabindex]'))
    stop.setAttribute('tabindex', '-1')
  document.addEventListener('keydown', (event) => copySelection(event, terminal))
  terminal.write('\x1b[?25l\x1b[?7l\x1b[2J')

  const inks = palette.map(int)
  const frame = piece.default(piece.meta.options)
  const color = new Uint8Array(cols * rows)
  let grid: Grid | undefined
  const draw = (t: number) => {
    const { columns, rows: height } = terminal.appearance.grid
    if (grid?.cover.columns !== columns || grid.cover.rows !== height) {
      grid = coverGrid(columns, height, cols, rows)
      // Beside the first frame's data-grid: the two must agree for the hand-over to keep its picture.
      host.dataset.terminalGrid = `${columns}x${height}`
      terminal.write('\x1b[2J')
    }
    const out = frameOutput(frame(t, { paper: false, color }), color, cols, inks, grid)
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
