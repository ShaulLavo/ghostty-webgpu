import { pinXtermStudyGeometry } from './study-xterm.mjs'
import { createNm } from './study-nm.mjs'
import { createWraith } from './study-wraith.mjs'
import {
  expectedScreen,
  inputChunks,
  pacedBurst,
  parseChunks,
  qualifyScreen,
  synchronousWrite,
  type InputChunk,
  type ParserScreen,
} from './comparison-protocol.js'
import { Terminal as Xterm } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { Ghostty, Terminal as GhosttyWeb } from 'ghostty-web'
import { GhosttyRuntime } from '../src/core/runtime.js'
import { GhosttyTerminal } from '../src/core/terminal.js'
import { TerminalOption } from '../src/core/abi.js'
import { TerminalSession } from '../src/term/session.js'
import { createGhosttyWebGpuTerminalFromSession } from '../src/dom/terminal.js'
import { RenderScheduler } from '../src/render/shared/scheduler.js'
import { WebGpuTerminalRenderer } from '../src/render/webgpu/renderer.js'
import { WebGlTerminalRenderer } from '../src/render/webgl/renderer.js'
import { CanvasTerminalRenderer } from '../src/render/canvas/renderer.js'
import { DomTerminalRenderer } from '../src/render/dom/renderer.js'
import type { RowRendererMetrics } from '../src/render/shared/row-renderer.js'
import { ComparisonTracing } from './comparison-tracing.js'
import { refreshSampler } from './comparison-refresh.js'
import { frameMetricDeltas } from './comparison-metrics.js'
import { legacyText } from './comparison-legacy-text.js'
import {
  corpus,
  fixtureNames,
  fixtureText,
  isRollingFixture,
  marker,
  rollingByteCount,
  rollingFixture,
  rollingInputs,
  settings as baseSettings,
  spotCheck,
  type ComparisonCase,
  type FixtureName,
  type RollingFixture,
  type RollingFixtureName,
} from './comparison-fixtures.js'

document.body.classList.toggle('study', new URL(location.href).searchParams.has('study'))

const settings = {
  ...baseSettings,
  columns: Number(new URL(location.href).searchParams.get('columns') ?? baseSettings.columns),
  rows: Number(new URL(location.href).searchParams.get('rows') ?? baseSettings.rows),
  ...(new URL(location.href).searchParams.has('study') ? { columns: 100, rows: 30 } : {}),
}

export interface Driver {
  complete?(): Promise<void>
  asyncText?(): Promise<readonly string[]>
  resize?(columns: number, rows: number): void
  metadata?(): unknown
  write(data: string | Uint8Array): Promise<void>
  text(): readonly string[]
  history(): number
  pendingWriteBytes?(): number
  focus(): void
  onData(listener: (data: string | Uint8Array) => void): void
  dispose(): void
  frameMetrics?():
    | import('../src/render/shared/types.js').RendererMetrics
    | RowRendererMetrics
    | undefined
}

const accessibility = new URLSearchParams(location.search).get('accessibility') === 'on'
const tracing = new ComparisonTracing()
const writeMode = new URL(location.href).searchParams.get('writeMode') ?? 'sync'
const sustained = new URL(location.href).searchParams.has('sustained')
const mount = document.querySelector('main')!
let drivers: Driver[] = []
let native: GhosttyRuntime | undefined
let legacy: Ghostty | undefined
let current: ComparisonCase
let logs = ''
interface PreparedBurst {
  fixture?: RollingFixture
  chunks: readonly InputChunk[]
  bytes: number
  reset: InputChunk
}
let preparedBursts = new Map<FixtureName, PreparedBurst>()
let keyTime = 0
let echoColor: 'red' | 'green' = 'red'
let sustainedOutput: Promise<void> | undefined
const sustainedWrites = new Set<Promise<void>>()
let sustainedStarted = 0
let sustainedMetrics: Record<string, number>[] = []
let socket: WebSocket | undefined
let adapterInfo: unknown
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const nativeFrame = requestAnimationFrame.bind(window)

export function frame(): Promise<number> {
  return new Promise((resolve) =>
    nativeFrame((time) => {
      tracing.mark('paced-frame', { timestamp: time })
      resolve(time)
    }),
  )
}

async function settle(): Promise<void> {
  await frame()
  await frame()
}

