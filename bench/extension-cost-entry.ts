import assert from 'node:assert/strict'
import { appendFile, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Terminal } from '../src/dom/terminal.js'
import { ExtensionManager } from '../src/extensions/manager.js'
import type { Extension, TerminalInputEvent } from '../src/extensions/types.js'

const output = process.argv[2]!
assert(output, 'An evidence directory is required')
assert(globalThis.gc, 'Run the frozen entry with node --expose-gc')
const terminal = await Terminal.create({
  runtime: {
    kind: 'owned',
    options: {
      wasm: pathToFileURL(join(output, 'ghostty-vt.wasm')),
      bridge: pathToFileURL(join(output, 'bridge.wasm')),
    },
  },
})
const input: TerminalInputEvent = Object.freeze({ type: 'text', data: 'a' })
const empty = Object.freeze({})
const inertSetup = () => empty
const errors: unknown[] = []
const checkOnly = process.argv[3] === '--check'
const protocol = {
  mode: checkOnly ? 'correctness' : 'measurement',
  scope: 'ExtensionManager on a real unopened native Terminal; public host activation is absent',
  timingIncludes: 'manager traversal, passing callback counter and dispatch claim counter',
  retainedMemoryExcludes:
    'extension values created before baseline; shared contributions; native terminal',
  repetitions: 4,
  passingHandlerCallsPerArm: 1_000_000,
  lifecycleOperationsPerArm: 10_000,
  samplingInterval: 128,
  gcReadsPerSnapshot: 3,
  qualification: {
    inputToPty: 'unmeasured',
    writeToPaint: 'unmeasured',
    terminalCreateWithExtensions: 'unmeasured',
    allocationFree: 'unproven; allocation profiles are sampled diagnostics',
    hardwareAcceptance: 'unmeasured',
  },
} as const

function createManager(): ExtensionManager {
  return new ExtensionManager({
    terminal,
    reservedOsc: new Set(),
    onError: (cause) => errors.push(cause),
  })
}

function inertValues(count: number): Extension[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `inert-${index}`,
    setup: inertSetup,
  }))
}

function dispatchBatch(manager: ExtensionManager, operations: number): void {
  let claims = 0
  for (let operation = 0; operation < operations; operation += 1) {
    if (manager.dispatchInput(input)) claims += 1
  }
  assert.equal(claims, 0)
}

function gcSnapshot(): number[] {
  return Array.from({ length: protocol.gcReadsPerSnapshot }, () => {
    globalThis.gc!()
    return process.memoryUsage().heapUsed
  })
}

function inputArm(handlers: number, inert: number) {
  const manager = createManager()
  manager.install(inertValues(inert))
  let calls = 0
  const pass = () => {
    calls += 1
    return 'pass' as const
  }
  manager.install(
    Array.from({ length: handlers }, (_, index) => ({
      name: `pass-${index}`,
      setup: () => ({ input: pass }),
    })),
  )
  dispatchBatch(manager, 1_000)
  calls = 0
  const operations = protocol.passingHandlerCallsPerArm / handlers
  const start = performance.now()
  dispatchBatch(manager, operations)
  const milliseconds = performance.now() - start
  assert.equal(calls, operations * handlers)
  manager.dispose()
  return {
    handlers,
    inert,
    operations,
    calls,
    milliseconds,
    nanosecondsPerHandler: (milliseconds * 1e6) / calls,
  }
}

function lifecycleArm(inert: number) {
  const manager = createManager()
  manager.install(inertValues(inert))
  const value = { name: 'target', setup: inertSetup }
  const run = (operations: number) => {
    for (let operation = 0; operation < operations; operation += 1) manager.use(value).dispose()
  }
  run(1_000)
  const start = performance.now()
  run(protocol.lifecycleOperationsPerArm)
  const milliseconds = performance.now() - start
  manager.dispose()
  return { inert, operations: protocol.lifecycleOperationsPerArm, milliseconds }
}

function memoryArm(inert: number) {
  const values = inertValues(inert)
  const manager = createManager()
  const before = gcSnapshot()
  manager.install(values)
  const attached = gcSnapshot()
  manager.dispose()
  const disposed = gcSnapshot()
  assert.equal(values.length, inert)
  return { inert, before, attached, disposed, retainedBytes: attached[2]! - before[2]! }
}

async function allocationArm(handlers: number, inert: number, allocating: boolean) {
  const manager = createManager()
  manager.install(inertValues(inert))
  const retained: { input: TerminalInputEvent }[] = []
  let calls = 0
  function passingControl(): 'pass' {
    calls += 1
    return 'pass'
  }
  function allocationControl(received: TerminalInputEvent): 'pass' {
    calls += 1
    retained.push({ input: received })
    return 'pass'
  }
  const handler = allocating ? allocationControl : passingControl
  manager.install(
    Array.from({ length: handlers }, (_, index) => ({
      name: `profile-${index}`,
      setup: () => ({ input: handler }),
    })),
  )
  dispatchBatch(manager, 1_000)
  retained.length = 0
  calls = 0
  globalThis.gc!()
  const session = new Session()
  session.connect()
  try {
    const sampling = {
      samplingInterval: protocol.samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    }
    await session.post('HeapProfiler.startSampling', sampling)
    const operations = 100_000 / handlers
    dispatchBatch(manager, operations)
    const { profile } = await session.post('HeapProfiler.stopSampling')
    assert.equal(calls, operations * handlers)
    const file = `allocation-${handlers}-${inert}-${allocating ? 'positive' : 'passing'}.json`
    await writeFile(join(output, file), JSON.stringify(profile))
    function sampledBytes(node: typeof profile.head, name: string): number {
      const own = node.callFrame.functionName === name ? node.selfSize : 0
      return own + node.children.reduce((sum, child) => sum + sampledBytes(child, name), 0)
    }
    const sampledBytesByFunction = Object.fromEntries(
      [
        'dispatchInput',
        'dispatch',
        'invokeHandler',
        'observeResult',
        'passingControl',
        'allocationControl',
      ].map((name) => [name, sampledBytes(profile.head, name)]),
    )
    const positiveBytes = sampledBytesByFunction.allocationControl!
    if (allocating)
      assert(positiveBytes > 0, 'The allocation sampler must observe the allocating control')
    return {
      handlers,
      inert,
      allocating,
      calls,
      retainedObjects: retained.length,
      sampledBytesByFunction,
      positiveBytes,
      profile: file,
    }
  } finally {
    session.disconnect()
    manager.dispose()
  }
}

