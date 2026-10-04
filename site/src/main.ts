import { fitTerminalFont, Terminal, attachTerminalHotkeys } from '../../dist/index.js'
import { GhostDemo } from './demos/ghost.js'
import { MatrixDemo } from './demos/matrix.js'
import { ShellDemo } from './demos/shell.js'
import type { Demo, DemoContext } from './demos/types.js'
import { terminalTheme } from './theme.js'
import { loadGhostFrames } from './ghost-frames.js'
import { fittedScreenHeight, roundedFitPadding } from './fit.js'

const FONT_FAMILY = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'
const BASE_FONT_SIZE = 14
const BASE_LINE_HEIGHT = 1.1
// A touch smaller than ghostty.org's 12px, which also opens room for the sideways drift.
const FIT_FONT_SIZE = 10
const FIT_LINE_HEIGHT = 1
const MIN_FONT_SIZE = 5
const MAX_SCREEN_VIEWPORT_SHARE = 0.8
const PHONE_SCREEN_VIEWPORT_SHARE = 0.45
const PADDING = { bottom: 12, left: 16, right: 16, top: 12 }
const TAB_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 }
const ghost = new GhostDemo()
const demos: readonly Demo[] = [ghost, new MatrixDemo(), new ShellDemo()]
let active: Demo = demos[0]!

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
  firstFrame: required<HTMLElement>('#ghost-first-frame'),
  host: required<HTMLElement>('#terminal'),
  screen: required<HTMLElement>('.screen'),
  stat: required<HTMLElement>('#stat'),
  tabs: required<HTMLElement>('#tabs'),
  window: required<HTMLElement>('#window'),
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let terminal: Terminal | undefined
const paused = reducedMotion.matches

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
    writeBytes: (data) => {
      instance.write(data)
    },
  }
}

/** Measure the candidate font with the same pixel rounding as the renderer. */
function cellSize(size: number): { readonly height: number; readonly width: number } {
  const font = fitTerminalFont(
    document,
    { ...terminal!.appearance.font, lineHeight: FIT_LINE_HEIGHT, size },
    window.devicePixelRatio,
  )
  return { height: font.cssCellHeight, width: font.cssCellWidth }
}

/** Sizes the window and font so a grid shows whole; undefined restores base. */
function fitTo(grid: { readonly cols: number; readonly rows: number } | undefined): void {
  if (!terminal) return
  if (!grid) {
    ui.screen.style.height = ''
    setFont(BASE_FONT_SIZE, BASE_LINE_HEIGHT)
    return
  }
  const scrollbarWidth = ui.host.querySelector<HTMLElement>('[role="scrollbar"]')?.offsetWidth ?? 0
  const ratio = window.devicePixelRatio
  const padding = roundedFitPadding(PADDING, ratio)
  const scrollbar = Math.round(scrollbarWidth * ratio) / ratio
  const width = ui.host.clientWidth - padding.left - padding.right - scrollbar
  const share = window.innerWidth < 480 ? PHONE_SCREEN_VIEWPORT_SHARE : MAX_SCREEN_VIEWPORT_SHARE
  const maxHeight = window.innerHeight * share
  let size = FIT_FONT_SIZE
  let cell = cellSize(size)
  while (
    size > MIN_FONT_SIZE &&
    (grid.cols * cell.width > width ||
      fittedScreenHeight(grid.rows, cell.height, padding) > maxHeight)
  ) {
    size -= 1
    cell = cellSize(size)
  }
  ui.screen.style.height = `${fittedScreenHeight(grid.rows, cell.height, padding)}px`
  setFont(size, FIT_LINE_HEIGHT)
}

function setFont(size: number, lineHeight: number): void {
  const current = terminal!.appearance.font
  if (current.size === size && current.lineHeight === lineHeight) return
  terminal!.setFont({ lineHeight, size })
}

function keepPointerForInput(event: Event): void {
  if (active.input) return
  event.stopPropagation()
}