function input(data: string): string | Uint8Array {
  return current.path === 'bytes' ? encoder.encode(data) : data
}

function configureNativeHistory(terminal: GhosttyTerminal): void {
  const { runtime } = terminal
  const pointer = runtime.memory.allocate(4)
  try {
    runtime.memory.view.setUint32(pointer, settings.ghosttyScrollbackBytes, true)
    const result = runtime.exports.ghostty_terminal_set(
      terminal.handle,
      TerminalOption.ScrollbackMaxBytes,
      pointer,
    )
    if (result !== 0)
      throw new Error(`Native scrollback byte-budget configuration failed: ${result}`)
  } finally {
    runtime.memory.free(pointer, 4)
  }
}

async function createNative(host: HTMLElement): Promise<Driver> {
  native ??= await GhosttyRuntime.create({
    wasm: '/native.wasm',
    bridge: '/bridge.wasm',
  })
  const session = await TerminalSession.create<Event>({
    runtime: { kind: 'borrowed', runtime: native },
    appearance: {
      grid: { columns: settings.columns, rows: settings.rows },
      scrollbackLimit: settings.scrollback,
      font: {
        family: settings.fontFamily,
        size: settings.fontSize,
        lineHeight: settings.lineHeight,
      },
      cursor: { blink: false },
    },
  })
  // The session exposes a line limit; upstream's independent byte budget needs its ABI option.
  const core: unknown = Reflect.get(session, 'terminal')
  if (!(core instanceof GhosttyTerminal)) throw new Error('Native session terminal unavailable')
  configureNativeHistory(core)
  tracing.native(
    drivers.length,
    core,
    session.renderState as import('../src/core/render-state.js').GhosttyRenderState,
  )
  session.setTheme({
    ...session.appearance.theme,
    background: { r: 0, g: 0, b: 0 },
    foreground: { r: 255, g: 255, b: 255 },
  })
  let mountedRenderer:
    | WebGpuTerminalRenderer
    | WebGlTerminalRenderer
    | CanvasTerminalRenderer
    | DomTerminalRenderer
    | undefined
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    accessibility: accessibility ? {} : false,
    rendererFactory: async (options) => {
      if (current.variant !== 'ghostty-webgpu') {
        const factories = {
          'ghostty-webgl': WebGlTerminalRenderer,
          'ghostty-canvas': CanvasTerminalRenderer,
          'ghostty-dom': DomTerminalRenderer,
        }
        const factory = factories[current.variant as keyof typeof factories]
        if (!factory) throw new Error('Explicit native renderer required')
        const renderer = await factory.create({
          ...options,
        })
        tracing.nativeRenderer(drivers.length, renderer)
        mountedRenderer = renderer
        return renderer
      }
      const renderer = await WebGpuTerminalRenderer.create(options)
      const device: unknown = Reflect.get(renderer, 'device')
      if (!(device instanceof GPUDevice)) throw new Error('Renderer WebGPU device required')
      const adapter = device.adapterInfo
      adapterInfo = {
        vendor: adapter.vendor,
        architecture: adapter.architecture,
        description: adapter.description,
        fallback: adapter.isFallbackAdapter,
      }
      tracing.renderer(drivers.length, renderer)
      mountedRenderer = renderer
      return renderer
    },
  })
  terminal.on('error', (event) => {
    throw event.cause
  })
  await terminal.open(host)
  tracing.wrap(terminal, writeMode === 'batched' ? 'writeBatched' : 'write', drivers.length, 'js')
  return {
    write: async (data) => {
      if (writeMode === 'batched') {
        await terminal.writeBatched(data)
        return
      }
      terminal.write(data)
    },
    text: () => terminal.visibleLines(),
    complete: async () => {
      if (!(mountedRenderer instanceof WebGpuTerminalRenderer))
        throw new Error('WebGPU completion requires the WebGPU renderer')
      const scheduler: unknown = Reflect.get(mountedRenderer, 'scheduler')
      if (!(scheduler instanceof RenderScheduler)) throw new Error('Renderer scheduler required')
      scheduler.flush()
      const device: unknown = Reflect.get(mountedRenderer, 'device')
      if (!(device instanceof GPUDevice)) throw new Error('Renderer device required')
      await device.queue.onSubmittedWorkDone()
    },
    frameMetrics: () => (mountedRenderer ? { ...mountedRenderer.metrics } : undefined),
    history: () => terminal.lineCount() - settings.rows,
    pendingWriteBytes: () => terminal.pendingWriteBytes,
    focus: () => terminal.focus(),
    onData: (listener) => {
      terminal.onData(({ bytes }) => listener(bytes))
    },
    resize: (columns, rows) => {
      session.resize({ columns, rows })
    },
    dispose: () => terminal.dispose(),
  }
}