function envelope(values: readonly number[]) {
  return { minimum: Math.min(...values), maximum: Math.max(...values) }
}

const inputResults: ReturnType<typeof inputArm>[] = []
const lifecycleResults: ReturnType<typeof lifecycleArm>[] = []
const memoryResults: ReturnType<typeof memoryArm>[] = []
const allocationResults: Awaited<ReturnType<typeof allocationArm>>[] = []

async function inputRepetition(counts: readonly number[], repetition: number): Promise<void> {
  for (const handlers of counts) {
    for (const inert of [0, 1_000, 1_000, 0]) {
      const row = inputArm(handlers, inert)
      inputResults.push(row)
      await appendFile(
        join(output, 'raw.jsonl'),
        `${JSON.stringify({ kind: 'input', repetition, ...row })}\n`,
      )
    }
  }
}

async function lifecycleRepetition(repetition: number): Promise<void> {
  for (const inert of [0, 100, 1_000, 1_000, 100, 0]) {
    const lifecycle = lifecycleArm(inert)
    lifecycleResults.push(lifecycle)
    await appendFile(
      join(output, 'raw.jsonl'),
      `${JSON.stringify({ kind: 'lifecycle', repetition, ...lifecycle })}\n`,
    )
    const memory = memoryArm(inert)
    memoryResults.push(memory)
    await appendFile(
      join(output, 'raw.jsonl'),
      `${JSON.stringify({ kind: 'memory', repetition, ...memory })}\n`,
    )
  }
}

async function runCheckpoint(): Promise<void> {
  await writeFile(join(output, 'protocol.json'), JSON.stringify(protocol, null, 2))
  if (checkOnly) {
    const passing = await allocationArm(10, 1_000, false)
    const positive = await allocationArm(10, 1_000, true)
    assert.equal(passing.retainedObjects, 0)
    assert.equal(positive.retainedObjects, positive.calls)
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify({ protocol, passing, positive }, null, 2),
    )
    console.log(
      JSON.stringify({
        mode: 'correctness',
        passingCalls: passing.calls,
        positiveCalls: positive.calls,
        positiveBytes: positive.positiveBytes,
      }),
    )
    return
  }
  for (let repetition = 0; repetition < protocol.repetitions; repetition += 1) {
    const counts = repetition % 2 === 0 ? [10, 100, 1_000] : [1_000, 100, 10]
    await inputRepetition(counts, repetition)
    await lifecycleRepetition(repetition)
  }
  for (const handlers of [10, 1_000]) {
    for (const inert of [0, 1_000])
      allocationResults.push(await allocationArm(handlers, inert, false))
  }
  allocationResults.push(await allocationArm(10, 1_000, true))
  assert.deepEqual(errors, [])
  const memoryControl = envelope(
    memoryResults.filter((row) => row.inert === 0).map((row) => row.retainedBytes),
  )
  const lifecycleControl = envelope(
    lifecycleResults.filter((row) => row.inert === 0).map((row) => row.milliseconds),
  )
  const result = {
    protocol,
    inputResults,
    inputControls: [10, 100, 1_000].map((handlers) => ({
      handlers,
      envelope: envelope(
        inputResults
          .filter((row) => row.handlers === handlers && row.inert === 0)
          .map((row) => row.nanosecondsPerHandler),
      ),
    })),
    lifecycleResults,
    lifecycleControl,
    lifecycleInsideObservedControlEnvelope: lifecycleResults
      .filter((row) => row.inert !== 0)
      .every(
        (row) =>
          row.milliseconds >= lifecycleControl.minimum &&
          row.milliseconds <= lifecycleControl.maximum,
      ),
    memoryResults,
    memoryControl,
    memoryBytesPerAttachment: memoryResults
      .filter((row) => row.inert !== 0)
      .map((row) => ({
        inert: row.inert,
        measured: row.retainedBytes / row.inert,
        controlAdjustedLower: (row.retainedBytes - memoryControl.maximum) / row.inert,
        controlAdjustedUpper: (row.retainedBytes - memoryControl.minimum) / row.inert,
      })),
    allocationResults,
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      scope: protocol.scope,
      inputArms: inputResults.length,
      lifecycleArms: lifecycleResults.length,
      memoryArms: memoryResults.length,
      allocationArms: allocationResults.length,
      errors: errors.length,
    }),
  )
}

try {
  await runCheckpoint()
} finally {
  terminal.dispose()
}
