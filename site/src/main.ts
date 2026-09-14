import { Terminal } from '../../dist/index.js'
import type { TerminalTheme } from '../../dist/index.js'
import { GhostDemo } from './demos/ghost.js'
import type { DemoContext } from './demos/types.js'
import { ink, pale, palette256, spectre } from './theme.js'

const FONT_FAMILY = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'
const BASE_FONT_SIZE = 14
const BASE_LINE_HEIGHT = 1.1
// A touch smaller than ghostty.org's 12px, which also opens room for the sideways drift.
const FIT_FONT_SIZE = 10
const FIT_LINE_HEIGHT = 1
const MIN_FONT_SIZE = 5
const MAX_SCREEN_VIEWPORT_SHARE = 0.8
const PADDING = { bottom: 12, left: 16, right: 16, top: 12 }
const ghost = new GhostDemo()

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new TypeError(`Missing element: ${selector}`)
  return element
}

const ui = {
  backend: required<HTMLElement>('#backend'),
  backendFact: required<HTMLElement>('#backend-fact'),
  copy: required<HTMLButtonElement>('#copy-install'),
  fatal: required<HTMLElement>('#fatal'),
  fatalMessage: required<HTMLElement>('#fatal-message'),
  host: required<HTMLElement>('#terminal'),
  screen: required<HTMLElement>('.screen'),
  stat: required<HTMLElement>('#stat'),
  window: required<HTMLElement>('#window'),
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let terminal: Terminal | undefined
const paused = reducedMotion.matches

function buildTheme(): TerminalTheme {
  return {
    background: ink,
    cursor: spectre,
    cursorText: ink,
    foreground: pale,
    minimumContrast: 1,
    palette: palette256(),
    selectionBackground: { r: 62, g: 58, b: 92 },
    selectionForeground: pale,
  }
}

async function loadFonts(): Promise<void> {
  if (!('fonts' in document)) return
  await Promise.all([
    document.fonts.load(`400 14px ${FONT_FAMILY}`),
    document.fonts.load(`600 14px ${FONT_FAMILY}`),
    document.fonts.load(`italic 400 14px ${FONT_FAMILY}`),
  ]).catch(() => undefined)
}

function createContext(instance: Terminal): DemoContext {
  return {
    grid: () => ({
      cols: instance.appearance.grid.columns,
      rows: instance.appearance.grid.rows,
    }),
    stat: (text) => {
      ui.stat.textContent = text
    },
    write: (data) => {
      instance.write(data)
    },
  }
}

/** CSS cell size per font pixel, measured from the rendered canvas. */
function cellPerPixel(): { readonly height: number; readonly width: number } {
  const canvas = ui.host.querySelector('canvas')
  const { font, grid } = terminal!.appearance
  if (canvas && grid.columns > 0 && grid.rows > 0) {
    const rect = canvas.getBoundingClientRect()
    return {
      height: rect.height / grid.rows / font.size,
      width: rect.width / grid.columns / font.size,
    }
  }
  // JetBrains Mono advances about 0.6em per cell; its line box is about 1.4em.
  return { height: 1.4, width: 0.6 }
}

/** Sizes the window and font so a grid shows whole; undefined restores base. */
function fitTo(grid: { readonly cols: number; readonly rows: number } | undefined): void {
  if (!terminal) return
  if (!grid) {
    ui.screen.style.height = ''
    setFont(BASE_FONT_SIZE, BASE_LINE_HEIGHT)
    return
  }
  const cell = cellPerPixel()
  const width = ui.host.clientWidth - PADDING.left - PADDING.right
  const maxHeight = window.innerHeight * MAX_SCREEN_VIEWPORT_SHARE - PADDING.top - PADDING.bottom
  const byWidth = width / (grid.cols * cell.width)
  const byHeight = maxHeight / (grid.rows * cell.height)
  const size = Math.max(
    MIN_FONT_SIZE,
    Math.min(FIT_FONT_SIZE, Math.floor(Math.min(byWidth, byHeight))),
  )
  const rowsHeight = Math.ceil(grid.rows * cell.height * size)
  ui.screen.style.height = `${rowsHeight + PADDING.top + PADDING.bottom + 2}px`
  setFont(size, FIT_LINE_HEIGHT)
}

function setFont(size: number, lineHeight: number): void {
  const current = terminal!.appearance.font
  if (current.size === size && current.lineHeight === lineHeight) return
  terminal!.setFont({ lineHeight, size })
}

function wireControls(): void {
  // The terminal's own wheel handler scrolls its scrollback and blocks the
  // page. Stop the event in the capture phase so the page scrolls instead.
  ui.host.addEventListener('wheel', (event) => event.stopPropagation(), { capture: true })
  ui.copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('npm install ghostty-webgpu')
      ui.copy.textContent = 'Copied'
    } catch {
      ui.copy.textContent = 'Select and copy'
    }
    window.setTimeout(() => {
      ui.copy.textContent = 'Copy'
    }, 1600)
  })
  window.addEventListener('resize', () => {
    fitTo(ghost.fit)
  })
  document.addEventListener('visibilitychange', () => {
    if (paused) return
    ghost.setPaused(document.hidden)
  })
}

function showFatal(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause)
  ui.fatalMessage.textContent = message
  ui.fatal.hidden = false
}

async function boot(): Promise<void> {
  wireControls()
  await loadFonts()
  const base = document.baseURI
  const instance = await Terminal.create({
    appearance: {
      cursor: { blink: true, style: 'block' },
      font: { family: FONT_FAMILY, lineHeight: BASE_LINE_HEIGHT, size: BASE_FONT_SIZE },
      scrollbackLimit: 2000,
      theme: buildTheme(),
    },
    padding: PADDING,
    runtime: {
      kind: 'owned',
      options: {
        bridge: new URL('bridge.wasm', base),
        wasm: new URL('ghostty-vt.wasm', base),
      },
    },
  })
  await instance.open(ui.host)
  terminal = instance

  const backend = instance.diagnostics.rendererBackend ?? 'unknown'
  ui.backend.textContent = backend
  ui.backendFact.textContent = backend
  ui.window.dataset['ready'] = 'true'

  instance.onResize(() => ghost.resize())
  // Avoid announcing every frame of the decorative animation.
  instance.setAccessibilityEnabled(false)
  fitTo(ghost.fit)
  ghost.start(createContext(instance))
  ghost.setPaused(paused || document.hidden)
}

boot().catch(showFatal)