async function createLegacy(host: HTMLElement): Promise<Driver> {
  legacy ??= await Ghostty.load('/legacy.wasm')
  const terminal = new GhosttyWeb({
    ghostty: legacy,
    cols: settings.columns,
    rows: settings.rows,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    scrollback: settings.ghosttyScrollbackBytes,
    cursorBlink: false,
    theme: { foreground: '#ffffff', background: '#000000' },
  })
  terminal.open(host)
  tracing.legacy(drivers.length, terminal)
  tracing.wrap(terminal, 'write', drivers.length, 'js')
  return {
    write: synchronousWrite((data) => terminal.write(data)),
    text: () => legacyText(terminal),
    history: () => terminal.getScrollbackLength(),
    focus: () => terminal.focus(),
    onData: (listener) => {
      terminal.onData(listener)
    },
    resize: (columns, rows) => terminal.resize(columns, rows),
    dispose: () => terminal.dispose(),
  }
}

function createXterm(host: HTMLElement): Driver {
  const terminal = new Xterm({
    cols: settings.columns,
    rows: settings.rows,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    scrollback: settings.scrollback,
    cursorBlink: false,
    screenReaderMode: accessibility,
    theme: { foreground: '#ffffff', background: '#000000' },
  })
  terminal.open(host)
  if (current.variant === 'xterm-webgl') {
    const addon = new WebglAddon()
    terminal.loadAddon(addon)
    if (new URL(location.href).searchParams.has('study'))
      pinXtermStudyGeometry(addon, settings.columns, settings.rows)
    tracing.xterm(drivers.length, terminal, addon)
  } else {
    tracing.xtermDom(drivers.length, terminal)
  }
  tracing.wrap(terminal, 'write', drivers.length, 'js')
  return {
    write: (data) => new Promise((resolve) => terminal.write(data, resolve)),
    text: () =>
      Array.from(
        { length: settings.rows },
        (_, y) =>
          terminal.buffer.active
            .getLine(y + terminal.buffer.active.baseY)
            ?.translateToString(true) ?? '',
      ),
    history: () => terminal.buffer.active.baseY,
    focus: () => terminal.focus(),
    onData: (listener) => {
      terminal.onData(listener)
    },
    resize: (columns, rows) => terminal.resize(columns, rows),
    dispose: () => terminal.dispose(),
  }
}

async function createTerminals(): Promise<void> {
  const faces = [400, 700].map(
    (weight) => `${weight} ${settings.fontSize}px "${settings.fontFamily}"`,
  )
  await Promise.all(faces.map((face) => document.fonts.load(face)))
  await document.fonts.ready
  if (faces.some((face) => !document.fonts.check(face)))
    throw new Error('Benchmark regular or bold font failed to load')
  for (let index = 0; index < current.count; index++) {
    const host = document.createElement('section')
    mount.append(host)
    let driver: Driver
    if (current.variant !== 'ghostty-web' && current.variant.startsWith('ghostty-'))
      driver = await createNative(host)
    else if (current.variant === 'ghostty-web') driver = await createLegacy(host)
    else if (current.variant === 'nm-webgpu') driver = await createNm(host, settings)
    else if (current.variant === 'wraith-native') driver = await createWraith(host, settings)
    else driver = createXterm(host)
    drivers.push(driver)
  }
  await writeAll('\x1b[?25l')
  await settle()
}

async function writeAll(text: string): Promise<void> {
  const data = input(text)
  await Promise.all(drivers.map((driver) => driver.write(data)))
}

function sustainedChunk(sequence: number): InputChunk {
  const line = `${String(sequence).padStart(8, '0')} ${'terminal-output '.repeat(Math.ceil(settings.columns / 16))}`
  return input(`\x1b[${settings.rows};1H\x1b[2K${line.slice(0, settings.columns - 2)}`)
}

