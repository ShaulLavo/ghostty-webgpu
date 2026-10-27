import type {} from '../.internal/worker-delta-prototype/transport.js'
import { createControl } from './worker-delta-control.js'
type WorkerDeltaMode = 'control' | 'delta'
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

function reportError(error: unknown): void {
  errors.push(error instanceof Error ? error.message : String(error))
}

function consumeSnapshot(index: number, snapshot: RendererTextFrameSnapshot): void {
  const report = reports[index]!
  report.frames += 1
  for (const row of snapshot.rows) report.rows[row.y] = row.text
}

async function setup(
  mode: WorkerDeltaMode,
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
  window.__deltaTimings = []
  window.__deltaBytes = 0
  sequence = 0
  for (let index = 0; index < count; index += 1) await addControl(mode, index)
  await waitFrames(Array.from({ length: count }, () => 1))
  frameStarts = reports.map((report) => report.frames)
  writeCounts = Array.from({ length: count }, () => 0)
  handlerMilliseconds = 0
  window.__workerReceiveMilliseconds = 0
  acknowledgements = []
}

async function addControl(mode: WorkerDeltaMode, index: number): Promise<void> {
  const control = await createControl(mode, columns, rows, (snapshot) =>
    consumeSnapshot(index, snapshot),
  )
  executions.push(control.execution)
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

function report() {
  return {
    timings: window.__deltaTimings,
    events: eventReports,
    inputs: reports.map((report) => report.inputs),
    hostHandlerMilliseconds: handlerMilliseconds + window.__workerReceiveMilliseconds,
    acknowledgements,
    deliveredFrames: reports.map((value, index) => value.frames - frameStarts[index]!),
    writeCounts,
    rows: reports.map((value) => value.rows),
    bytes: window.__deltaBytes,
    errors,
  }
}

function snapshotReport() {
  return executions.map((execution) => ({
    summary: execution.submittedFrame,
    snapshot: execution.textFrame(),
  }))
}

async function dispose(): Promise<void> {
  await Promise.all(drivers.map((driver) => driver.dispose()))
  drivers = []
  root.replaceChildren()
}

declare global {
  interface Window {
    __workerReceiveMilliseconds: number
    __workerDeltaBench: {
      setup: typeof setup
      sample: typeof sample
      report: typeof report
      snapshotReport: typeof snapshotReport
      dispose: typeof dispose
    }
  }
}
window.__workerReceiveMilliseconds = 0
window.__workerDeltaBench = { setup, sample, report, snapshotReport, dispose }
