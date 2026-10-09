import assert from 'node:assert/strict'
export function quantile(values, percentile) {
  assert(values.length > 0 && values.every(Number.isFinite), 'Finite samples required')
  const sorted = values.toSorted((a, b) => a - b)
  if (percentile === 0.5) {
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]
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
