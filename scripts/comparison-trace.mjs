import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  attachFailure,
  failureProperty,
  failureText,
  measureCpu,
  withDeadline,
} from './comparison-guards.mjs'
import { createCounterReader } from './comparison-counters.mjs'
import { quantile } from './comparison-report.mjs'
import { renderOperations } from './comparison-render.mjs'

const traceOwners = new WeakMap()

export function displaySummary(periods, metadata = {}) {
  return {
    ...metadata,
    frameCount: periods.length,
    median: periods.length ? quantile(periods, 0.5) : null,
    p95: periods.length ? quantile(periods, 0.95) : null,
    max: periods.length ? Math.max(...periods) : null,
    periods,
  }
}

export function assertDisplay(probe, { idle = true, expectedPeriod = 16.67 } = {}) {
  assert(
    !probe.error &&
      probe.visibility === 'visible' &&
      probe.frameCount >= 20 &&
      Array.isArray(probe.periods) &&
      probe.frameCount === probe.periods.length &&
      Number.isFinite(probe.median) &&
      probe.median > 0 &&
      probe.periods.every((period) => Number.isFinite(period) && period > 0),
    'Mac display unavailable',
  )
  // Mounted cadence is workload evidence; availability and sample integrity still apply.
  if (!idle) return probe.median
  const period = expectedPeriod ?? probe.median
  assert(Number.isFinite(period) && period > 0 && period < 1000, 'Mac display unavailable')
  assert(probe.median >= period * 0.9 && probe.median <= period * 1.1, 'Mac display unavailable')
  return probe.median
}

async function windowInfo(page, browserSession, session) {
  const { targetInfo } = await session.send('Target.getTargetInfo')
  return browserSession.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId })
}

export async function fitWindow(page, browserSession, session) {
  const screen = await page.evaluate(() => ({
    left: window.screen.availLeft,
    top: window.screen.availTop,
    width: window.screen.availWidth,
    height: window.screen.availHeight,
  }))
  const { windowId, bounds: before } = await windowInfo(page, browserSession, session)
  const bounds = {
    left: screen.left + 16,
    top: screen.top + 16,
    width: screen.width - 32,
    height: screen.height - 32,
  }
  await browserSession.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal' },
  })
  await browserSession.send('Browser.setWindowBounds', { windowId, bounds })
  await page.bringToFront()
  return { screen, before, after: (await windowInfo(page, browserSession, session)).bounds }
}

export async function fitGrid(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')
    const sections = [...main.querySelectorAll('section')]
    const canvases = () =>
      Array.from(main.querySelectorAll('canvas'), (canvas) => ({
        width: canvas.width,
        height: canvas.height,
      }))
    const before = canvases()
    const width = Math.max(...sections.map((section) => section.offsetLeft + section.offsetWidth))
    const height = Math.max(...sections.map((section) => section.offsetTop + section.offsetHeight))
    const scale = Math.min(1, (innerWidth - 8) / width, (innerHeight - 8) / height)
    // Transform only compositor placement; terminal layout and backing buffers keep baseline sizes.
    main.style.transformOrigin = 'top left'
    main.style.transform = `scale(${scale})`
    document.body.style.overflow = 'hidden'
    return {
      scale,
      width,
      height,
      innerWidth,
      innerHeight,
      backingBefore: before,
      backingAfter: canvases(),
      sections: sections.map((section) => {
        const r = section.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      }),
    }
  })
}

export async function displayProbe({ page, session, browserSession, metadata }) {
  await page.bringToFront()
  await page.waitForTimeout(1000)
  let periods = []
  let expiredPeriods
  let error
  try {
    periods = await withDeadline(
      () => page.evaluate(() => window.__compare.refreshPeriod(120)),
      8000,
      async () => {
        expiredPeriods = await page.evaluate(() => window.__compare.cancelRefresh()).catch(() => [])
      },
    )
  } catch (failure) {
    error = String(failure)
    periods =
      expiredPeriods ??
      (await page.evaluate(() => window.__compare.cancelRefresh()).catch(() => []))
  }
  const state = await page
    .evaluate(() => ({
      visibility: document.visibilityState,
      focus: document.hasFocus(),
      url: location.href,
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      screenX,
      screenY,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
      },
      canvases: window.__compare.info().canvases,
    }))
    .catch(() => ({}))
  const window = await windowInfo(page, browserSession, session).catch(() => ({}))
  return displaySummary(periods, {
    ...metadata,
    ...state,
    window,
    error,
    warmupMilliseconds: 1000,
    measuredAt: new Date().toISOString(),
  })
}

