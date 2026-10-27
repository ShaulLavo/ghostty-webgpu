import { GhosttyRuntime } from '../src/core/runtime.js'
import { TerminalSession } from '../src/term/session.js'
import { createGhosttyWebGpuTerminalFromSession } from '../src/dom/terminal.js'
import { WebGpuTerminalRenderer } from '../src/render/webgpu/renderer.js'
import { WebGlTerminalRenderer } from '../src/render/webgl/renderer.js'
import { DomTerminalRenderer } from '../src/render/dom/renderer.js'

declare global {
  interface Window {
    __x7?: {
      run(steps: number): Promise<{ frames: number; texts: number }>
      digest(): Promise<string>
      info(): { wasmBytes: number; adapter?: unknown }
    }
    __x7Failure?: string
  }
}

const params = new URLSearchParams(location.search)
const backend = params.get('backend') ?? 'webgl2'
const count = Number(params.get('count') ?? 1)
const workload = params.get('workload') ?? 'dense'
const observers = params.get('observers') === 'on'
const columns = 200
const rows = 50
const words = 'alpha beta gamma delta 界 é epsilon zeta eta theta iota kappa lambda mu '

function line(seed: number): string {
  let text = ''
  while (text.length < columns - 12) text += words.slice(seed % 13) + seed + ' '
  return text.slice(0, columns - 12)
}

function output(step: number, index: number): string {
  if (workload === 'scroll') return `\r\n${line(step * 31 + index)}`
  let out = ''
  for (let y = 0; y < rows; y += 1) out += `\x1b[${y + 1};1H\x1b[2K${line(step * 7 + y + index)}`
  return out
}

type Created = Awaited<ReturnType<typeof create>>
let adapter: unknown

async function create(runtime: GhosttyRuntime, host: HTMLElement) {
  const session = await TerminalSession.create<Event>({
    runtime: { kind: 'borrowed', runtime },
    appearance: {
      grid: { columns, rows },
      scrollbackLimit: 1000,
      font: { family: 'monospace', size: 6, lineHeight: 1 },
      cursor: { blink: false },
    },
  })
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    accessibility: observers ? {} : false,
    rendererFactory: async (options) => {
      if (backend === 'webgl2') return WebGlTerminalRenderer.create(options)
      if (backend === 'dom') return DomTerminalRenderer.create(options)
      const renderer = await WebGpuTerminalRenderer.create(options)
      const device = Reflect.get(renderer, 'device') as GPUDevice
      adapter = {
        description: device.adapterInfo.description,
        fallback: device.adapterInfo.isFallbackAdapter,
      }
      return renderer
    },
  })
  terminal.on('error', (event) => {
    window.__x7Failure = String(event.cause)
  })
  await terminal.open(host)
  let texts = 0
  let chars = 0
  if (observers) {
    terminal.onText((text) => {
      texts += 1
      for (const row of text.rowPatches) chars += row.text.length
    })
    terminal.onFrame(() => {})
  }
  return {
    terminal,
    texts: () => texts,
    chars: () => chars,
  }
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))

async function main(): Promise<void> {
  const runtime = await GhosttyRuntime.create()
  const main = document.querySelector('main')!
  main.style.display = 'grid'
  main.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(count))}, 1fr)`
  const terminals: Created[] = []
  for (let index = 0; index < count; index += 1) {
    const host = document.createElement('div')
    host.style.overflow = 'hidden'
    main.append(host)
    terminals.push(await create(runtime, host))
  }
  let step = 0
  window.__x7 = {
    async run(steps) {
      let frames = 0
      for (let end = step + steps; step < end; step += 1) {
        terminals.forEach((entry, index) => entry.terminal.write(output(step, index)))
        await nextFrame()
        frames += 1
        if (!observers) continue
        for (const entry of terminals) entry.terminal.visibleLines()
      }
      return {
        frames,
        texts: terminals.reduce((sum, entry) => sum + entry.texts(), 0),
      }
    },
    async digest() {
      await nextFrame()
      await nextFrame()
      const text = terminals.map((entry) => entry.terminal.visibleLines().join('\n')).join('\f')
      const bytes = new TextEncoder().encode(text)
      const hash = await crypto.subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    info: () => ({
      wasmBytes: runtime.exports.memory.buffer.byteLength,
      adapter,
    }),
  }
}

main().catch((cause) => {
  window.__x7Failure = cause instanceof Error ? `${cause.message}\n${cause.stack}` : String(cause)
})
