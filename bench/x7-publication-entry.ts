import {
  observeDisplayedFrame,
  retainDisplayedFrame,
  type DisplayedFrameOptions,
} from '../src/render/shared/displayed-frame.js'
import type { WebGpuTerminalRendererOptions } from '../src/render/shared/types.js'
import { GhosttyRuntime } from '../src/core/runtime.js'
import { GhosttyRenderState } from '../src/core/render-state.js'
import { TerminalSession } from '../src/term/session.js'
import { createGhosttyWebGpuTerminalFromSession } from '../src/dom/terminal.js'
import { WebGpuTerminalRenderer } from '../src/render/webgpu/renderer.js'
import { WebGlTerminalRenderer } from '../src/render/webgl/renderer.js'
import { DomTerminalRenderer } from '../src/render/dom/renderer.js'
import type { TerminalSubmittedText } from '../src/dom/submitted-frame.js'
import {
  publicationColumns as columns,
  publicationRows as rows,
  publicationOutput,
} from './x7-publication-workload.js'

declare global {
  interface Window {
    __x7?: {
      run(steps: number): Promise<{
        frames: number
        texts: number
        parsedWrites: number
        submitted: number
        presented: null
        observerDigest: string | null
      }>
      trace(): unknown
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
const parity = params.get('parity') === 'on'
const discard = params.get('discard') === 'on'
const trace = params.get('trace') === 'on'
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
  const renderState = session.renderState
  if (!(renderState instanceof GhosttyRenderState))
    throw new Error('Expected a native render state')
  let payloadHash = 2166136261
  const record = (value: unknown) => {
    if (!parity) return
    const text = JSON.stringify(value)
    for (let index = 0; index < text.length; index += 1)
      payloadHash = Math.imul(payloadHash ^ text.charCodeAt(index), 16777619) >>> 0
  }
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    accessibility: observers ? {} : false,
    rendererFactory: async (options) => {
      if (parity) observePayloads(options, record)
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
  while (!terminal.submittedFrame) await nextFrame()
  const registrationFrame = terminal.submittedFrame?.frame ?? 0
  const textEvents: TerminalSubmittedText[] = []
  const writes: { step: number; rows: readonly string[] }[] = []
  let texts = 0
  let chars = 0
  if (observers) {
    terminal.onText((text) => {
      texts += 1
      if (trace) textEvents.push(text)
      record(text)
      for (const row of text.rowPatches) chars += row.text.length
    })
    terminal.onFrame(record)
  }
  return {
    terminal,
    abandon() {
      renderState.update()
      const pending = renderState[retainDisplayedFrame]()
      pending.readTextRows()
      pending.discard()
    },
    trace: () => ({
      registrationFrame,
      acceptedFrame: terminal.submittedFrame?.frame ?? 0,
      events: textEvents,
      writes,
    }),
    recordWrite(step: number) {
      const end = terminal.lineCount()
      writes.push({
        step,
        rows: terminal.readLines(Math.max(0, end - rows), end).map((line) => line.text.trimEnd()),
      })
    },
    texts: () => texts,
    chars: () => chars,
    payloadHash: () => payloadHash,
  }
}

function observePayloads(
  options: WebGpuTerminalRendererOptions,
  record: (value: unknown) => void,
): void {
  const observed: WebGpuTerminalRendererOptions & DisplayedFrameOptions = options
  const original = observed[observeDisplayedFrame]
  observed[observeDisplayedFrame] = (snapshot) => {
    record({
      rows: snapshot.rows,
      previous: snapshot.nativeFrame?.readPreviousTextRows(),
      styled: snapshot.nativeFrame?.readRows(),
    })
    original?.(snapshot)
  }
}

function writeStep(terminals: readonly Created[], step: number): number {
  let parsedWrites = 0
  for (const [index, entry] of terminals.entries()) {
    if (discard) {
      entry.terminal.write(`\x1b[H\x1b[2Kdiscarded ${step}`)
      parsedWrites += 1
      entry.abandon()
    }
    entry.terminal.write(publicationOutput(workload, step, index))
    if (trace) entry.recordWrite(step)
    parsedWrites += 1
  }
  return parsedWrites
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
      let parsedWrites = 0
      const submittedBefore = terminals.reduce(
        (sum, entry) => sum + (entry.terminal.submittedFrame?.frame ?? 0),
        0,
      )
      for (let end = step + steps; step < end; step += 1) {
        parsedWrites += writeStep(terminals, step)
        await nextFrame()
        frames += 1
        if (!observers) continue
        for (const entry of terminals) entry.terminal.visibleLines()
      }
      return {
        frames,
        texts: terminals.reduce((sum, entry) => sum + entry.texts(), 0),
        parsedWrites,
        submitted:
          terminals.reduce((sum, entry) => sum + (entry.terminal.submittedFrame?.frame ?? 0), 0) -
          submittedBefore,
        presented: null,
        observerDigest: parity ? terminals.map((entry) => entry.payloadHash()).join(',') : null,
      }
    },
    trace: () => terminals.map((entry) => entry.trace()),
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
