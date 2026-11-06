import { createTerminalElements } from '../src/dom/elements.js'
import { WorkerTerminalExecution } from '../src/worker/execution.js'
type WorkerRevisionMode = 'control' | 'candidate'
import type { RendererTextFrameSnapshot } from '../src/render/shared/types.js'

interface Report {
  frames: number
  sequence: number
  writeSequence: number
  rows: string[]
  inputs: string[]
}
interface Driver {
  write(data: string): Promise<void>
  dispose(): Promise<void>
}
const root = document.querySelector('main')!
let drivers: Driver[] = []
let eventReports: unknown[][] = []
let executions: Awaited<ReturnType<typeof createControl>>['execution'][] = []
let reports: Report[] = []
let acknowledgements: number[] = []
let frameStarts: number[] = []
let writeCounts: number[] = []
let columns = 0
let rows = 0
let errors: string[] = []
let handlerMilliseconds = 0
let sequence = 0
let fixtureChunks: string[] = []
let frameSequences: Promise<string>[][] = []
const parity = new URL(location.href).searchParams.get('parity') === '1'

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function createControl(
  mode: WorkerRevisionMode,
  columns: number,
  rows: number,
  ordinal: number,
  onFrame: (snapshot: RendererTextFrameSnapshot) => void,
) {
  const execution = await WorkerTerminalExecution.create({
    assets: { wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' },
    backend: 'webgl',
    faces: [{ family: 'JetBrains Mono', source: { url: '/fonts/JetBrainsMono-Regular.woff2' } }],
    appearance: {
      grid: { columns, rows },
      font: { family: 'JetBrains Mono', size: 13 },
      cursor: { blink: false },
    },
    workerUrl: `/worker.js?ordinal=${ordinal}`,
  })
  executions[ordinal] = execution
  const events: unknown[] = []
  for (const name of [
    'appearance',
    'bell',
    'data',
    'error',
    'resize',
    'scroll',
    'selection',
    'title',
  ] as const)
    execution.on(name, (value) => events.push({ name, value }))
  const container = document.createElement('div')
  root.append(container)
  const elements = createTerminalElements(container)
  execution.setFrameListener(onFrame)
  const font = await execution.open(elements, {
    identity: 1,
    width: 2000,
    height: 1500,
    pixelRatio: devicePixelRatio,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    scrollbarWidth: 0,
    autoFit: false,
  })
  elements.canvas.style.width = `${columns * font.cssCellWidth}px`
  elements.canvas.style.height = `${rows * font.cssCellHeight}px`
  return { execution, elements, events }
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const detail = error && typeof error === 'object' ? JSON.stringify(error) : ''
  errors.push(`${message} ${detail}`)
}

function consumeSnapshot(index: number, snapshot: RendererTextFrameSnapshot): void {
  const report = reports[index]!
  report.frames += 1
  if (parity) {
    const execution = executions[index]
    if (execution)
      frameSequences[index]!.push(
        digest({
          projection: snapshot,
          summary: execution.submittedFrame,
          state: Reflect.get(execution, 'state'),
          output: execution.submittedOutput,
          control: execution.submittedControl,
        }),
      )
  }
  for (const row of snapshot.rows) report.rows[row.y] = row.text
}

async function setup(
  mode: WorkerRevisionMode,
  count: number,
  width: number,
  height: number,
): Promise<void> {
  root.replaceChildren()
  const fixture = new URL(location.href).searchParams.get('fixture')
  fixtureChunks =
    fixture && fixture !== 'mixed-edit'
      ? await fetch(`/fixtures/${fixture}.json`).then((response) => response.json())
      : []
  columns = width
  rows = height
  frameSequences = Array.from({ length: count }, () => [])
  reports = Array.from({ length: count }, () => ({
    frames: 0,
    sequence: 0,
    writeSequence: 0,
    rows: Array.from({ length: rows }, () => ''),
    inputs: [],
  }))
  errors = []
  drivers = []
  executions = []
  eventReports = []
  window.__revisionTimings = []
  window.__revisionBytes = 0
  sequence = 0
  for (let index = 0; index < count; index += 1) await addControl(mode, index)
  await waitFrames(Array.from({ length: count }, () => 1))
  frameStarts = reports.map((report) => report.frames)
  writeCounts = Array.from({ length: count }, () => 0)
  handlerMilliseconds = 0
  window.__workerReceiveMilliseconds = 0
  acknowledgements = []
}

async function addControl(mode: WorkerRevisionMode, index: number): Promise<void> {
  const control = await createControl(mode, columns, rows, index, (snapshot) =>
    consumeSnapshot(index, snapshot),
  )
  executions[index] = control.execution
  eventReports.push(control.events)
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
  if (fixtureChunks.length > 0) return fixtureChunks[step % fixtureChunks.length]!
  const y = (step % rows) + 1
  const text = `${String(step).padStart(6, '0')} T${terminal} A界e\u0301𝑓🧪 ${'output '.repeat(30)}`
  return `\x1b[${y};1H\x1b[2K${text.slice(0, columns - 12)}\x1b[?25l`
}

async function update(index: number, step: number): Promise<void> {
  const started = performance.now()
  const input = payload(step, index)
  reports[index]!.inputs.push(input)
  await drivers[index]!.write(input)
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

async function report() {
  return {
    timings: window.__revisionTimings,
    frameSequences: parity
      ? await Promise.all(frameSequences.map((frames) => Promise.all(frames)))
      : null,
    events: eventReports,
    inputs: reports.map((report) => report.inputs),
    hostHandlerMilliseconds: handlerMilliseconds + window.__workerReceiveMilliseconds,
    acknowledgements,
    deliveredFrames: reports.map((value, index) => value.frames - frameStarts[index]!),
    writeCounts,
    rows: reports.map((value) => value.rows),
    bytes: window.__revisionBytes,
    errors,
  }
}

function snapshotReport() {
  return executions.map((execution) => ({
    summary: execution.submittedFrame,
    snapshot: execution.textFrame(),
  }))
}

async function contractProbe() {
  if (!parity) throw new Error('contractProbe is correctness-only')
  const result: unknown[] = []
  const execution = executions[0]!
  await execution.write('\x1b[?2026hheld revision output')
  result.push({
    phase: 'held-before-snapshot',
    snapshot: await execution.frameSnapshot(),
    summary: execution.submittedFrame,
    projection: execution.textFrame(),
  })
  const target = reports[0]!.frames + 1
  await execution.write('\x1b[?2026l')
  await waitFrames(reports.map((report, index) => (index === 0 ? target : report.frames)))
  result.push({
    phase: 'released',
    snapshot: await execution.frameSnapshot(),
    summary: execution.submittedFrame,
    projection: execution.textFrame(),
  })
  await execution.write('\x1b[?2026hsecond held output')
  result.push({
    phase: 'held-after-snapshot',
    snapshot: await execution.frameSnapshot(),
    summary: execution.submittedFrame,
    projection: execution.textFrame(),
  })
  const next = reports[0]!.frames + 1
  await execution.write('\x1b[?2026l')
  await waitFrames(reports.map((report, index) => (index === 0 ? next : report.frames)))
  result.push({
    phase: 'released-again',
    snapshot: await execution.frameSnapshot(),
    summary: execution.submittedFrame,
    projection: execution.textFrame(),
  })
  return result
}

async function dispose(): Promise<void> {
  await Promise.all(drivers.map((driver) => driver.dispose()))
  drivers = []
  root.replaceChildren()
}

declare global {
  interface Window {
    __revisionTimings: Record<string, unknown>[]
    __revisionBytes: number
    __workerReceiveMilliseconds: number
    __workerRevisionBench: {
      setup: typeof setup
      sample: typeof sample
      report: typeof report
      contractProbe: typeof contractProbe
      snapshotReport: typeof snapshotReport
      dispose: typeof dispose
    }
  }
}
window.__workerReceiveMilliseconds = 0
window.__workerRevisionBench = { setup, sample, report, snapshotReport, contractProbe, dispose }
