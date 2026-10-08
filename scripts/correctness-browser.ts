import { Terminal as Xterm } from '@xterm/xterm'
import { Ghostty, Terminal as Legacy } from 'ghostty-web'
import { GhosttyRuntime } from '../src/core/runtime.js'

export type Variant = 'ghostty-webgpu' | 'xterm.js' | 'ghostty-web'
export interface Size {
  columns: number
  rows: number
}
export interface Screen {
  cells: string[][]
  cursor: { x: number; y: number }
  replies: string
}
interface Driver {
  write(data: Uint8Array): Promise<void>
  screen(): Screen
  dispose(): void
}
export type Request =
  | { op: 'reset'; variant: Variant; suite?: string; size?: Size }
  | { op: 'write'; bytes: number[] }
  | { op: 'screen' }
  | { op: 'settle' }

let driver: Driver | undefined
let faults: string[] = []
window.addEventListener('error', (event) => faults.push(event.message))
window.addEventListener('unhandledrejection', (event) => faults.push(String(event.reason)))
let native: GhosttyRuntime | undefined
let legacy: Ghostty | undefined
const host = document.querySelector<HTMLElement>('#terminal')!

async function createNative(size: Size): Promise<Driver> {
  native ??= await GhosttyRuntime.create({ wasm: '/native.wasm', bridge: '/bridge.wasm' })
  let replies = ''
  const terminal = native.createTerminal({
    ...size,
    effects: {
      writePty: (bytes) => {
        replies += new TextDecoder().decode(bytes)
      },
    },
  })
  const render = native.createRenderState(terminal)
  return {
    write: async (data) => {
      terminal.write(data)
    },
    screen: () => ({
      cells: render
        .snapshot()
        .rows.map((row) => row.cells.map((cell) => (cell.continuation ? '' : cell.text || ' '))),
      cursor: { x: terminal.cursor.x, y: terminal.cursor.y },
      replies,
    }),
    dispose: () => {
      render.dispose()
      terminal.dispose()
    },
  }
}

function createXterm(size: Size): Driver {
  let replies = ''
  const terminal = new Xterm({ cols: size.columns, rows: size.rows, allowProposedApi: true })
  terminal.open(host)
  terminal.onData((data) => {
    replies += data
  })
  return {
    write: (data) => new Promise((resolve) => terminal.write(data, resolve)),
    screen: () => {
      const buffer = terminal.buffer.active
      return {
        cells: Array.from({ length: size.rows }, (_, y) =>
          Array.from({ length: size.columns }, (_, x) => {
            const cell = buffer.getLine(buffer.baseY + y)!.getCell(x)!
            return cell.getWidth() === 0 ? '' : cell.getChars() || ' '
          }),
        ),
        cursor: { x: buffer.cursorX, y: buffer.cursorY },
        replies,
      }
    },
    dispose: () => terminal.dispose(),
  }
}

async function createLegacy(size: Size): Promise<Driver> {
  legacy ??= await Ghostty.load('/legacy.wasm')
  let replies = ''
  const terminal = new Legacy({ ghostty: legacy, cols: size.columns, rows: size.rows })
  terminal.open(host)
  terminal.onData((data) => {
    replies += data
  })
  return {
    write: (data) => new Promise((resolve) => terminal.write(data, resolve)),
    screen: () => {
      const core = terminal.wasmTerm!
      const cells = Array.from({ length: size.rows }, (_, y) =>
        (core.getLine(y) ?? []).map((cell, x) => {
          if (cell.width === 0) return ''
          if (cell.grapheme_len > 0) return core.getGraphemeString(y, x)
          return String.fromCodePoint(cell.codepoint || 32)
        }),
      )
      const cursor = core.getCursor()
      return { cells, cursor: { x: cursor.x, y: cursor.y }, replies }
    },
    dispose: () => terminal.dispose(),
  }
}

const factories: Record<Variant, (size: Size) => Driver | Promise<Driver>> = {
  'ghostty-webgpu': createNative,
  'xterm.js': createXterm,
  'ghostty-web': createLegacy,
}

async function request(request: Request): Promise<Screen | null> {
  if (request.op === 'reset') {
    driver?.dispose()
    driver = undefined
    host.replaceChildren()
    faults = []
    driver = await factories[request.variant](request.size ?? { columns: 80, rows: 24 })
    return null
  }
  if (!driver) throw new TypeError('Terminal has not been created')
  if (request.op === 'write') await driver.write(Uint8Array.from(request.bytes))
  if (request.op === 'settle')
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  if (faults.length > 0) throw new TypeError(faults.join('\n'))
  return request.op === 'screen' ? driver.screen() : null
}

Object.assign(window, { correctness: request })