export async function prepareOutput(output, { tracing = false } = {}) {
  await mkdir(dirname(output), { recursive: true })
  // Only a trace window needs exclusive ownership for discard-on-failure.
  await mkdir(output, { recursive: !tracing })
}

export async function discardTraceWindow(output) {
  for (const name of await readdir(output)) {
    if (name === 'qualification.json') continue
    await unlink(join(output, name))
  }
}

export function summarizeRecords(records) {
  const milliseconds = {}
  const byTerminal = {}
  for (const span of records.spans)
    milliseconds[span.category] = (milliseconds[span.category] ?? 0) + span.self
  for (const counter of records.counters) {
    const counts = (byTerminal[counter.terminal] ??= {})
    counts[counter.operation] = (counts[counter.operation] ?? 0) + counter.value
  }
  const total = Object.values(milliseconds).reduce((a, b) => a + b, 0)
  const shares = Object.fromEntries(
    Object.entries(milliseconds).map(([name, time]) => [name, (time / total) * 100]),
  )
  const frames = records.spans
    .filter((span) => renderOperations.includes(span.operation))
    .map((span) => {
      const counts = {}
      const encoding = records.spans.find(
        (candidate) =>
          candidate.terminal === span.terminal &&
          candidate.operation === 'encode' &&
          candidate.start >= span.start &&
          candidate.end <= span.end,
      )
      const command = encoding?.commands?.length === 1 ? encoding.commands[0] : undefined
      const commit =
        command !== undefined &&
        records.spans.find(
          (candidate) =>
            candidate.terminal === span.terminal &&
            candidate.operation === 'commit' &&
            candidate.commands?.includes(command),
        )
      for (const counter of records.counters) {
        const duringFrame = counter.time >= span.start && counter.time <= span.end
        const duringCommit = commit && counter.time >= commit.start && counter.time <= commit.end
        if (counter.terminal !== span.terminal || (!duringFrame && !duringCommit)) continue
        counts[counter.operation] = (counts[counter.operation] ?? 0) + counter.value
      }
      return { terminal: span.terminal, start: span.start, end: span.end, counts }
    })
  const ownership = {}
  for (const name of [
    'scheduler',
    'device',
    'queue',
    'deviceOwner',
    'coordinator',
    'pipelines',
    'context',
    'programs',
  ]) {
    const identities = (records.ownership ?? []).flatMap((owner) => owner[name] ?? [])
    if (identities.length) ownership[name] = new Set(identities).size
  }
  return { milliseconds, instrumentedMilliseconds: total, shares, byTerminal, frames, ownership }
}

function closeTrace(browserSession, state) {
  if (!state.stream || state.closing) return Promise.resolve()
  state.closing = true
  return browserSession.send('IO.close', { handle: state.stream })
}

async function collectTrace(browserSession, completed, state) {
  const { stream } = await completed
  const chunks = []
  try {
    while (state.active) {
      const part = await browserSession.send('IO.read', { handle: stream })
      if (!state.active) return
      chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'))
      if (part.eof) break
    }
    if (state.active) state.trace = Buffer.concat(chunks)
  } finally {
    await closeTrace(browserSession, state)
  }
}

export async function tracePhase(options) {
  if (!options.cpuOptions?.processCounters || options.cpuOptions.counterReader)
    return runTracePhase(options)
  const requested = performance.now()
  const reader = await createCounterReader(options.browserSession, {
    timeoutMilliseconds: options.cpuOptions.counterTimeoutMilliseconds,
  })
  reader.setup ??= { requested, completed: performance.now() }
  try {
    return await runTracePhase({
      ...options,
      cpuOptions: { ...options.cpuOptions, counterReader: { ...reader, close: undefined } },
    })
  } finally {
    await reader.close?.()
  }
}

async function capturedOperation(operation, state) {
  try {
    return await operation()
  } catch (error) {
    state.failure = failureText(error)
    return failureProperty(error, 'partialLatency')
  }
}

