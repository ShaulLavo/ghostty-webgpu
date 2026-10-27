import { createHostedDriver } from './renderer-hosted-driver.mjs'
import {
  tracing,
  attachNative,
  attachRenderer,
  snapshot,
  startup,
  completion,
} from './renderer-diagnostics.mjs'
import { fixtureText } from './comparison-fixtures.js'
import type { GhosttyTerminal } from '../src/core/terminal.js'
import { GhosttyRuntime } from '../src/core/runtime.js'
import { fitTerminalFont } from '../src/dom/fit.js'
import { measuredRenderState } from './native-state.js'
import { createBenchmarkRenderer, parseBenchmarkBackend } from './renderer-factory.js'
import type {
  RendererBenchmark,
  BenchmarkScenario,
  BenchmarkResult,
} from './renderer-benchmark-types.js'

const params = new URL(location.href).searchParams
const columns = Number(params.get('columns') ?? 200)
const rows = Number(params.get('rows') ?? 50)
const terminalCount = Number(params.get('count') ?? 1)
const doTrace = params.has('trace')
const doCompletion = params.has('completion')
const nativeDrivers: {
  runtime: GhosttyRuntime
  renderer: Awaited<ReturnType<typeof createBenchmarkRenderer>>['renderer']
  core: GhosttyTerminal
}[] = []
const frameTimes: number[] = []
const startupBegin = performance.now()
const backend = parseBenchmarkBackend(
  new URL(location.href).searchParams.get('backend') ?? 'webgpu',
)
let externalChunks: string[] = []
if (params.has('workload')) {
  const bytes = new Uint8Array(await (await fetch('/workload.bin')).arrayBuffer())
  const metadata = await (await fetch('/workload.json')).json()
  externalChunks = metadata.chunks.map(({ offset, length }: { offset: number; length: number }) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + length)),
  )
}
const mount = document.querySelector('main')
if (!mount) throw new Error('Missing benchmark mount')
const nativeRequestFrame = window.requestAnimationFrame.bind(window)
const nativeCancelFrame = window.cancelAnimationFrame.bind(window)
const pendingFrames = new Set<number>()
let callbackMilliseconds: number[] = []
let frameRequests = 0
let writeMilliseconds: number[] = []
let writtenBytes = 0
let pendingWrites: Promise<unknown>[] = []
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
  readonly adapter?: unknown
  dispose(): Promise<void> | void
  metrics(): Readonly<Record<string, number>>
  output(): string
  scroll(delta: number): void
  prepare?(): Promise<void>
  diagnostics?(): Promise<unknown>
  write(data: string): unknown
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
  terminal.setScrollbackLimit(Number(params.get('scrollback') ?? 10000))
  const state = runtime.createRenderState(terminal)
  if (doTrace) attachNative(nativeDrivers.length, runtime, terminal, state)
  const options = {
    canvas,
    columns,
    rows,
    font,
    onFrame: () => {
      frameTimes.push(performance.now())
    },
    onError: (cause: unknown) => {
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
      drawErrors.push(message)
      window.__rendererBenchFailure = message
    },
    needsFrameRows: () => false,
    theme: { foreground: { r: 255, g: 0, b: 0 }, background: { r: 0, g: 0, b: 0 } },
    renderState: measuredRenderState(state, decoded),
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
  if (doTrace) attachRenderer(nativeDrivers.length, renderer)
  nativeDrivers.push({ runtime, renderer, core: terminal })
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

const drivers: Driver[] = []
for (let index = 0; index < terminalCount; index += 1)
  drivers.push(
    params.has('hosted')
      ? await createHostedDriver({
          backend,
          columns,
          rows,
          mount: mount!,
          worker: params.has('worker'),
          doTrace,
        })
      : backend === 'ghostty-web'
        ? await createBaselineDriver()
        : await createNativeDriver(),
  )
if (params.has('hosted')) adapterInfo = drivers[0]!.adapter
const driver: Driver = {
  dispose: async () => {
    for (const entry of drivers) await entry.dispose()
  },
  output: () => drivers[0]!.output(),
  scroll: (delta) => {
    for (const entry of drivers) entry.scroll(delta)
  },
  write: (data) => {
    for (const entry of drivers) {
      const result = entry.write(data)
      if (result instanceof Promise) pendingWrites.push(result)
    }
  },
  metrics: () => {
    const metrics: Record<string, number> = {}
    for (const entry of drivers) {
      for (const [key, value] of Object.entries(entry.metrics()))
        metrics[key] = (metrics[key] ?? 0) + value
    }
    return metrics
  },
}

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
  if (scenario === 'external') {
    write(externalChunks[step % externalChunks.length]!)
    return
  }
  if (scenario === 'sparse-edit') {
    write(`\x1b[${(step % rows) + 1};${(step % columns) + 1}H${step % 10}`)
    return
  }
  if (scenario === 'dense-redraw') {
    const line = String(step % 10).repeat(columns - 1)
    write('\x1b[H' + Array.from({ length: rows }, () => line).join('\r\n'))
    return
  }
  if (scenario === 'warm-unicode') {
    write(fixtureText('unicode', '').repeat(4))
    return
  }
  if (scenario === 'cold-cache') {
    for (const entry of nativeDrivers) entry.renderer.clearTextureAtlas()
    write(fixtureText('unicode', '').repeat(4))
    return
  }
  if (scenario === 'resize-dpr') {
    const next = { columns: columns + (step % 2), rows: rows + (step % 2) }
    const nextFont = fitTerminalFont(document, { ...font.settings, size: 13 }, (step % 2) + 1)
    for (const entry of nativeDrivers) {
      entry.core.resize({
        ...next,
        cellWidth: nextFont.deviceCellWidth,
        cellHeight: nextFont.deviceCellHeight,
      })
      entry.renderer.resize(next)
      entry.renderer.setFont(nextFont)
    }
    return
  }
  if (scenario === 'hidden-output') {
    writeLines(10)
    return
  }

  if (scenario === 'cursor-movement') {
    write(`\x1b[${(step % rows) + 1};${(step % columns) + 1}H`)
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
  for (const entry of nativeDrivers) {
    entry.renderer.setDocumentVisible(scenario !== 'hidden-output')
    entry.renderer.setFocused(scenario === 'cursor-blink')
    entry.renderer.setCursorBlinkEnabled(scenario === 'cursor-blink')
  }
  if (scenario === 'cursor-blink') {
    write('\x1b[1 q')
    await frame()
    await frame()
  }
  await Promise.all(drivers.map((entry) => entry.prepare?.()))
  const before = driver.metrics()
  const completions = []
  const frameIntervals = []
  const writeCompletions = []
  if (doTrace) tracing.begin()
  callbackMilliseconds = []
  frameRequests = 0
  writeMilliseconds = []
  writtenBytes = 0
  const started = performance.now()
  if (scenario === 'settled-idle' || scenario === 'cursor-blink')
    await new Promise((resolve) => setTimeout(resolve, idleMilliseconds))
  for (
    let step = 0;
    step < steps && scenario !== 'settled-idle' && scenario !== 'cursor-blink';
    step += 1
  ) {
    const frameStarted = performance.now()
    advance(scenario, step)
    await Promise.all(pendingWrites)
    pendingWrites = []
    writeCompletions.push(performance.now() - frameStarted)
    await frame()
    frameIntervals.push(performance.now() - frameStarted)
    if (doCompletion) {
      for (const entry of nativeDrivers) completions.push(await completion(entry.renderer))
    }
  }
  await frame()
  assertNoDrawErrors()
  const elapsedMilliseconds = performance.now() - started
  const hosted = await Promise.all(drivers.map((entry) => entry.diagnostics?.()))
  const trace = doTrace ? tracing.end() : null
  const after = driver.metrics()
  const metrics = Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]),
  )
  return {
    diagnostics: {
      hosted,
      started,
      ended: started + elapsedMilliseconds,
      writeCompletions,
      trace,
      completions,
      frameIntervals,
      startup,
      startupToReady: startupReady,
      firstSubmittedMilliseconds: frameTimes[0]! - startupBegin,
      terminals: nativeDrivers.map((entry) => snapshot(entry.runtime, entry.renderer)),
    },
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

await Promise.all(pendingWrites)
pendingWrites = []
writeLines(Math.max(1, Number(params.get('history') ?? 200)))
await Promise.all(pendingWrites)
pendingWrites = []
await frame()
await frame()
assertNoDrawErrors()
assertSelectedRendererPath()
const startupReady = performance.now() - startupBegin
window.__rendererBench = {
  dispose: () => driver.dispose(),
  getPageInfo: () => ({
    adapter: adapterInfo,
    backend,
    rendererPath,
    columns,
    rows,
    terminalCount,
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
