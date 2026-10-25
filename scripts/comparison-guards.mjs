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

async function cpuSnapshot(session, now, boundary = {}) {
  boundary.requested = now()
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
    boundary.processInfo = processInfo
  } finally {
    boundary.completed = now()
    boundary.sampledAt = (boundary.requested + boundary.completed) / 2
  }
  return boundary
}

export function failureProperty(error, name) {
  try {
    return error?.[name]
  } catch {
    return undefined
  }
}

export function failureText(error) {
  try {
    return String(failureProperty(error, 'stack') ?? error)
  } catch {
    return 'Unprintable rejection'
  }
}

export function attachFailure(error, name, evidence) {
  try {
    Object.defineProperty(error, name, {
      value: evidence,
      configurable: true,
      enumerable: true,
      writable: true,
    })
  } catch {
    // Rejection identity takes precedence when a value cannot carry diagnostics.
  }
}

async function captureCpuOperation(operation, now) {
  const evidence = { started: now() }
  let outcome = { status: 'fulfilled' }
  try {
    evidence.sample = await operation()
  } catch (error) {
    outcome = { status: 'rejected', error }
    evidence.sample = failureProperty(error, 'partialLatency')
    evidence.error = failureText(error)
  }
  evidence.completed = now()
  return { evidence, outcome }
}

function cpuTiming(before, after, tickSeconds, workCounters) {
  const bracket = (value) =>
    value.requested === undefined
      ? null
      : { requested: value.requested, completed: value.completed }
  const timing = {
    tickSeconds,
    milliseconds: after.sampledAt - before.sampledAt,
    interval: { before: bracket(before), after: bracket(after) },
    acquisitionUncertaintyMilliseconds:
      (before.completed - before.requested + after.completed - after.requested) / 2,
  }
  if (workCounters) timing.workCounters = workCounters
  return timing
}

function retainCpuFailure(error, before, after, operation, tickSeconds, workCounters, onFailure) {
  const evidence = {
    before: before.processInfo ?? null,
    after: after.processInfo ?? null,
    ...cpuTiming(before, after, tickSeconds, workCounters),
    operation: operation?.evidence,
  }
  attachFailure(error, 'cpuFailure', evidence)
  try {
    onFailure?.(evidence)
  } catch {
    // Diagnostic consumers must preserve the original rejection too.
  }
  return evidence
}

function finishCpuMeasurement(before, after, operation, tickSeconds, workCounters) {
  const timing = cpuTiming(before, after, tickSeconds, workCounters)
  const interval = timing.milliseconds
  assert(Number.isFinite(interval) && interval > 0, 'Positive CPU sampling interval required')
  const cpu = { ...cpuSample(before.processInfo, after.processInfo, interval), ...timing }
  if (operation.outcome.status === 'rejected') throw operation.outcome.error
  return {
    sample: operation.evidence.sample,
    milliseconds: operation.evidence.completed - operation.evidence.started,
    cpu,
  }
}

async function measureCpuOnly(
  session,
  operation,
  { now = () => performance.now(), tickSeconds = null, onFailure } = {},
) {
  const before = {}
  const after = {}
  let captured
  try {
    await cpuSnapshot(session, now, before)
    captured = await captureCpuOperation(operation, now)
    await cpuSnapshot(session, now, after)
    return finishCpuMeasurement(before, after, captured, tickSeconds)
  } catch (error) {
    retainCpuFailure(error, before, after, captured, tickSeconds, undefined, onFailure)
    throw error
  }
}

function workEvidence(reader, counterFailure, before, after, nativeBefore, nativeAfter, setup) {
  const workCounters = { status: 'skipped', reason: counterFailure, setup: reader.setup ?? setup }
  if (!reader.metadata) return workCounters
  workCounters.metadata = reader.metadata
  workCounters.snapshots = { before: nativeBefore?.raw ?? null, after: nativeAfter?.raw ?? null }
  const bracket = (value) =>
    value?.requested === undefined
      ? null
      : { requested: value.requested, completed: value.completed }
  workCounters.boundary = {
    before: { cdp: bracket(before), native: bracket(nativeBefore) },
    after: { cdp: bracket(after), native: bracket(nativeAfter) },
  }
  if (counterFailure) return workCounters
  if (!nativeBefore?.raw || !nativeAfter?.raw)
    return { ...workCounters, reason: 'Native counter sampling interrupted' }
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
    onFailure,
  } = {},
) {
  if (!processCounters && !counterReader)
    return measureCpuOnly(session, operation, { now, tickSeconds, onFailure })
  const setupRequested = now()
  const reader =
    counterReader ??
    (await createCounterReader(session, { timeoutMilliseconds: counterTimeoutMilliseconds }))
  const setupCompleted = now()
  const setup = { requested: setupRequested, completed: setupCompleted }
  let counterFailure = reader.skipped ? reader.reason : null
  async function nativeSnapshot(processes) {
    if (counterFailure) return null
    const requested = now()
    try {
      const raw = await reader.snapshot(processes)
      return { raw, requested, completed: now() }
    } catch (error) {
      counterFailure = failureText(error)
      return { raw: null, requested, completed: now(), error: counterFailure }
    }
  }
  const before = {}
  const after = {}
  let captured
  let failure
  let nativeBefore
  let nativeAfter
  function retain(error) {
    const workCounters = workEvidence(
      reader,
      counterFailure,
      before,
      after,
      nativeBefore,
      nativeAfter,
      setup,
    )
    return retainCpuFailure(error, before, after, captured, tickSeconds, workCounters, onFailure)
  }
  try {
    const initial = reader.initialProcessInfo ?? (await cpuSnapshot(session, now)).processInfo
    nativeBefore = await nativeSnapshot(initial)
    await cpuSnapshot(session, now, before)
    captured = await captureCpuOperation(operation, now)
    await cpuSnapshot(session, now, after)
    nativeAfter = await nativeSnapshot(after.processInfo)
    const workCounters = workEvidence(
      reader,
      counterFailure,
      before,
      after,
      nativeBefore,
      nativeAfter,
      setup,
    )
    return finishCpuMeasurement(before, after, captured, tickSeconds, workCounters)
  } catch (error) {
    failure = retain(error)
    throw error
  } finally {
    await closeCounterReader(reader, failure, retain)
  }
}

async function closeCounterReader(reader, failure, retain) {
  try {
    await reader.close?.()
  } catch (error) {
    if (!failure) {
      retain(error)
      throw error
    }
    attachFailure(failure, 'counterCloseError', failureText(error))
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