async function measurePhase(browserSession, operation, options) {
  const state = {}
  try {
    const measurement = await measureCpu(
      browserSession,
      () => capturedOperation(operation, state),
      {
        ...options,
        onFailure: (cpu) => {
          state.cpu = cpu
        },
      },
    )
    return { measurement, failure: state.failure }
  } catch (error) {
    if (!state.cpu) throw error
    if (state.failure && state.cpu.operation) state.cpu.operation.error = state.failure
    const operationEvidence = state.cpu.operation
    return {
      measurement: {
        sample: operationEvidence?.sample,
        milliseconds: operationEvidence && operationEvidence.completed - operationEvidence.started,
        cpu: state.cpu,
      },
      failure: failureText(error),
      outcome: { error },
    }
  }
}

function beginRecords(page) {
  return page.evaluate(() => window.__compare.traceBegin())
}

function endRecords(page) {
  return page.evaluate(() => window.__compare.traceEnd())
}

function endTrace(browserSession, state) {
  if (!state.ownsTrace) return Promise.resolve()
  state.ending ??= Promise.resolve().then(() => browserSession.send('Tracing.end'))
  return state.ending
}

function releaseTraceListeners(browserSession, state) {
  browserSession.removeListener('Tracing.tracingComplete', state.onComplete)
  browserSession.removeListener('close', state.onClose)
  if (traceOwners.get(browserSession) === state) traceOwners.delete(browserSession)
}

async function finishTrace(page, browserSession, completed, state, result) {
  if (state.recording) {
    state.recording = false
    try {
      const records = await endRecords(page)
      if (!state.active) return
      result.records = records
      result.summary = summarizeRecords(records)
    } catch (error) {
      if (!state.active) return
      state.recordingFailure = { error }
    }
  }
  if (!state.active) return
  await endTrace(browserSession, state)
  if (!state.active) return
  return collectTrace(browserSession, completed, state)
}

async function finalizeTrace(options, completed, state, result) {
  const { page, browserSession, output, label, finalizationMilliseconds = 10_000 } = options
  let failure
  try {
    await withDeadline(
      () => finishTrace(page, browserSession, completed, state, result),
      finalizationMilliseconds,
      () => {
        state.active = false
        // Recorder completion cannot delay release of the browser-wide trace.
        void endTrace(browserSession, state).catch(() => {})
        void closeTrace(browserSession, state).catch(() => {})
      },
    )
  } catch (error) {
    failure = { error }
  } finally {
    state.active = false
    void closeTrace(browserSession, state).catch(() => {})
    if (state.stream || !state.ownsTrace) releaseTraceListeners(browserSession, state)
  }
  if (state.trace) {
    await writeFile(join(output, `${label}.trace.json.gz`), gzipSync(state.trace))
    result.trace = `${label}.trace.json.gz`
    result.traceBytes = state.trace.length
  }
  if (failure) throw failure.error
  if (state.recordingFailure) throw state.recordingFailure.error
}

async function runTracePhase(options) {
  const { page, browserSession, label, operation, traced, now, categories, cpuOptions } = options
  const result = { label, traced }
  const state = { active: true, recording: false }
  const completed = new Promise((resolve) => {
    state.onComplete = (event) => {
      releaseTraceListeners(browserSession, state)
      state.stream = event.stream
      if (!state.active) void closeTrace(browserSession, state).catch(() => {})
      resolve(event)
    }
  })
  state.onClose = () => releaseTraceListeners(browserSession, state)
  let failure
  try {
    if (traced) {
      assert(!traceOwners.has(browserSession), 'Previous browser trace is still finalizing')
      traceOwners.set(browserSession, state)
      browserSession.once('Tracing.tracingComplete', state.onComplete)
      browserSession.once('close', state.onClose)
      await browserSession.send('Tracing.start', {
        categories:
          categories ??
          'toplevel,devtools.timeline,blink.user_timing,v8,cc,viz,gpu,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler',
        transferMode: 'ReturnAsStream',
      })
      state.ownsTrace = true
      state.recording = true
      await beginRecords(page)
    }
    const measured = await measurePhase(browserSession, operation, { ...cpuOptions, now })
    Object.assign(result, measured.measurement, { error: measured.failure })
    failure = measured.outcome
  } catch (error) {
    failure = { error }
    result.error = failureText(error)
  }
  if (traced) {
    try {
      await finalizeTrace(options, completed, state, result)
    } catch (error) {
      result.finalizationError = failureText(error)
      failure ??= { error }
    }
  }
  if (failure) {
    attachFailure(failure.error, 'phaseFailure', result)
    throw failure.error
  }
  return result
}
