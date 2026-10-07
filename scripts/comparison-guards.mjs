import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { counterDelta, createCounterReader, parseCounterSnapshot } from './comparison-counters.mjs'

export function verifyHash(bytes, expected, name) {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    expected,
    `Bundle asset hash mismatch: ${name}`,
  )
}

export function cpuSample(before, after, milliseconds) {
  const prior = new Map(before.map((entry) => [entry.id, entry]))
  const ids = new Set(after.map((entry) => entry.id))
  assert(
    before.every((entry) => ids.has(entry.id)) && after.every((entry) => prior.has(entry.id)),
    'CPU process set changed during sample',
  )
  const secondsByType = {}
  for (const entry of after) {
    const previous = prior.get(entry.id).cpuTime
    const delta = entry.cpuTime - previous
    assert(
      Number.isFinite(delta) && delta >= 0,
      `CPU counter delta invalid for process ${entry.id}: before=${previous} after=${entry.cpuTime}`,
    )
    secondsByType[entry.type] = (secondsByType[entry.type] ?? 0) + delta
  }
  return {
    before,
    after,
    secondsByType,
    percentOfOneCore:
      (Object.values(secondsByType).reduce((a, b) => a + b, 0) / milliseconds) * 100_000,
    processChurn: false,
  }
}

async function cpuSnapshot(session, now) {
  const requested = now()
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  const completed = now()
  return { processInfo, requested, completed, sampledAt: (requested + completed) / 2 }
}

async function measureCpuOnly(
  session,
  operation,
  { now = () => performance.now(), tickSeconds = null } = {},
) {
  const before = await cpuSnapshot(session, now)
  const started = now()
  const sample = await operation()
  const milliseconds = now() - started
  const after = await cpuSnapshot(session, now)
  const interval = after.sampledAt - before.sampledAt
  assert(Number.isFinite(interval) && interval > 0, 'Positive CPU sampling interval required')
  return {
    sample,
    milliseconds,
    cpu: {
      ...cpuSample(before.processInfo, after.processInfo, interval),
      tickSeconds,
      milliseconds: interval,
      interval: {
        before: { requested: before.requested, completed: before.completed },
        after: { requested: after.requested, completed: after.completed },
      },
      acquisitionUncertaintyMilliseconds:
        (before.completed - before.requested + after.completed - after.requested) / 2,
    },
  }
}

function workEvidence(reader, counterFailure, before, after, nativeBefore, nativeAfter, setup) {
  const workCounters = { status: 'skipped', reason: counterFailure, setup: reader.setup ?? setup }
  if (!reader.metadata) return workCounters
  workCounters.metadata = reader.metadata
  workCounters.snapshots = { before: nativeBefore?.raw ?? null, after: nativeAfter?.raw ?? null }
  const bracket = (value) =>
    value ? { requested: value.requested, completed: value.completed } : null
  workCounters.boundary = {
    before: { cdp: bracket(before), native: bracket(nativeBefore) },
    after: { cdp: bracket(after), native: bracket(nativeAfter) },
  }
  if (counterFailure) return workCounters
  try {
    const result = {
      ...workCounters,
      ...counterDelta(
        parseCounterSnapshot(nativeBefore.raw, reader.metadata),
        parseCounterSnapshot(nativeAfter.raw, reader.metadata),
        before.processInfo,
        after.processInfo,
      ),
    }
    delete result.reason
    return result
  } catch (error) {
    return { ...workCounters, reason: error.message }
  }
}

export async function measureCpu(
  session,
  operation,
  {
    now = () => performance.now(),
    tickSeconds = null,
    processCounters = false,
    counterReader,
    counterTimeoutMilliseconds,
  } = {},
) {
  if (!processCounters && !counterReader)
    return measureCpuOnly(session, operation, { now, tickSeconds })
  const setupRequested = now()
  const reader =
    counterReader ??
    (await createCounterReader(session, { timeoutMilliseconds: counterTimeoutMilliseconds }))
  const setupCompleted = now()
  let counterFailure = reader.skipped ? reader.reason : null
  async function nativeSnapshot(processes) {
    if (counterFailure) return null
    const requested = now()
    try {
      const raw = await reader.snapshot(processes)
      return { raw, requested, completed: now() }
    } catch (error) {
      counterFailure = error.message
      return { raw: null, requested, completed: now(), error: error.message }
    }
  }
  try {
    const initial = reader.initialProcessInfo ?? (await cpuSnapshot(session, now)).processInfo
    const nativeBefore = await nativeSnapshot(initial)
    const before = await cpuSnapshot(session, now)
    const started = now()
    const sample = await operation()
    const milliseconds = now() - started
    const after = await cpuSnapshot(session, now)
    const nativeAfter = await nativeSnapshot(after.processInfo)
    const interval = after.sampledAt - before.sampledAt
    const workCounters = workEvidence(
      reader,
      counterFailure,
      before,
      after,
      nativeBefore,
      nativeAfter,
      { requested: setupRequested, completed: setupCompleted },
    )
    let validated
    try {
      assert(Number.isFinite(interval) && interval > 0, 'Positive CPU sampling interval required')
      validated = cpuSample(before.processInfo, after.processInfo, interval)
    } catch (error) {
      error.cpuFailure = {
        before: before.processInfo,
        after: after.processInfo,
        milliseconds: interval,
        workCounters,
      }
      throw error
    }
    return {
      sample,
      milliseconds,
      cpu: {
        ...validated,
        tickSeconds,
        milliseconds: interval,
        interval: {
          before: { requested: before.requested, completed: before.completed },
          after: { requested: after.requested, completed: after.completed },
        },
        acquisitionUncertaintyMilliseconds:
          (before.completed - before.requested + after.completed - after.requested) / 2,
        workCounters,
      },
    }
  } finally {
    await reader.close?.()
  }
}

export class ComparisonDeadlineError extends Error {
  constructor() {
    super('Comparison case deadline exceeded')
  }
}

export async function withDeadline(
  operation,
  milliseconds,
  expire,
  { drain = false, drainMilliseconds = 10_000 } = {},
) {
  let timer
  let cleanup
  const running = Promise.resolve().then(operation)
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cleanup = Promise.resolve().then(expire)
      reject(new ComparisonDeadlineError())
    }, milliseconds)
  })
  try {
    return await Promise.race([running, deadline])
  } catch (error) {
    if (cleanup) await cleanup
    // A case owns the browser-wide trace until its finalizer drains the stream.
    if (cleanup && drain) {
      await withDeadline(
        () => running.catch(() => {}),
        drainMilliseconds,
        () => {},
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
