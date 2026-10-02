import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { measureCpu, withDeadline } from './comparison-guards.mjs'
import { quantile } from './comparison-report.mjs'

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
      [...main.querySelectorAll('canvas')].map((canvas) => ({
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
    .filter((span) => span.operation === 'drawFrame' || span.operation === 'renderRows')
    .map((span) => {
      const counts = {}
      for (const counter of records.counters) {
        if (
          counter.terminal !== span.terminal ||
          counter.time < span.start ||
          counter.time > span.end
        )
          continue
        counts[counter.operation] = (counts[counter.operation] ?? 0) + counter.value
      }
      return { terminal: span.terminal, start: span.start, end: span.end, counts }
    })
  const ownership = {}
  for (const name of ['scheduler', 'device', 'queue', 'pipelines', 'context', 'programs']) {
    const identities = (records.ownership ?? []).flatMap((owner) => owner[name] ?? [])
    if (identities.length) ownership[name] = new Set(identities).size
  }
  return { milliseconds, instrumentedMilliseconds: total, shares, byTerminal, frames, ownership }
}

async function collectTrace(browserSession, completed) {
  const { stream } = await completed
  const chunks = []
  try {
    for (;;) {
      const part = await browserSession.send('IO.read', { handle: stream })
      chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'))
      if (part.eof) break
    }
  } finally {
    await browserSession.send('IO.close', { handle: stream })
  }
  return Buffer.concat(chunks)
}

export async function tracePhase({
  page,
  browserSession,
  output,
  label,
  operation,
  traced,
  now,
  categories,
}) {
  if (traced)
    await browserSession.send('Tracing.start', {
      categories:
        categories ??
        'toplevel,devtools.timeline,blink.user_timing,v8,cc,viz,gpu,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler',
      transferMode: 'ReturnAsStream',
    })
  const completed = traced
    ? new Promise((resolve) => browserSession.once('Tracing.tracingComplete', resolve))
    : undefined
  let result
  let trace
  let recording = false
  try {
    if (traced) {
      await page.evaluate(() => window.__compare.traceBegin())
      recording = true
    }
    let failure
    const measurement = await measureCpu(
      browserSession,
      async () => {
        try {
          return await operation()
        } catch (error) {
          failure = String(error.stack ?? error)
          return error.partialLatency
        }
      },
      { now },
    )
    const records = traced ? await page.evaluate(() => window.__compare.traceEnd()) : undefined
    recording = false
    result = { label, traced, ...measurement, error: failure }
    if (records) {
      result.records = records
      result.summary = summarizeRecords(records)
    }
  } finally {
    if (recording) await page.evaluate(() => window.__compare.traceEnd()).catch(() => {})
    if (traced) {
      await browserSession.send('Tracing.end')
      trace = await collectTrace(browserSession, completed)
    }
  }
  if (!traced) return result
  result.trace = `${label}.trace.json.gz`
  result.traceBytes = trace.length
  await writeFile(join(output, result.trace), gzipSync(trace))
  return result
}
