import { RenderStateData } from '../src/core/abi.js'
import { GhosttyRuntime } from '../src/core/runtime.js'
import { Terminal } from '../src/dom/terminal.js'
import type { RendererMetrics } from '../src/render/shared/types.js'
import type { RowRendererMetrics } from '../src/render/shared/row-renderer.js'
import { fitTerminalFont } from '../src/dom/fit.js'
import { measuredRenderState } from './native-state.js'
import { createBenchmarkRenderer, parseBenchmarkBackend } from './renderer-factory.js'
import type {
  RendererBenchmark,
  BenchmarkScenario,
  BenchmarkResult,
} from './renderer-benchmark-types.js'

const parameters = new URL(location.href).searchParams
const columns = Number(parameters.get('columns') ?? 200)
const rows = Number(parameters.get('rows') ?? 50)
const backend = parseBenchmarkBackend(
  new URL(location.href).searchParams.get('backend') ?? 'webgpu',
)
const terminalVisibility = new URL(location.href).searchParams.get('terminals') === '16'
const mount = document.querySelector('main')
if (!mount) throw new Error('Missing benchmark mount')
const nativeRequestFrame = window.requestAnimationFrame.bind(window)
const nativeCancelFrame = window.cancelAnimationFrame.bind(window)
const pendingFrames = new Set<number>()
let callbackMilliseconds: number[] = []
let frameRequests = 0
let writeMilliseconds: number[] = []
let writtenBytes = 0
let sequence = 0
const decoded = { rows: 0, cells: 0 }
let planningStarted = 0
let planningIterators = 0
let rowPlanMilliseconds = 0
const instantiate = WebAssembly.instantiate
WebAssembly.instantiate = new Proxy(instantiate, {
  apply(target, receiver, args) {
    const [module, imports] = args
    const get = imports?.env?.ghostty_render_state_get
    if (typeof get !== 'function') return Reflect.apply(target, receiver, args)
    return Reflect.apply(target, receiver, [
      module,
      {
        ...imports,
        env: {
          ...imports.env,
          ghostty_render_state_get: (state: number, data: number, out: number) => {
            recordRowPlan(data)
            return get(state, data, out)
          },
        },
      },
    ])
  },
})

function recordRowPlan(data: number): void {
  if (planningStarted === 0 || data !== RenderStateData.RowIterator) return
  planningIterators += 1
  if (planningIterators !== 2) return
  rowPlanMilliseconds += performance.now() - planningStarted
}

let adapterInfo: unknown
let rendererPath = 'ghostty-web'
let visibilityGrid: Terminal['appearance']['grid'] | undefined
const drawErrors: string[] = []

function assertNoDrawErrors(): void {
  if (drawErrors.length === 0) return
  throw new Error(`Renderer reported ${drawErrors.length} draw error(s): ${drawErrors.join('; ')}`)
}

window.requestAnimationFrame = (callback) => {
  frameRequests += 1
  const handle = nativeRequestFrame((time) => {
    pendingFrames.delete(handle)
    const started = performance.now()
    callback(time)
    callbackMilliseconds.push(performance.now() - started)
  })
  pendingFrames.add(handle)
  return handle
}
window.cancelAnimationFrame = (handle) => {
  pendingFrames.delete(handle)
  nativeCancelFrame(handle)
}

const font = fitTerminalFont(
  document,
  {
    boldWeight: 700,
    family: 'monospace',
    letterSpacing: 0,
    lineHeight: 1.2,
    size: Number(parameters.get('fontSize') ?? 13),
    weight: 400,
  },
  devicePixelRatio,
)

interface Driver {
  dispose(): Promise<void> | void
  metrics(): Readonly<Record<string, number>>
  output(): string
  scroll(delta: number): void
  write(data: string): void
}

