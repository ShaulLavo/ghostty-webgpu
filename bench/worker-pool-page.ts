import { createControl } from './worker-pool-control.js'
import type { WorkerPoolMessage, WorkerPoolMode } from './worker-pool-protocol.js'
import type { RendererTextFrameSnapshot } from '../src/render/shared/types.js'

interface Report {
  frames: number
  bytes: number
  sequence: number
  writeSequence: number
  rows: string[]
  sequences: number[]
}
interface Driver {
  write(data: string): Promise<void>
  dispose(): Promise<void>
}
const root = document.querySelector('main')!
const decoder = new TextDecoder()
let drivers: Driver[] = []
let reports: Report[] = []
let acknowledgements: number[] = []
let frameStarts: number[] = []
let writeCounts: number[] = []
let columns = 0
let rows = 0
let errors: string[] = []
let handlerMilliseconds = 0
let worker: Worker | undefined
let sequence = 0
const pending = new Map<string, { resolve(): void; reject(cause: unknown): void }>()

function reportError(error: unknown): void {
  errors.push(error instanceof Error ? error.message : String(error))
}

function consumeSnapshot(index: number, snapshot: RendererTextFrameSnapshot): void {
  const report = reports[index]!
  report.frames += 1
  for (const row of snapshot.rows) report.rows[row.y] = row.text
}

function consumeDelta(message: Extract<WorkerPoolMessage, { type: 'delta' }>): void {
  const report = reports[message.terminal]!
  if (report.sequence + 1 !== message.sequence)
    errors.push(`frame gap ${message.terminal}:${message.sequence}`)
  report.sequence = message.sequence
  report.frames += 1
  report.bytes += message.buffer.byteLength
  const view = new DataView(message.buffer)
  const count = view.getUint16(4)
  const payload = new Uint8Array(message.buffer, 8 + count * 12)
  for (let index = 0; index < count; index += 1) {
    const header = 8 + index * 12
    const y = view.getUint16(header)
    const offset = view.getUint32(header + 4)
    const length = view.getUint32(header + 8)
    report.rows[y] = decoder.decode(payload.subarray(offset, offset + length))
  }
}

function receive(message: WorkerPoolMessage): void {
  if (message.type === 'delta') return consumeDelta(message)
  if (message.type === 'ack') {
    const key = `${message.terminal}:${message.sequence}`
    pending.get(key)?.resolve()
    pending.delete(key)
    return
  }
  if (message.type === 'failure') reportError(message.message)
}

async function createPool(canvases: HTMLCanvasElement[]): Promise<void> {
  const pool = new Worker('/worker.js', { type: 'module' })
  worker = pool
  const ready = Promise.withResolvers<void>()
  pool.onerror = (event) => {
    reportError(event.message)
    ready.reject(new Error(event.message))
  }
  pool.onmessage = ({ data }: MessageEvent<WorkerPoolMessage>) => {
    const started = performance.now()
    if (data.type === 'ready') ready.resolve()
    receive(data)
    handlerMilliseconds += performance.now() - started
  }
  const offscreen = canvases.map((canvas) => canvas.transferControlToOffscreen())
  pool.postMessage(
    {
      type: 'initialize',
      mode: 'pool',
      terminalCount: canvases.length,
      columns,
      rows,
      pixelRatio: devicePixelRatio,
      wasm: '/ghostty-vt.wasm',
      bridge: '/bridge.wasm',
      fontUrl: '/fonts/JetBrainsMono-Regular.woff2',
      fontFamily: 'JetBrains Mono',
      canvases: offscreen,
    },
    offscreen,
  )
  await ready.promise
  drivers = canvases.map((_, index) => ({
    write: (data) => {
      const current = ++reports[index]!.writeSequence
      const ack = Promise.withResolvers<void>()
      pending.set(`${index}:${current}`, ack)
      pool.postMessage({ type: 'write', terminal: index, sequence: current, data })
      return ack.promise
    },
    dispose: async () => {},
  }))
}

