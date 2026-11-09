import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  CollectorObservation,
  CollectorDelivery,
  TesterTraceCapture,
  FrameworkTask,
} from 'waffle/testing/page-runner/framework'

export type ReportingMode = 'matrix' | 'flush' | 'errors' | 'capacity' | 'malformed'
export type ReportingState = {
  bodies: unknown[]
  messages: string[]
  errorTrace: Record<string, unknown>[] | null
  clocks: Record<string, unknown>[]
  hooks: string[]
  flush: { rpcHeld: boolean; rpcReleased: boolean; bodyFinished: boolean; calls: number } | null
}

type Gate = {
  status: 'waiting' | 'reached' | 'cancelled'
  readonly reached: ReturnType<typeof Promise.withResolvers<void>>
  readonly release: ReturnType<typeof Promise.withResolvers<void>>
}
const matrixGates = [
  'collected',
  'suite-start',
  'task-started',
  'case-settled',
  'execution-flushed',
  'tester-cleanup-settled',
  'cleanup-response-received',
]

export class ReportingFixtureController {
  readonly mode: ReportingMode
  readonly observations: CollectorObservation[] = []
  readonly reads: { gate: string; state: ReportingState }[] = []
  readonly gates = new Map<string, Gate>()
  private cancelled = false
  private readonly consumed = new Set<string>()
  private tasks: readonly FrameworkTask[] = []
  private capture: TesterTraceCapture | undefined

  constructor(mode: ReportingMode) {
    this.mode = mode
    const names = gateNames(mode)
    for (const name of names)
      this.gates.set(name, {
        status: 'waiting',
        reached: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      })
  }

  arm(capture: TesterTraceCapture): void {
    if (this.capture) throw new Error('Fixture capture already armed')
    this.capture = capture
  }

  readonly collectorResponse = async (
    observation: CollectorObservation,
    signal: AbortSignal,
  ): Promise<CollectorDelivery> => {
    if (this.observations.length === 1024)
      throw new Error('Collector recorder exceeds 1,024 entries')
    this.observations.push(observation)
    const event = observation.event
    if (event.kind === 'collected') this.tasks = event.tasks
    let kind: string = event.kind
    if (
      event.kind === 'task-started' &&
      this.tasks.find((task) => task.id === event.id)?.type !== 'test'
    )
      kind = 'suite-start'
    const gate = this.gates.get(kind)
    if (gate && !this.consumed.has(kind) && !signal.aborted) await this.holdGate(gate, signal, kind)
    return this.mode === 'malformed' && event.kind === 'task-update' ? 'malformed-ack' : 'unchanged'
  }

  private async holdGate(gate: Gate, signal: AbortSignal, kind: string): Promise<void> {
    if (this.mode === 'flush' && kind === 'task-update' && !(await this.state()).flush?.rpcHeld)
      return
    this.consumed.add(kind)
    const cancel = () => this.cancel()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    if (!signal.aborted) gate.status = 'reached'
    gate.reached.resolve()
    try {
      await gate.release.promise
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  cancel(): void {
    this.cancelled = true
    for (const gate of this.gates.values()) {
      if (gate.status === 'waiting') gate.status = 'cancelled'
      gate.reached.resolve()
      gate.release.resolve()
    }
  }

  async state(): Promise<ReportingState> {
    if (this.cancelled) throw new Error('Fixture decisions cancelled')
    if (!this.capture) throw new Error('Fixture capture is not armed')
    const checkpoint = await this.capture.checkpoint()
    return parseReportingState(checkpoint.text)
  }

  async run(): Promise<void> {
    if (this.mode === 'flush') {
      await this.flush()
      return
    }
    if (this.mode !== 'matrix') return
    const gates = Array.from(this.gates.entries())
    for (const [kind, gate] of gates) await this.compareGate(kind, gate)
  }

  private async compareGate(kind: string, gate: Gate): Promise<void> {
    await gate.reached.promise
    const before = await this.state()
    this.reads.push({ gate: kind, state: before })
    if (['collected', 'suite-start', 'task-started'].includes(kind))
      assert.equal(before.bodies.length, 0)
    if (kind === 'case-settled') assert.equal(before.bodies.length, 1)
    if (kind === 'execution-flushed') assert(!before.messages.includes('response:execute'))
    if (kind === 'tester-cleanup-settled') assert(!before.messages.includes('response:cleanup'))
    if (kind === 'cleanup-response-received') assert(before.messages.includes('response:cleanup'))
    await delay(60)
    const after = await this.state()
    this.reads.push({ gate: kind, state: after })
    assert.deepEqual(after.bodies, before.bodies, `Held ${kind} must retain the lifecycle barrier`)
    gate.release.resolve()
  }

  private async until(check: () => Promise<boolean>): Promise<void> {
    for (let turn = 0; turn < 200; turn++) {
      if (await check()) return
      await delay(5)
    }
    throw new Error('Installed reporting boundary not reached')
  }

  private async flush(): Promise<void> {
    const update = this.gates.get('task-update')
    const flushed = this.gates.get('execution-flushed')
    assert(update && flushed && this.capture)
    await update.reached.promise
    await this.until(async () => (await this.state()).flush?.bodyFinished === true)
    const held = await this.state()
    this.reads.push({ gate: 'independent-holds', state: held })
    assert.equal(held.flush?.rpcReleased, false)
    update.release.resolve()
    await this.until(async () =>
      this.observations.some((item) => item.event.kind === 'case-settled'),
    )
    assert(!this.observations.some((item) => item.event.kind === 'execution-flushed'))
    assert(!(await this.state()).messages.includes('response:execute'))
    await this.capture.releaseOriginalRpc()
    await flushed.reached.promise
    this.reads.push({ gate: 'after-original-flush', state: await this.state() })
    flushed.release.resolve()
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function parseReportingState(text: string): ReportingState {
  const value: unknown = JSON.parse(text)
  if (
    !record(value) ||
    !Array.isArray(value.bodies) ||
    !Array.isArray(value.messages) ||
    !value.messages.every((item) => typeof item === 'string') ||
    !Array.isArray(value.clocks) ||
    !value.clocks.every(record) ||
    !Array.isArray(value.hooks) ||
    !value.hooks.every((item) => typeof item === 'string') ||
    (value.errorTrace !== null &&
      (!Array.isArray(value.errorTrace) || !value.errorTrace.every(record)))
  )
    throw new Error('Invalid recorded tester trace')
  return {
    bodies: value.bodies,
    messages: value.messages,
    clocks: value.clocks,
    hooks: value.hooks,
    errorTrace: value.errorTrace,
    flush: parseFlush(value.flush),
  }
}
function parseFlush(value: unknown): ReportingState['flush'] {
  if (value === null) return null
  if (!record(value)) throw new Error('Invalid recorded original RPC state')
  const { rpcHeld, rpcReleased, bodyFinished, calls } = value
  if (
    typeof rpcHeld !== 'boolean' ||
    typeof rpcReleased !== 'boolean' ||
    typeof bodyFinished !== 'boolean' ||
    typeof calls !== 'number'
  )
    throw new Error('Invalid recorded original RPC state')
  return { rpcHeld, rpcReleased, bodyFinished, calls }
}

function gateNames(mode: ReportingMode): string[] {
  if (mode === 'matrix') return matrixGates
  if (mode === 'flush') return ['task-update', 'execution-flushed']
  return []
}
