import { GhosttyRuntime } from '../src/core/runtime.js'
import { fitTerminalFont } from '../src/dom/fit.js'
import { measuredRenderState } from './native-state.js'
import { createBenchmarkRenderer, parseBenchmarkBackend } from './renderer-factory.js'
import type {
  RendererBenchmark,
  BenchmarkScenario,
  BenchmarkResult,
} from './renderer-benchmark-types.js'

const columns = 200
const rows = 50
const backend = parseBenchmarkBackend(
  new URL(location.href).searchParams.get('backend') ?? 'webgpu',
)
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
let adapterInfo: unknown
let rendererPath = 'ghostty-web'
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
    size: 13,
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
  let acknowledgementMilliseconds = 0
  let acknowledgements = 0
  let acknowledgedRows = 0
  const renderState = measuredRenderState(state, decoded)
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

const driver = backend === 'ghostty-web' ? await createBaselineDriver() : await createNativeDriver()

function assertSelectedRendererPath(): void {
  if (backend === 'canvas2d-pixels' && rendererPath !== 'pixels')
    throw new Error('Canvas pixel benchmark arm selected a different paint mode')
}

function outputLine(index: number): string {
  return (
    `${String(index).padStart(8, '0')} ${'terminal-output '.repeat(12)}`.slice(0, columns - 2) +
    '\r\n'
  )
}

function write(data: string): void {
  const started = performance.now()
  driver.write(data)
  writeMilliseconds.push(performance.now() - started)
  writtenBytes += new TextEncoder().encode(data).byteLength
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

writeLines(200)
driver.write('\x1b[2;1H\x1b[?2027h界é\x1b[3mf\x1b[0m🧪')
await frame()
await frame()
assertNoDrawErrors()
assertSelectedRendererPath()
window.__rendererBench = {
  dispose: () => driver.dispose(),
  getPageInfo: () => ({
    adapter: adapterInfo,
    backend,
    rendererPath,
    columns,
    rows,
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