async function setup(
  mode: WorkerPoolMode,
  count: number,
  width: number,
  height: number,
): Promise<void> {
  root.replaceChildren()
  columns = width
  rows = height
  reports = Array.from({ length: count }, () => ({
    frames: 0,
    bytes: 0,
    sequence: 0,
    writeSequence: 0,
    rows: Array.from({ length: rows }, () => ''),
    sequences: [],
  }))
  errors = []
  drivers = []
  sequence = 0
  if (mode === 'pool') {
    const canvases = Array.from({ length: count }, () => document.createElement('canvas'))
    root.append(...canvases)
    await createPool(canvases)
  } else {
    for (let index = 0; index < count; index += 1) await addControl(index)
  }
  await waitFrames(Array.from({ length: count }, () => 1))
  frameStarts = reports.map((report) => report.frames)
  writeCounts = Array.from({ length: count }, () => 0)
  handlerMilliseconds = 0
  window.__workerReceiveMilliseconds = 0
  acknowledgements = []
}

async function addControl(index: number): Promise<void> {
  const control = await createControl(columns, rows, (snapshot) => consumeSnapshot(index, snapshot))
  control.execution.on('error', (error) => reportError(error.cause))
  drivers.push({
    write: async (data) => {
      await control.execution.write(data)
    },
    dispose: async () => {
      await control.execution.dispose()
      control.elements.dispose()
    },
  })
}

async function waitFrames(targets: number[]): Promise<void> {
  const deadline = performance.now() + 10_000
  while (reports.some((report, index) => report.frames < targets[index]!)) {
    if (errors.length > 0) throw new Error(errors.join('\n'))
    if (performance.now() > deadline)
      throw new Error(
        `frame timeout ${JSON.stringify(reports.map((report) => report.frames))}, targets ${JSON.stringify(targets)}`,
      )
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function payload(step: number, terminal: number): string {
  const y = (step % rows) + 1
  const text = `${String(step).padStart(6, '0')} T${terminal} A界e\u0301𝑓🧪 ${'output '.repeat(30)}`
  return `\x1b[${y};1H\x1b[2K${text.slice(0, columns - 12)}\x1b[?25l`
}

async function update(index: number, step: number): Promise<void> {
  const started = performance.now()
  await drivers[index]!.write(payload(step, index))
  if (index === 0) acknowledgements.push(performance.now() - started)
  writeCounts[index]! += 1
}

async function sample(steps: number): Promise<void> {
  for (let step = 0; step < steps; step += 1) {
    const targets = reports.map((report) => report.frames)
    const indices = Array.from({ length: drivers.length }, (_, index) => index).filter(
      (index) => index === 0 || step % 4 === 0,
    )
    for (const index of indices) targets[index]! += 1
    await Promise.all(indices.map((index) => update(index, sequence)))
    sequence += 1
    await waitFrames(targets)
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
}

function report() {
  return {
    hostHandlerMilliseconds: handlerMilliseconds + window.__workerReceiveMilliseconds,
    acknowledgements,
    deliveredFrames: reports.map((value, index) => value.frames - frameStarts[index]!),
    writeCounts,
    rows: reports.map((value) => value.rows),
    bytes: reports.reduce((sum, value) => sum + value.bytes, 0),
    errors,
  }
}

async function dispose(): Promise<void> {
  await Promise.all(drivers.map((driver) => driver.dispose()))
  worker?.postMessage({ type: 'dispose' })
  worker?.terminate()
  worker = undefined
  drivers = []
  root.replaceChildren()
}

declare global {
  interface Window {
    __workerReceiveMilliseconds: number
    __workerPoolBench: {
      setup: typeof setup
      sample: typeof sample
      report: typeof report
      dispose: typeof dispose
    }
  }
}
window.__workerReceiveMilliseconds = 0
window.__workerPoolBench = { setup, sample, report, dispose }