function wireControls(): void {
  // The terminal's own wheel handler scrolls its scrollback and blocks the
  // page. Stop the event in the capture phase so the page scrolls instead.
  ui.host.addEventListener('wheel', (event) => event.stopPropagation(), { capture: true })
  // A tap would focus the terminal's input and pop the phone keyboard, and a drag would start a
  // selection; on demos that take no typing the touch belongs to the page scroll.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click'] as const) {
    ui.host.addEventListener(type, keepPointerForInput, { capture: true })
  }
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
    fitTo(active.fit)
  })
  document.addEventListener('visibilitychange', () => {
    if (paused) return
    active.setPaused(document.hidden)
  })
  ui.tabs.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-demo]')
    const demo = demos.find((candidate) => candidate.id === button?.dataset['demo'])
    if (demo) select(demo)
  })
  ui.tabs.addEventListener('keydown', (event) => {
    const step = TAB_STEPS[event.key]
    if (step === undefined) return
    const index = (demos.indexOf(active) + step + demos.length) % demos.length
    select(demos[index]!)
    tabButton(demos[index]!).focus()
  })
}

function tabButton(demo: Demo): HTMLButtonElement {
  return required<HTMLButtonElement>(`#tabs button[data-demo='${demo.id}']`)
}

function syncTabs(): void {
  for (const demo of demos) {
    const button = tabButton(demo)
    const selected = demo === active
    button.setAttribute('aria-selected', String(selected))
    button.tabIndex = selected ? 0 : -1
  }
  ui.caption.textContent = active.caption
  ui.host.setAttribute('aria-label', `${active.label} demo`)
}

function select(demo: Demo): void {
  if (demo === active || tabButton(demo).disabled) return
  active.stop()
  active = demo
  syncTabs()
  ui.stat.textContent = ''
  if (!terminal) return
  terminal.reset()
  startActive()
}

function startActive(waitForPaint = false): void {
  if (!terminal) return
  fitTo(active.fit)
  // Only the shell takes input; the animations would announce every frame.
  terminal.setAccessibilityEnabled(active.input !== undefined)
  active.setPaused(true)
  active.start(createContext(terminal))
  if (!waitForPaint) active.setPaused(active.animated && (paused || document.hidden))
  if (active.input) terminal.focus()
}

async function boot(): Promise<void> {
  wireControls()
  if (typeof WebAssembly === 'undefined') {
    showStillFrame()
    return
  }
  const fonts = loadFonts().then(() => performance.mark('ghost:fonts-ready'))
  ghost.prepare(loadGhostFrames())
  const frame = ui.firstFrame.querySelector('.ghostty-webgpu-frame')!
  const firstFontSize = Number.parseFloat(getComputedStyle(frame).fontSize)
  const base = document.baseURI
  performance.mark('ghost:create-start')
  const creating = Terminal.create({
    appearance: {
      cursor: { blink: true, style: 'block' },
      font: { family: FONT_FAMILY, lineHeight: FIT_LINE_HEIGHT, size: firstFontSize },
      scrollbackLimit: 2000,
      theme: terminalTheme(),
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
  const created = creating.then((instance) => {
    performance.mark('ghost:create-resolved')
    return instance
  })
  const [instance] = await Promise.all([created, fonts])
  attachTerminalHotkeys(instance)
  await instance.open(ui.host)
  performance.mark('ghost:open-resolved')
  terminal = instance

  const backend = instance.diagnostics.rendererBackend ?? 'unknown'
  ui.backend.textContent = backend
  ui.backendFact.textContent = backend
  ui.window.dataset['ready'] = 'true'

  instance.onResize(() => active.resize())
  instance.onData((bytes) => active.input?.(bytes))
  syncTabs()
  const firstPaint = instance.onFrame(() => {
    firstPaint.dispose()
    requestAnimationFrame(() => {
      ui.firstFrame.remove()
      performance.mark('ghost:first-frame')
      active.setPaused(active.animated && (paused || document.hidden))
    })
  })
  startActive(true)
}

function showStillFrame(): void {
  active.stop()
  active = ghost
  syncTabs()
  for (const demo of demos) tabButton(demo).disabled = true
  ui.backend.textContent = 'html'
  ui.backendFact.textContent = 'html'
  ui.stat.textContent = ''
  ui.caption.dataset['still'] = 'true'
  ui.caption.setAttribute('role', 'status')
  ui.caption.textContent =
    'The live terminal did not start in this browser, so this is a still frame.'
}

boot().catch((cause: unknown) => {
  showStillFrame()
  console.error('Live ghost animation failed to start', cause)
})