async function startSustainedOutput(chunks: number): Promise<void> {
  await writeAll('\x1b[0m\x1b[2J\x1b[H')
  await settle()
  sustainedMetrics = drivers.map((driver) => ({ ...driver.frameMetrics?.() }))
  sustainedStarted = performance.now()
  sustainedOutput = (async () => {
    for (let sequence = 0; sequence < chunks; sequence += 1) {
      const chunk = sustainedChunk(sequence)
      for (const driver of drivers) {
        const write = driver.write(chunk)
        sustainedWrites.add(write)
        void write.then(
          () => sustainedWrites.delete(write),
          () => sustainedWrites.delete(write),
        )
        while ((driver.pendingWriteBytes?.() ?? 0) > 4 * 1024 * 1024)
          await Promise.race(Array.from(sustainedWrites))
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })()
}

async function finishSustainedOutput(chunks: number, chunkBytes: number) {
  await sustainedOutput
  await Promise.all(Array.from(sustainedWrites))
  await settle()
  const elapsedMilliseconds = performance.now() - sustainedStarted
  return {
    elapsedMilliseconds,
    parsedBytes: chunks * drivers.length * chunkBytes,
    parsedWrites: chunks * drivers.length,
    submittedFrames: drivers.reduce(
      (total, driver) => total + (driver.frameMetrics?.()?.submittedFrames ?? 0),
      0,
    ),
    submittedFrameDelta: drivers.reduce((total, driver, index) => {
      const after = driver.frameMetrics?.()?.submittedFrames ?? 0
      const before = sustainedMetrics[index]?.submittedFrames ?? 0
      return total + after - before
    }, 0),
    pendingWriteBytes: drivers.reduce(
      (total, driver) => total + (driver.pendingWriteBytes?.() ?? 0),
      0,
    ),
  }
}

async function driverTexts() {
  return Promise.all(drivers.map((driver) => driver.asyncText?.() ?? driver.text()))
}

function spotQualified(lines: readonly string[]): boolean {
  return Boolean(
    lines[0]?.includes('ASCII abc 123') &&
    lines[1]?.includes('red green') &&
    lines[2]?.includes('日本語') &&
    lines[6]?.includes('overwrite new') &&
    lines[2]?.includes('é') &&
    lines[3]?.includes('👩‍💻') &&
    lines[3]?.includes('👨‍👩‍👧‍👦'),
  )
}

async function correctness(): Promise<unknown> {
  await writeAll(spotCheck)
  let output = await driverTexts()
  for (let attempt = 0; attempt < 120; attempt++) {
    if (output.every(spotQualified)) return output
    await frame()
    output = await driverTexts()
  }
  throw new Error(`Submitted text spot check failed: ${JSON.stringify(output)}`)
}

async function initialize(testCase: ComparisonCase): Promise<void> {
  current = testCase
  logs = await (await fetch('/logs.txt')).text()
  // Keep prepared inputs reachable until disposal, including across warmup and counter windows.
  preparedBursts = new Map()
  const reset = input('\x1b[3J\x1b[2J\x1b[H')
  for (const name of fixtureNames) {
    if (isRollingFixture(name)) {
      const fixture = rollingFixture(logs, settings.corpusBytes, settings.chunkBytes, name)
      preparedBursts.set(name, {
        fixture,
        chunks: rollingInputs(fixture, current.path),
        bytes: fixture.bytes.length,
        reset,
      })
      continue
    }
    const text = corpus(fixtureText(name, logs), settings.chunkBytes)
    const bytes = encoder.encode(text)
    preparedBursts.set(name, {
      chunks: [current.path === 'bytes' ? bytes : text],
      bytes: bytes.length,
      reset,
    })
  }
}

async function smokeParse(name: FixtureName, size: number = settings.chunkBytes): Promise<unknown> {
  return parseFixture(name, size === 1 ? 128 : 8192, false, size)
}

async function smokeMarker(): Promise<void> {
  await drivers[0]!.write(input('\x1b[2J'))
  await settle()
  await drivers[0]!.write(input(marker('red')))
  await settle()
}

async function parse(name: FixtureName, minimumBytes: number): Promise<unknown> {
  return parseFixture(name, minimumBytes, true, settings.chunkBytes)
}

interface ParserDriver {
  write(data: InputChunk): unknown
  screen(): ParserScreen
  dispose(): void
}

async function parseFixture(
  name: FixtureName,
  minimumBytes: number,
  timed: boolean,
  size: number,
): Promise<unknown> {
  const unit = fixtureText(name, logs)
  const text = corpus(unit, minimumBytes)
  const bytes = encoder.encode(text)
  const chunks = inputChunks(bytes, current.path, size)
  const expected = expectedScreen(
    isRollingFixture(name) ? 'logs' : name,
    unit,
    text.length / unit.length,
    settings.columns,
    settings.rows,
  )
  const driver = await parser()
  try {
    driver.write(input('\x1b[?1049h'))
    const started = timed ? performance.now() : 0
    parseChunks((chunk) => driver.write(chunk), chunks)
    const milliseconds = timed ? performance.now() - started : undefined
    let screen: ParserScreen
    try {
      screen = driver.screen()
    } catch (cause) {
      throw new Error(`${name} parser snapshot failed: ${String(cause)}`, {
        cause,
      })
    }
    const validation = qualifyScreen(screen, expected)
    return {
      bytes: bytes.length,
      milliseconds,
      chunkCount: chunks.length,
      validation,
    }
  } finally {
    driver.dispose()
  }
}

async function parser(): Promise<ParserDriver> {
  if (current.variant.startsWith('xterm-')) {
    const terminal = new Xterm({
      cols: settings.columns,
      rows: settings.rows,
      scrollback: 0,
    })
    // Pinned 6.0.0 boundary includes decoding, VT parsing and buffer writes; excludes WriteBuffer timers.
    const handler = Reflect.get(Reflect.get(terminal, '_core'), '_inputHandler') as {
      parse(data: InputChunk): unknown
    }
    if (typeof handler?.parse !== 'function')
      throw new Error('Pinned xterm input handler unavailable')
    return {
      write: (data) => handler.parse(data),
      screen: () => {
        const buffer = terminal.buffer.active
        const cells = Array.from({ length: settings.rows }, (_, y) =>
          Array.from({ length: settings.columns }, (_, x) => {
            const cell = buffer.getLine(y + buffer.baseY)!.getCell(x)!
            const value = cell.getFgColor()
            let rgb: [number, number, number] | undefined
            if (cell.isFgRGB()) rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
            if (cell.isFgPalette() && value === 1) rgb = [255, 0, 0]
            if (cell.isFgPalette() && value === 2) rgb = [0, 255, 0]
            return {
              text: cell.getWidth() === 0 ? '' : cell.getChars() || ' ',
              bold: Boolean(cell.isBold()),
              underline: Boolean(cell.isUnderline()),
              rgb,
            }
          }),
        )
        return {
          cells,
          lines: cells.map((row) =>
            row
              .map((cell) => cell.text)
              .join('')
              .trimEnd(),
          ),
          cursor: { x: buffer.cursorX, y: buffer.cursorY },
        }
      },
      dispose: () => terminal.dispose(),
    }
  }
  if (current.variant === 'ghostty-web') {
    const runtime = await Ghostty.load('/legacy.wasm')
    const terminal = runtime.createTerminal(settings.columns, settings.rows, {
      scrollbackLimit: settings.scrollback,
    })
    return {
      write: (data) => terminal.write(data),
      screen: () => {
        terminal.update()
        const viewport = terminal.getViewport()
        const cells = Array.from({ length: settings.rows }, (_, y) =>
          Array.from({ length: settings.columns }, (_, x) => {
            const cell = viewport[y * settings.columns + x]!
            let text = ' '
            if (cell.width === 0) text = ''
            else if (cell.codepoint !== 0) text = terminal.getGraphemeString(y, x)
            return {
              text,
              bold: Boolean(cell.flags & 1),
              underline: Boolean(cell.flags & 4),
              rgb: [cell.fg_r, cell.fg_g, cell.fg_b] as const,
            }
          }),
        )
        const cursor = terminal.getCursor()
        return {
          cells,
          lines: cells.map((row) =>
            row
              .map((cell) => cell.text)
              .join('')
              .trimEnd(),
          ),
          cursor: { x: cursor.x, y: cursor.y },
        }
      },
      dispose: () => terminal.free(),
    }
  }
  const runtime = await GhosttyRuntime.create({
    wasm: '/native.wasm',
    bridge: '/bridge.wasm',
  })
  const terminal = runtime.createTerminal({
    columns: settings.columns,
    rows: settings.rows,
  })
  terminal.setScrollbackLimit(settings.scrollback)
  configureNativeHistory(terminal)
  const render = runtime.createRenderState(terminal)
  return {
    write: (data) => terminal.write(data),
    screen: () => {
      const snapshot = render.snapshot()
      const cells = snapshot.rows.map((row) =>
        row.cells.map((cell) => ({
          text: cell.continuation ? '' : cell.text || ' ',
          bold: cell.style?.bold ?? false,
          underline: Boolean(cell.style?.underline),
          rgb: cell.foreground
            ? ([cell.foreground.r, cell.foreground.g, cell.foreground.b] as const)
            : undefined,
        })),
      )
      const cursor = terminal.cursor
      return {
        cells,
        lines: cells.map((row) =>
          row
            .map((cell) => cell.text)
            .join('')
            .trimEnd(),
        ),
        cursor: { x: cursor.x, y: cursor.y },
      }
    },
    dispose: () => runtime.dispose(),
  }
}

async function legacyEmptyWrite(): Promise<unknown> {
  if (current.variant !== 'ghostty-web') return undefined
  const runtime = await Ghostty.load('/legacy.wasm')
  const terminal = runtime.createTerminal(settings.columns, settings.rows)
  const probe = (write: () => void) => {
    try {
      write()
      return { accepted: true }
    } catch (cause) {
      return { accepted: false, error: String(cause) }
    }
  }
  try {
    terminal.write('ASCII\r\n')
    return {
      coreApi: probe(() => terminal.write('')),
      documentedTerminalApi: await drivers[0]!.write('').then(
        () => ({ accepted: true }),
        (cause) => ({ accepted: false, error: String(cause) }),
      ),
    }
  } finally {
    terminal.free()
  }
}

async function legacyWriteControl(): Promise<unknown> {
  const text = corpus('ASCII control\r\n', settings.chunkBytes)
  const data = input(text)
  await drivers[0]!.write('\x1b[3J\x1b[2J\x1b[H')
  for (let call = 0; call < 35; call++) {
    await drivers[0]!.write(data)
    await settle()
  }
  return {
    documentedTerminalApi: { accepted: true, calls: 35, bytesPerCall: encoder.encode(text).length },
  }
}

async function legacyOriginalUnicode(): Promise<unknown> {
  if (current.variant !== 'ghostty-web') return undefined
  const unit = '日本語 中文 é café 👩‍💻 👨‍👩‍👧‍👦 🧪\r\n'
  const text = corpus(unit, settings.chunkBytes)
  const data = current.path === 'bytes' ? encoder.encode(text) : text
  const runtime = await Ghostty.load('/legacy.wasm')
  const terminal = runtime.createTerminal(settings.columns, settings.rows)
  const probe = async (api: string, write: (data: InputChunk) => unknown) => {
    let calls = 0
    try {
      await write('\x1b[3J\x1b[2J\x1b[H')
      for (; calls < 35; calls++) {
        console.info(
          'legacy-original-unicode',
          JSON.stringify({ api, call: calls + 1, phase: 'before-write' }),
        )
        await write(data)
        console.info(
          'legacy-original-unicode',
          JSON.stringify({ api, call: calls + 1, phase: 'after-write' }),
        )
        await settle()
        console.info(
          'legacy-original-unicode',
          JSON.stringify({ api, call: calls + 1, phase: 'after-frame' }),
        )
      }
      return {
        accepted: true,
        calls,
        bytesPerCall: encoder.encode(text).length,
      }
    } catch (cause) {
      return {
        accepted: false,
        calls,
        bytesPerCall: encoder.encode(text).length,
        error: String(cause),
      }
    }
  }
  try {
    return {
      fixture: unit,
      documentedTerminalApi: await probe('documentedTerminalApi', drivers[0]!.write),
      coreApi: await probe('coreApi', (data) => terminal.write(data)),
    }
  } finally {
    terminal.free()
  }
}

async function rollingBurst(name: RollingFixtureName, steps: number): Promise<unknown> {
  const prepared = preparedBursts.get(name)
  if (!prepared?.fixture) throw new TypeError('Rolling inputs must be prepared before measurement')
  const { fixture, chunks, reset } = prepared
  let offset = 0
  await Promise.all(drivers.map((driver) => driver.write(reset)))
  await settle()
  const before = drivers.map((driver) => driver.frameMetrics?.())
  const started = performance.now()
  const intervals = await pacedBurst(
    async () => {
      const data = chunks[offset % chunks.length]!
      offset++
      await Promise.all(drivers.map((driver) => driver.write(data)))
    },
    frame,
    steps,
  )
  await settle()
  const milliseconds = performance.now() - started
  const after = drivers.map((driver) => driver.frameMetrics?.())
  return {
    intervals,
    bytes: rollingByteCount(fixture, steps) * drivers.length,
    milliseconds,
    frameMetrics: frameMetricDeltas(before, after),
    fixture: name,
    chunkCount: chunks.length,
    reset: 'corpus-start',
    completedCycles: Math.floor(steps / chunks.length),
    nextChunk: steps % chunks.length,
  }
}

async function burst(name: FixtureName, steps: number): Promise<unknown> {
  if (isRollingFixture(name)) return rollingBurst(name, steps)
  const prepared = preparedBursts.get(name)
  if (!prepared) throw new TypeError('Burst inputs must be prepared before measurement')
  const { chunks, reset, bytes } = prepared
  await Promise.all(drivers.map((driver) => driver.write(reset)))
  await settle()
  const started = performance.now()
  const intervals = await pacedBurst(
    async () => {
      await Promise.all(drivers.map((driver) => driver.write(chunks[0]!)))
    },
    frame,
    steps,
  )
  await settle()
  return {
    intervals,
    bytes: bytes * steps * drivers.length,
    milliseconds: performance.now() - started,
  }
}

async function history(rows: number = settings.scrollback): Promise<unknown> {
  await writeAll('\x1bc\x1b[?25l')
  await settle()
  await writeAll('0123456789012345678901234567890123456789\r\n'.repeat(rows + settings.rows - 1))
  await settle()
  const lengths = drivers.map((driver) => driver.history())
  if (lengths.some((length) => length !== rows))
    throw new Error(`Scrollback fixture length mismatch: ${JSON.stringify(lengths)}`)
  return lengths
}

async function connectEcho(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) return
  socket = new WebSocket(`ws://${location.host}/echo`)
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve()
    socket!.onerror = () => reject(new Error('Local echo fixture failed'))
  })
  socket.binaryType = 'arraybuffer'
  socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    tracing.mark('echo-received')
    if (sustained) {
      void drivers[0]!.write(input(marker(echoColor)))
      return
    }
    const bytes = new Uint8Array(event.data)
    void drivers[0]!.write(current.path === 'bytes' ? bytes : decoder.decode(bytes))
  }
  drivers[0]!.onData((data) => {
    tracing.mark('echo-sent')
    socket!.send(typeof data === 'string' ? encoder.encode(data) : Uint8Array.from(data))
  })
  document.addEventListener(
    'keydown',
    () => {
      keyTime = performance.timeOrigin + performance.now()
      tracing.mark('keydown')
    },
    true,
  )
}

