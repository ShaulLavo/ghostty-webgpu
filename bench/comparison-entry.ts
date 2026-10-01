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
import { WebGpuTerminalRenderer } from '../src/render/renderer.js'
import {
  corpus,
  fixtureNames,
  fixtureText,
  marker,
  settings,
  spotCheck,
  type ComparisonCase,
  type FixtureName,
} from './comparison-fixtures.js'

interface Driver {
  write(data: string | Uint8Array): Promise<void>
  text(): readonly string[]
  history(): number
  focus(): void
  onData(listener: (data: string | Uint8Array) => void): void
  dispose(): void
}

const mount = document.querySelector('main')!
let drivers: Driver[] = []
let native: GhosttyRuntime | undefined
let legacy: Ghostty | undefined
let current: ComparisonCase
let logs = ''
let keyTime = 0
let socket: WebSocket | undefined
let adapterInfo: unknown
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const nativeFrame = requestAnimationFrame.bind(window)

export function frame(): Promise<number> {
  return new Promise((resolve) => nativeFrame(resolve))
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
  native ??= await GhosttyRuntime.create({ wasm: '/native.wasm', bridge: '/bridge.wasm' })
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
  session.setTheme({
    ...session.appearance.theme,
    background: { r: 0, g: 0, b: 0 },
    foreground: { r: 255, g: 255, b: 255 },
  })
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    accessibility: false,
    rendererFactory: async (options) => {
      const adapter = await navigator.gpu?.requestAdapter()
      if (!adapter) throw new Error('Hardware WebGPU adapter required')
      adapterInfo = {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
        fallback: adapter.info.isFallbackAdapter,
      }
      const device = await adapter.requestDevice()
      return WebGpuTerminalRenderer.create({ ...options, deviceFactory: async () => device })
    },
  })
  terminal.on('error', (event) => {
    throw event.cause
  })
  await terminal.open(host)
  return {
    write: async (data) => {
      terminal.write(data)
    },
    text: () => terminal.visibleLines(),
    history: () => terminal.lineCount() - settings.rows,
    focus: () => terminal.focus(),
    onData: (listener) => {
      terminal.onData(listener)
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
  return {
    write: synchronousWrite((data) => terminal.write(data)),
    text: () =>
      Array.from(
        { length: settings.rows },
        (_, y) =>
          terminal.buffer.active
            .getLine(y + terminal.getScrollbackLength())
            ?.translateToString(true) ?? '',
      ),
    history: () => terminal.getScrollbackLength(),
    focus: () => terminal.focus(),
    onData: (listener) => {
      terminal.onData(listener)
    },
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
    theme: { foreground: '#ffffff', background: '#000000' },
  })
  terminal.open(host)
  if (current.variant === 'xterm-webgl') {
    terminal.loadAddon(new WebglAddon())
  }
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
    dispose: () => terminal.dispose(),
  }
}

async function prepare(testCase: ComparisonCase): Promise<void> {
  await initialize(testCase)
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
    if (current.variant === 'ghostty-webgpu') driver = await createNative(host)
    else if (current.variant === 'ghostty-web') driver = await createLegacy(host)
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

async function correctness(): Promise<unknown> {
  await writeAll(spotCheck)
  await settle()
  const output = drivers.map((driver) => driver.text())
  for (const lines of output) {
    if (!lines[0]?.includes('ASCII abc 123') || !lines[1]?.includes('red green'))
      throw new Error('ASCII / SGR spot check failed')
    if (!lines[2]?.includes('日本語') || !lines[6]?.includes('overwrite new'))
      throw new Error('Wide text / cursor spot check failed')
  }
  return output
}

async function initialize(testCase: ComparisonCase): Promise<void> {
  current = testCase
  logs = await (await fetch('/logs.txt')).text()
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
    name,
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
      throw new Error(`${name} parser snapshot failed: ${String(cause)}`, { cause })
    }
    const validation = qualifyScreen(screen, expected)
    return { bytes: bytes.length, milliseconds, chunkCount: chunks.length, validation }
  } finally {
    driver.dispose()
  }
}