async function createNativeDriver(): Promise<Driver> {
  const canvas = document.createElement('canvas')
  mount!.append(canvas)
  const runtime = await GhosttyRuntime.create({ wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' })
  const terminal = runtime.createTerminal({
    columns,
    rows,
    cellWidth: font.deviceCellWidth,
    cellHeight: font.deviceCellHeight,
  })
  const state = runtime.createRenderState(terminal)
  let bridgeMilliseconds = 0
  let bridgeBuilds = 0
  let acknowledgementMilliseconds = 0
  let acknowledgements = 0
  let acknowledgedRows = 0
  const renderState = measuredRenderState(state, decoded)
  renderState.createFrameBuilder = (columns, rows) => {
    const builder = state.createFrameBuilder(columns, rows)
    const build = builder.build.bind(builder)
    builder.build = (options) => {
      const started = performance.now()
      planningStarted = started
      planningIterators = 0
      try {
        return build(options)
      } finally {
        planningStarted = 0
        bridgeMilliseconds += performance.now() - started
        bridgeBuilds += 1
      }
    }
    return builder
  }
  renderState.acknowledge = () => {
    const started = performance.now()
    const count = state.acknowledge()
    acknowledgementMilliseconds += performance.now() - started
    acknowledgements += 1
    acknowledgedRows += count
    return count
  }
  const options = {
    canvas,
    columns,
    rows,
    font,
    onFrame: () => {},
    onError: (cause: unknown) => {
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
      drawErrors.push(message)
      window.__rendererBenchFailure = message
    },
    needsFrameRows: () => false,
    theme: { foreground: { r: 255, g: 0, b: 0 }, background: { r: 0, g: 0, b: 0 } },
    renderState,
  }
  if (backend === 'ghostty-web') throw new Error('Native renderer backend required')
  let created: Awaited<ReturnType<typeof createBenchmarkRenderer>>
  try {
    created = await createBenchmarkRenderer(backend, options)
  } catch (cause) {
    runtime.dispose()
    throw cause
  }
  adapterInfo = created.adapter
  rendererPath = created.path
  const renderer = created.renderer
  renderer.setCursorBlinkEnabled(false)
  renderer.setFocused(false)
  return {
    async dispose() {
      try {
        await renderer.dispose()
      } finally {
        runtime.dispose()
      }
    },
    metrics: () => ({
      ...renderer.metrics,
      rowPlanMilliseconds,
      bridgeMilliseconds,
      bridgeBuilds,
      acknowledgementMilliseconds,
      acknowledgements,
      acknowledgedRows,
      decodedRows: decoded.rows,
      decodedCells: decoded.cells,
    }),
    output: () =>
      state
        .readRows()
        .map((row) =>
          row.cells
            .map((cell) => cell.text)
            .join('')
            .trimEnd(),
        )
        .join('\n'),
    scroll(delta) {
      terminal.scrollBy(delta)
      renderer.notifyScroll()
    },
    write(data) {
      terminal.write(data)
      renderer.notifyWrite()
    },
  }
}

async function createTerminalVisibilityDriver(): Promise<Driver> {
  if (backend === 'ghostty-web') throw new Error('Visibility benchmark requires native terminals')
  const runtime = await GhosttyRuntime.create({ wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' })
  const terminals: Terminal[] = []
  const renderers: Array<{ readonly metrics: RendererMetrics | RowRendererMetrics }> = []
  let submittedFrames = 0
  for (let index = 0; index < 16; index += 1) {
    const host = document.createElement('div')
    host.style.cssText = `position:absolute;left:${(index % 2) * 500}px;top:${index < 4 ? Math.floor(index / 2) * 160 : 10000 + index * 160}px;width:480px;height:150px`
    mount!.append(host)
    const terminal = await Terminal.create({
      runtime: { kind: 'borrowed', runtime },
      appearance: {
        cursor: { blink: false },
        font: { family: 'monospace', size: font.settings.size },
      },
      rendererFactory: async (options) => {
        const created = await createBenchmarkRenderer(backend, options)
        adapterInfo = created.adapter
        rendererPath = created.path
        renderers.push(created.renderer)
        return created.renderer
      },
    })
    terminal.onFrame(() => submittedFrames++)
    terminal.on('error', ({ cause }) => {
      drawErrors.push(String(cause))
      window.__rendererBenchFailure = String(cause)
    })
    terminals.push(terminal)
    await terminal.open(host)
    terminal.setTheme({
      ...terminal.appearance.theme,
      foreground: { r: 255, g: 0, b: 0 },
      background: { r: 0, g: 0, b: 0 },
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  visibilityGrid = terminals[0]?.appearance.grid
  return {
    async dispose() {
      for (const terminal of terminals) await terminal.dispose()
      runtime.dispose()
    },
    metrics() {
      const metrics: Record<string, number> = { hostSubmittedFrames: submittedFrames }
      for (const renderer of renderers) {
        for (const [key, value] of Object.entries(renderer.metrics))
          metrics[key] = (metrics[key] ?? 0) + value
      }
      return metrics
    },
    output: () =>
      terminals
        .map((terminal) =>
          terminal
            .readLines(0, terminal.lineCount())
            .map((line) => line.text)
            .join('\n'),
        )
        .join('\n---\n'),
    scroll: (delta) => {
      for (const terminal of terminals) terminal.scrollBy(delta)
    },
    write: (data) => {
      for (const terminal of terminals) terminal.write(data)
    },
  }
}

async function createBaselineDriver(): Promise<Driver> {
  const { init, Terminal } = await import('ghostty-web')
  await init()
  const terminal = new Terminal({
    cols: columns,
    rows,
    fontSize: 13,
    fontFamily: 'monospace',
    cursorBlink: false,
    theme: { foreground: '#ff0000', background: '#000000' },
  })
  await terminal.open(mount!)
  return {
    dispose: () => terminal.dispose(),
    metrics: () => ({}),
    output: () =>
      Array.from(
        { length: rows },
        (_, y) =>
          terminal.buffer.active
            .getLine(y + terminal.getScrollbackLength() - Math.floor(terminal.getViewportY()))
            ?.translateToString(true) ?? '',
      ).join('\n'),
    scroll: (delta) => terminal.scrollLines(delta),
    write: (data) => terminal.write(data),
  }
}

async function createDriver(): Promise<Driver> {
  if (terminalVisibility) return createTerminalVisibilityDriver()
  if (backend === 'ghostty-web') return createBaselineDriver()
  return createNativeDriver()
}
const driver = await createDriver()

function assertSelectedRendererPath(): void {
  if (backend === 'canvas2d-pixels' && rendererPath !== 'pixels')
    throw new Error('Canvas pixel benchmark arm selected a different paint mode')
}

function outputLine(index: number): string {
  return (
    `${String(index).padStart(8, '0')} ${'terminal-output '.repeat(Math.ceil(columns / 16))}`.slice(
      0,
      terminalVisibility ? 32 : columns - 2,
    ) + '\r\n'
  )
}

function write(data: string): void {
  const started = performance.now()
  const delivered = terminalVisibility
    ? data.replaceAll('\r\n', ' 界 é 🧑‍💻 \x1b[3mf\x1b[0m\r\n')
    : data
  driver.write(delivered)
  writeMilliseconds.push(performance.now() - started)
  writtenBytes += new TextEncoder().encode(delivered).byteLength * (terminalVisibility ? 16 : 1)
}

function writeLines(count: number): void {
  let output = ''
  for (let index = 0; index < count; index += 1) output += outputLine(sequence++)
  write(output)
}

function advance(scenario: BenchmarkScenario, step: number): void {
  if (scenario === 'cursor-movement') {
    write(`\x1b[${(step % rows) + 1};${(step % columns) + 1}H`)
    return
  }
  if (scenario === 'dense-redraw') {
    write(
      '\x1b[H' +
        Array.from({ length: rows }, (_, y) => outputLine(sequence + y).slice(0, -2)).join('\r\n'),
    )
    sequence += rows
    return
  }
  if (scenario === 'sparse-edit') {
    const text = step % 2 === 0 ? 'A' : 'B'
    write(`\x1b[1;1H${text}\x1b[${rows};${columns - 1}H${text}`)
    return
  }
  if (scenario === 'burst-output') {
    writeLines(10)
    return
  }
  if (scenario === 'sustained-scroll') {
    driver.scroll(step % 40 < 20 ? -1 : 1)
    return
  }
  if (scenario === 'glyph-churn') {
    const text = Array.from(
      { length: 24 },
      (_, offset) =>
        String.fromCodePoint(0x4e00 + ((sequence * 24 + offset) % 16000)) + 'e\u0301🧪',
    ).join('')
    sequence += 1
    write(text + '\r\n')
  }
}

function frame(): Promise<void> {
  return new Promise((resolve) => nativeRequestFrame(() => resolve()))
}

async function run(
  scenario: BenchmarkScenario,
  steps: number,
  idleMilliseconds: number,
): Promise<BenchmarkResult> {
  const before = driver.metrics()
  callbackMilliseconds = []
  frameRequests = 0
  writeMilliseconds = []
  writtenBytes = 0
  const started = performance.now()
  if (scenario === 'settled-idle')
    await new Promise((resolve) => setTimeout(resolve, idleMilliseconds))
  for (let step = 0; step < steps && scenario !== 'settled-idle'; step += 1) {
    advance(scenario, step)
    await frame()
  }
  await frame()
  assertNoDrawErrors()
  const elapsedMilliseconds = performance.now() - started
  const after = driver.metrics()
  const metrics = Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]),
  )
  return {
    callbackMilliseconds,
    elapsedMilliseconds,
    frameRequests,
    metrics,
    pendingFrames: pendingFrames.size,
    steps: scenario === 'settled-idle' ? 0 : steps,
    writeMilliseconds,
    writtenBytes,
  }
}

writeLines(Math.max(200, rows * 2))
driver.write('\x1b[2;1H\x1b[?2027h界é\x1b[3mf\x1b[0m🧪')
await frame()
await frame()
assertNoDrawErrors()
assertSelectedRendererPath()
window.__rendererBench = {
  dispose: () => driver.dispose(),
  getPageInfo: () => ({
    terminals: terminalVisibility ? { total: 16, offscreen: 12 } : undefined,
    adapter: adapterInfo,
    backend,
    rendererPath,
    columns: visibilityGrid?.columns ?? columns,
    rows: visibilityGrid?.rows ?? rows,
    dpr: devicePixelRatio,
    font:
      backend === 'ghostty-web'
        ? { requested: { family: 'monospace', size: 13 }, metrics: 'package defaults' }
        : font,
    canvas: {
      width: mount.querySelector('canvas')?.width,
      height: mount.querySelector('canvas')?.height,
    },
  }),
  output: () => driver.output(),
  run,
} satisfies RendererBenchmark
