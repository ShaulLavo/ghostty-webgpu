import { fitTerminalFont } from '../src/dom/fit.js'
import { Terminal } from '../src/dom/terminal.js'
import { Terminal as WorkerTerminal } from '../src/worker/index.js'
import { WebGpuTerminalRenderer } from '../src/render/webgpu/renderer.js'
import { observeGpuSubmissions } from './write-queue-observer.js'
import type { QueueProbeResult, QueueProbeSample } from './write-queue-probe.js'

const parameters = new URL(location.href).searchParams
const realm = parameters.get('realm')
let submitted = 0
const restoreGpu = observeGpuSubmissions(() => {
  submitted += 1
})
const NativeWorker = globalThis.Worker
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options)
    this.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
      if (data && typeof data === 'object' && 'type' in data && data.type === 'queue-probe-submit')
        submitted += 1
    })
  }
}
const family = 'QueueProbeFont'
document.fonts.add(await new FontFace(family, 'url(/font.woff2)').load())
const appearance = {
  cursor: { blink: false },
  font: { family, size: 13 },
  grid: { columns: 200, rows: 50 },
}
const writeQueue = { maxBytes: 8 * 1024 * 1024, timeBudgetMs: 4 }
const terminal =
  realm === 'worker'
    ? await WorkerTerminal.create({
        appearance,
        writeQueue,
        backend: 'webgpu',
        padding: 0,
        scrollbar: false,
        fonts: [{ family, source: { url: new URL('/font.woff2', location.href).href } }],
        workerUrl: new URL('/probe-worker.js', location.href),
        assets: {
          wasm: new URL('/ghostty-vt.wasm', location.href).href,
          bridge: new URL('/bridge.wasm', location.href).href,
        },
      })
    : await Terminal.create({
        appearance,
        writeQueue,
        runtime: { kind: 'owned', options: { wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' } },
        padding: 0,
        scrollbar: false,
        rendererFactory: (options) => WebGpuTerminalRenderer.create(options),
      })
const mount = document.querySelector<HTMLElement>('main')
if (!mount) throw new Error('Missing probe mount')
const fitted = fitTerminalFont(document, terminal.appearance.font, devicePixelRatio)
mount.style.width = `${fitted.cssCellWidth * 200}px`
mount.style.height = `${fitted.cssCellHeight * 50}px`
await terminal.open(mount)
if (terminal.appearance.grid.columns !== 200 || terminal.appearance.grid.rows !== 50)
  throw new Error(`Unexpected fitted grid: ${JSON.stringify(terminal.appearance.grid)}`)
terminal.focus()
await terminal.write('QUEUE_PROBE_READY')
const warmupDeadline = performance.now() + 5000
while (!terminal.visibleLines()[0]?.startsWith('QUEUE_PROBE_READY')) {
  if (performance.now() > warmupDeadline) throw new Error('Warmup frame did not arrive')
  await new Promise((resolve) => setTimeout(resolve, 5))
}

interface RunState {
  sent: number
  parsed: number
  acknowledged: number
  rejected: number
  pendingPeak: number
  start: number
  submissionsAtStart: number
  inputAt: number
  inputAckMs: number[]
  errors: string[]
  producerTimer?: ReturnType<typeof setTimeout>
}
let state: RunState | undefined
terminal.on('error', ({ cause }) => {
  state?.errors.push(String(cause))
})
document.addEventListener(
  'keydown',
  (event) => {
    if (state && event.key === 'z') state.inputAt = performance.now()
  },
  { capture: true },
)
const decoder = new TextDecoder()
terminal.onData(({ bytes }) => {
  if (!state) return
  const data = decoder.decode(bytes)
  if (data === '\x1b[0n') {
    state.parsed += 1
    return
  }
  if (data !== 'z') return
  const current = state
  const at = current.inputAt
  void Promise.resolve(terminal.write('z')).then(
    () => {
      current.inputAckMs.push(performance.now() - at)
    },
    (cause: unknown) => {
      current.errors.push(`Input echo failed: ${String(cause)}`)
    },
  )
})

function sample(
  current: RunState,
  pendingBeforeBytes = terminal.pendingWriteBytes,
): QueueProbeSample {
  return {
    elapsedMs: performance.now() - current.start,
    sent: current.sent,
    parsed: current.parsed,
    acknowledged: current.acknowledged,
    rejected: current.rejected,
    pendingBytes: terminal.pendingWriteBytes,
    pendingBeforeBytes,
    submitted: submitted - current.submissionsAtStart,
  }
}

function offer(current: RunState, payload: string): void {
  current.sent += 1
  const pending = terminal.writeBatched(payload)
  current.pendingPeak = Math.max(current.pendingPeak, terminal.pendingWriteBytes)
  void pending.then(
    () => {
      current.acknowledged += 1
    },
    (cause: unknown) => {
      if (cause instanceof Error && cause.message.includes('byte limit exceeded')) {
        current.rejected += 1
        return
      }
      current.errors.push(String(cause))
      current.rejected += 1
    },
  )
}

async function waitForDrain(current: RunState): Promise<void> {
  const deadline = performance.now() + 15_000
  while (terminal.pendingWriteBytes > 0 || current.acknowledged + current.rejected < current.sent) {
    if (performance.now() > deadline) throw new Error('Queue drain exceeded 15 seconds')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Producer {
  readonly current: RunState
  readonly payload: string
  readonly samples: QueueProbeSample[]
  readonly chunkBytes: number
  readonly byteLimit: number
  readonly durationMs: number
  readonly intervalMs: number
  readonly writesPerTick: number
  readonly stop: (elapsedMs: number) => void
}

function tickProducer(producer: Producer): void {
  const {
    current,
    payload,
    samples,
    chunkBytes,
    byteLimit,
    durationMs,
    intervalMs,
    writesPerTick,
  } = producer
  if (performance.now() - current.start >= durationMs || current.sent * chunkBytes >= byteLimit) {
    producer.stop(performance.now() - current.start)
    return
  }
  const pendingBeforeBytes = terminal.pendingWriteBytes
  const count = Math.min(writesPerTick, byteLimit / chunkBytes - current.sent)
  for (let index = 0; index < count; index += 1) offer(current, payload)
  samples.push(sample(current, pendingBeforeBytes))
  current.producerTimer = setTimeout(() => tickProducer(producer), intervalMs)
}

export async function run(intervalMs: number, writesPerTick: number): Promise<QueueProbeResult> {
  const chunkBytes = 64 * 1024
  const byteLimit = 64 * 1024 * 1024
  const durationMs = 750
  const payload = 'x'.repeat(chunkBytes - 6) + '\r\n\x1b[5n'
  const current: RunState = {
    sent: 0,
    parsed: 0,
    acknowledged: 0,
    rejected: 0,
    pendingPeak: 0,
    start: performance.now(),
    submissionsAtStart: submitted,
    inputAt: 0,
    inputAckMs: [],
    errors: [],
  }
  state = current
  const samples: QueueProbeSample[] = []
  const heartbeatDelayMs: number[] = []
  let expected = performance.now() + 16
  const heartbeat = setInterval(() => {
    heartbeatDelayMs.push(Math.max(0, performance.now() - expected))
    expected = performance.now() + 16
  }, 16)
  try {
    const stopMs = await new Promise<number>((stop) =>
      tickProducer({
        current,
        payload,
        samples,
        chunkBytes,
        byteLimit,
        durationMs,
        intervalMs,
        writesPerTick,
        stop,
      }),
    )
    await waitForDrain(current)
    const drainedAt = performance.now()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const final = sample(current)
    await terminal.write('\x1b[HQUEUE_PROBE_DONE')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const count = await terminal.lineCount()
    const start = Math.max(0, count - terminal.appearance.grid.rows)
    const text = (await terminal.readLines(start, start + 1))[0]?.text
    if (!text?.startsWith('QUEUE_PROBE_DONE')) current.errors.push('Final content missing')
    return {
      chunkBytes,
      maxBytes: writeQueue.maxBytes,
      byteLimit,
      durationMs,
      intervalMs,
      writesPerTick,
      samples,
      pendingPeak: current.pendingPeak,
      final,
      stopMs,
      drainMs: drainedAt - current.start - stopMs,
      inputAckMs: current.inputAckMs,
      heartbeatDelayMs,
      errors: current.errors,
    }
  } finally {
    if (current.producerTimer !== undefined) clearTimeout(current.producerTimer)
    clearInterval(heartbeat)
    state = undefined
  }
}

export function running(): boolean {
  return state !== undefined
}
export async function dispose(): Promise<void> {
  await terminal.dispose()
  restoreGpu()
  globalThis.Worker = NativeWorker
}

declare global {
  interface Window {
    __queueProbe: { run: typeof run; running: typeof running; dispose: typeof dispose }
  }
}
window.__queueProbe = { run, running, dispose }