async function parser(): Promise<ParserDriver> {
  if (current.variant.startsWith('xterm-')) {
    const terminal = new Xterm({ cols: settings.columns, rows: settings.rows, scrollback: 0 })
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
  const runtime = await GhosttyRuntime.create({ wasm: '/native.wasm', bridge: '/bridge.wasm' })
  const terminal = runtime.createTerminal({ columns: settings.columns, rows: settings.rows })
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
      return { accepted: true, calls, bytesPerCall: encoder.encode(text).length }
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

async function burst(name: FixtureName, steps: number): Promise<unknown> {
  const text = corpus(fixtureText(name, logs), settings.chunkBytes)
  await writeAll('\x1b[3J\x1b[2J\x1b[H')
  await settle()
  const started = performance.now()
  const intervals = await pacedBurst(() => writeAll(text), frame, steps)
  await settle()
  return {
    intervals,
    bytes: encoder.encode(text).length * steps * drivers.length,
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
  socket = new WebSocket(`ws://${location.host}/echo`)
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve()
    socket!.onerror = () => reject(new Error('Local echo fixture failed'))
  })
  socket.binaryType = 'arraybuffer'
  socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    const bytes = new Uint8Array(event.data)
    void drivers[0]!.write(current.path === 'bytes' ? bytes : decoder.decode(bytes))
  }
  drivers[0]!.onData((data) =>
    socket!.send(typeof data === 'string' ? encoder.encode(data) : Uint8Array.from(data)),
  )
  document.addEventListener(
    'keydown',
    () => {
      keyTime = performance.timeOrigin + performance.now()
    },
    true,
  )
}

async function prepareInput(color: 'red' | 'green'): Promise<void> {
  await drivers[0]!.write(
    input(`\x1b[H\x1b[K\x1b[38;2;${color === 'red' ? '255;0;0' : '0;255;0'}m`),
  )
  await settle()
  drivers[0]!.focus()
}

async function writeMarker(color: 'red' | 'green'): Promise<number> {
  const started = performance.timeOrigin + performance.now()
  await drivers[0]!.write(input(marker(color)))
  return started
}

async function refreshPeriod(): Promise<number[]> {
  const samples: number[] = []
  let previous = await frame()
  for (let index = 0; index < 20; index++) {
    const time = await frame()
    samples.push(time - previous)
    previous = time
  }
  return samples
}

function legacyMemoryBytes(): number {
  if (!legacy) return 0
  const memory: unknown = Reflect.get(legacy, 'memory')
  if (!(memory instanceof WebAssembly.Memory))
    throw new Error('Pinned ghostty-web WASM memory unavailable')
  return memory.buffer.byteLength
}

window.__compare = {
  initialize,
  legacyEmptyWrite,
  legacyOriginalUnicode,
  prepare,
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
  info: () => ({
    adapter: adapterInfo,
    dpr: devicePixelRatio,
    font: settings.fontFamily,
    wasmBytes: native?.exports.memory.buffer.byteLength ?? legacyMemoryBytes(),
    canvases: Array.from(mount.querySelectorAll('canvas'), (canvas) => ({
      width: canvas.width,
      height: canvas.height,
    })),
    texts: drivers.map((driver) => driver.text()),
  }),
  fixtureNames,
  dispose: () => {
    socket?.close()
    drivers.forEach((driver) => driver.dispose())
    drivers = []
    native?.dispose()
  },
}

declare global {
  interface Window {
    __compare: {
      initialize: typeof initialize
      legacyEmptyWrite: typeof legacyEmptyWrite
      legacyOriginalUnicode: typeof legacyOriginalUnicode
      prepare: typeof prepare
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
      keyTime: () => number
      info: () => unknown
      fixtureNames: typeof fixtureNames
      dispose: () => void
    }
  }
}
