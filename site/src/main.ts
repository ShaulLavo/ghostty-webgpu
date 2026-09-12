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

const FONT_FAMILY = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace'
const BASE_FONT_SIZE = 14
const MIN_FONT_SIZE = 5
// IBM Plex Mono advances 0.6em per cell; its line box is about 1.3em, times the 1.1 line height.
const CELL_WIDTH_EM = 0.6
const CELL_HEIGHT_EM = 1.45
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
  caption: required<HTMLElement>('#caption'),
  copy: required<HTMLButtonElement>('#copy-install'),
  fatal: required<HTMLElement>('#fatal'),
  fatalMessage: required<HTMLElement>('#fatal-message'),
  host: required<HTMLElement>('#terminal'),
  marker: required<HTMLElement>('#tab-marker'),
  pause: required<HTMLButtonElement>('#pause'),
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
    info: () => ({
      backend: instance.diagnostics.rendererBackend ?? 'unknown',
      fontFamily: 'IBM Plex Mono',
      revision: GHOSTTY_SOURCE_REVISION,
      version: __SITE_VERSION__,
    }),
    write: (data) => {
      instance.write(data)
    },
  }
}

function fontSizeFor(demo: Demo): number {
  if (!demo.fit) return BASE_FONT_SIZE
  const width = ui.host.clientWidth - PADDING.left - PADDING.right
  const height = ui.host.clientHeight - PADDING.top - PADDING.bottom
  const byWidth = width / (demo.fit.cols * CELL_WIDTH_EM)
  const byHeight = height / (demo.fit.rows * CELL_HEIGHT_EM)
  return Math.max(MIN_FONT_SIZE, Math.min(BASE_FONT_SIZE, Math.floor(Math.min(byWidth, byHeight))))
}

function applyFont(demo: Demo): void {
  if (!terminal) return
  const size = fontSizeFor(demo)
  if (terminal.appearance.font.size === size) return
  terminal.setFont({ size })
}

function moveMarker(button: HTMLButtonElement): void {
  ui.marker.style.transform = `translateX(${button.offsetLeft}px)`
  ui.marker.style.width = `${button.offsetWidth}px`
}

function updatePauseButton(): void {
  const animated = active?.animated ?? false
  ui.pause.hidden = !animated
  ui.pause.textContent = paused ? 'Play' : 'Pause'
  ui.pause.setAttribute('aria-pressed', String(paused))
}

function activate(demo: Demo, focusTerminal: boolean): void {
  if (!terminal || demo === active) return
  active?.stop()
  active = undefined
  terminal.reset()
  applyFont(demo)
  active = demo
  for (const [id, button] of tabButtons) {
    const selected = id === demo.id
    button.setAttribute('aria-selected', String(selected))
    button.tabIndex = selected ? 0 : -1
  }
  const button = tabButtons.get(demo.id)
  if (button) moveMarker(button)
  ui.caption.textContent = demo.caption
  ui.window.dataset['demo'] = demo.id
  demo.start(createContext(terminal))
  demo.setPaused(paused)
  updatePauseButton()
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
  ui.pause.addEventListener('click', () => {
    paused = !paused
    active?.setPaused(paused)
    updatePauseButton()
  })
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
    if (active) applyFont(active)
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
      font: { family: FONT_FAMILY, lineHeight: 1.1, size: BASE_FONT_SIZE },
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