async function prepareInput(color: 'red' | 'green'): Promise<void> {
  echoColor = color
  await drivers[0]!.write(
    input(`\x1b[H\x1b[K\x1b[38;2;${color === 'red' ? '255;0;0' : '0;255;0'}m`),
  )
  await settle()
  drivers[0]!.focus()
}

async function writeMarker(color: 'red' | 'green', delayFrames = 0): Promise<number> {
  const started = performance.timeOrigin + performance.now()
  tracing.mark('write-marker', { color, delayFrames })
  for (let index = 0; index < delayFrames; index++) await frame()
  await drivers[0]!.write(input(marker(color)))
  return started
}

const refresh = refreshSampler(
  (tick) => requestAnimationFrame(tick),
  (id) => cancelAnimationFrame(id),
)

function refreshPeriod(count = 20): Promise<number[]> {
  return refresh.start(count)
}

function legacyMemoryBytes(): number {
  if (!legacy) return 0
  const memory: unknown = Reflect.get(legacy, 'memory')
  if (!(memory instanceof WebAssembly.Memory))
    throw new Error('Pinned ghostty-web WASM memory unavailable')
  return memory.buffer.byteLength
}

let studyChunks: Uint8Array[] = []
let studyFenced = false
async function runStudy(steps: number) {
  const samples: number[] = []
  const completions: number[] = []
  const started = performance.now()
  let bytes = 0
  const intervals = await pacedBurst(
    async () => {
      const chunk = studyChunks[samples.length % studyChunks.length]!
      const at = performance.now()
      await Promise.all(drivers.map((driver) => driver.write(chunk)))
      samples.push(performance.now() - at)
      if (studyFenced) {
        await Promise.all(drivers.map((driver) => driver.complete?.()))
        completions.push(performance.now() - at)
      }
      bytes += chunk.length * drivers.length
    },
    frame,
    steps,
  )
  await settle()
  return {
    milliseconds: performance.now() - started,
    bytes,
    intervals,
    writeMilliseconds: samples,
    completionMilliseconds: completions,
  }
}

