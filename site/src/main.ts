import { GHOSTTY_SOURCE_REVISION, Terminal } from '../../dist/index.js'
import type { TerminalTheme } from '../../dist/index.js'
import { ColorsDemo } from './demos/colors.js'
import { CubeDemo } from './demos/cube.js'
import { DonutDemo } from './demos/donut.js'
import { GhostDemo } from './demos/ghost.js'
import { ShellDemo } from './demos/shell.js'
import type { Demo, DemoContext } from './demos/types.js'
import { ink, pale, palette256, spectre } from './theme.js'

declare const __SITE_VERSION__: string

const FONT_FAMILY = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'
const BASE_FONT_SIZE = 14
const BASE_LINE_HEIGHT = 1.1
// A touch smaller than ghostty.org's 12px, which also opens room for the sideways drift.
const FIT_FONT_SIZE = 10
const FIT_LINE_HEIGHT = 1
const MIN_FONT_SIZE = 5
const MAX_SCREEN_VIEWPORT_SHARE = 0.8
const PADDING = { bottom: 12, left: 16, right: 16, top: 12 }
const demos: readonly Demo[] = [
  new GhostDemo(),
  new DonutDemo(),
  new CubeDemo(),
  new ColorsDemo(),
  new ShellDemo(),
]

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
  marker: required<HTMLElement>('#tab-marker'),
  tabs: required<HTMLElement>('#tabs'),
  window: required<HTMLElement>('#window'),
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let terminal: Terminal | undefined
let active: Demo | undefined
let paused = reducedMotion.matches
const tabButtons = new Map<string, HTMLButtonElement>()

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
    info: () => ({
      backend: instance.diagnostics.rendererBackend ?? 'unknown',
      fontFamily: 'JetBrains Mono',
      revision: GHOSTTY_SOURCE_REVISION,
      version: __SITE_VERSION__,
    }),
    write: (data) => {
      instance.write(data)
    },
    fit: (grid) => fitTo(grid),
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

function applyFit(demo: Demo): void {
  fitTo(demo.fit)
}

function setFont(size: number, lineHeight: number): void {
  const current = terminal!.appearance.font
  if (current.size === size && current.lineHeight === lineHeight) return
  terminal!.setFont({ lineHeight, size })
}

function moveMarker(button: HTMLButtonElement): void {
  ui.marker.style.transform = `translateX(${button.offsetLeft}px)`
  ui.marker.style.width = `${button.offsetWidth}px`
}

function activate(demo: Demo, focusTerminal: boolean): void {
  if (!terminal || demo === active) return
  active?.stop()
  active = undefined
  terminal.reset()
  ui.stat.textContent = ''
  // Animated tabs are decorative; muting a11y keeps the live region from
  // announcing every frame. Shell and Colors keep it, where content matters.
  terminal.setAccessibilityEnabled(!demo.animated)
  applyFit(demo)
  active = demo
  for (const [id, button] of tabButtons) {
    const selected = id === demo.id
    button.setAttribute('aria-selected', String(selected))
    button.tabIndex = selected ? 0 : -1
  }
  const button = tabButtons.get(demo.id)
  if (button) moveMarker(button)
  ui.window.dataset['demo'] = demo.id
  demo.start(createContext(terminal))
  demo.setPaused(paused)
  if (focusTerminal || demo.input) terminal.focus()
  history.replaceState(null, '', `#${demo.id}`)
}

function buildTabs(): void {
  for (const demo of demos) {
    const button = document.createElement('button')
    button.type = 'button'
    button.role = 'tab'
    button.id = `tab-${demo.id}`
    button.textContent = demo.label
    button.setAttribute('aria-controls', 'terminal')
    button.setAttribute('aria-selected', 'false')
    button.tabIndex = -1
    button.addEventListener('click', () => activate(demo, true))
    ui.tabs.append(button)
    tabButtons.set(demo.id, button)
  }
  ui.tabs.addEventListener('keydown', (event) => {
    const order = demos.map((demo) => demo.id)
    const index = order.indexOf(active?.id ?? '')
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % order.length
    if (event.key === 'ArrowLeft') next = (index - 1 + order.length) % order.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = order.length - 1
    if (next < 0) return
    event.preventDefault()
    const demo = demos[next]!
    activate(demo, false)
    tabButtons.get(demo.id)?.focus()
  })
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
    const button = active ? tabButtons.get(active.id) : undefined
    if (button) moveMarker(button)
    if (active) applyFit(active)
  })
  document.addEventListener('visibilitychange', () => {
    if (!active?.animated || paused) return
    active.setPaused(document.hidden)
  })
}

function showFatal(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause)
  ui.fatalMessage.textContent = message
  ui.fatal.hidden = false
}

async function boot(): Promise<void> {
  buildTabs()
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

  instance.onResize(() => active?.resize())
  instance.onData((bytes) => active?.input?.(bytes))

  const requested = demos.find((demo) => demo.id === location.hash.slice(1))
  activate(requested ?? demos[0]!, false)
}

boot().catch(showFatal)