function comparisonInfo() {
  return {
    settings,
    adapter: adapterInfo,
    metadata: drivers.map((driver) => driver.metadata?.()),
    dpr: devicePixelRatio,
    font: settings.fontFamily,
    wasmBytes: native?.exports.memory.buffer.byteLength ?? legacyMemoryBytes(),
    canvases: Array.from(mount.querySelectorAll('canvas'), (canvas) => ({
      context: canvas.dataset.studyContext,
      width: canvas.width,
      height: canvas.height,
      bounds: canvas.getBoundingClientRect().toJSON(),
    })),
    texts: drivers.map((driver) => driver.text()),
    frameMetrics: drivers.map((driver) => driver.frameMetrics?.()),
  }
}

async function studyInfo() {
  return { ...comparisonInfo(), texts: await driverTexts() }
}

window.__compare = {
  studyInfo,
  studyPrepare: (chunks: number[][]) => {
    studyChunks = chunks.map((chunk) => new Uint8Array(chunk))
  },
  studyRun: runStudy,
  studyFence: (enabled: boolean) => {
    studyFenced = enabled
  },
  studyWrite: writeAll,
  studyResize: (columns: number, rows: number) => {
    drivers.forEach((driver) => driver.resize?.(columns, rows))
  },
  initialize,
  legacyEmptyWrite,
  legacyOriginalUnicode,
  legacyWriteControl,
  createTerminals,
  correctness,
  parse,
  smokeParse,
  smokeMarker,
  burst,
  history,
  connectEcho,
  prepareInput,
  writeMarker,
  refreshPeriod,
  keyTime: () => keyTime,
  info: comparisonInfo,
  fixtureNames,
  cancelRefresh: refresh.cancel,
  traceBegin: () => tracing.begin(),
  traceEnd: () => tracing.end(),
  startSustainedOutput,
  finishSustainedOutput,
  sustainedChunkBytes: () => {
    const chunk = sustainedChunk(0)
    return typeof chunk === 'string' ? encoder.encode(chunk).byteLength : chunk.byteLength
  },
  dispose: () => {
    socket?.close()
    drivers.forEach((driver) => driver.dispose())
    drivers = []
    preparedBursts.clear()
    native?.dispose()
  },
}

declare global {
  interface Window {
    __compare: {
      studyInfo: typeof studyInfo
      studyRun: typeof runStudy
      studyFence: (enabled: boolean) => void
      studyPrepare: (chunks: number[][]) => void
      studyWrite: typeof writeAll
      studyResize: (columns: number, rows: number) => void
      initialize: typeof initialize
      legacyEmptyWrite: typeof legacyEmptyWrite
      legacyOriginalUnicode: typeof legacyOriginalUnicode
      legacyWriteControl: typeof legacyWriteControl
      createTerminals: typeof createTerminals
      correctness: typeof correctness
      parse: typeof parse
      burst: typeof burst
      smokeParse: typeof smokeParse
      smokeMarker: typeof smokeMarker
      history: typeof history
      connectEcho: typeof connectEcho
      prepareInput: typeof prepareInput
      writeMarker: typeof writeMarker
      refreshPeriod: typeof refreshPeriod
      cancelRefresh: () => number[]
      keyTime: () => number
      info: typeof comparisonInfo
      fixtureNames: typeof fixtureNames
      traceBegin: () => void
      traceEnd: () => unknown
      startSustainedOutput: typeof startSustainedOutput
      finishSustainedOutput: typeof finishSustainedOutput
      sustainedChunkBytes: () => number
      dispose: () => void
    }
  }
}
