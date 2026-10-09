import { chromium } from 'playwright'
import { ComparisonDeadlineError } from './comparison-guards.mjs'

export function diagnosticFailed(run) {
  return [run.legacyWriteControl, run.originalUnicodeProbe].some(
    (probe) => probe?.status === 'failed' || probe?.crashed === true,
  )
}

export function legacyDiagnostic({ origin, testCase, method, ...options }) {
  return isolatedDiagnostic(options, async (page, result) => {
    result.phase = 'prepare'
    await page.goto(origin)
    await page.waitForFunction(() => Boolean(window.__compare))
    await page.evaluate((testCase) => window.__compare.initialize(testCase), testCase)
    await page.evaluate(() => window.__compare.createTerminals())
    result.phase = method
    return page.evaluate((method) => window.__compare[method](), method)
  })
}

export async function isolatedDiagnostic(
  { launchOptions, contextOptions, contexts = new Set() },
  operation,
) {
  const result = {
    status: 'running',
    isolation: 'browser-process',
    crashed: false,
    trace: [],
    pageErrors: [],
  }
  let stopping = false
  let cleanup
  const launching = Promise.resolve().then(() => chromium.launch(launchOptions))
  const ownership = {
    close() {
      stopping = true
      cleanup ??= launching.then((browser) => browser.close())
      return cleanup
    },
  }
  // Pending acquisition must be owned before the deadline can snapshot cleanup.
  contexts.add(ownership)
  try {
    result.phase = 'launch'
    // A separate Chromium process keeps renderer death outside the correctness browser.
    const browser = await launching
    if (stopping) throw new ComparisonDeadlineError()
    result.browser = browser.version()
    const context = await browser.newContext(contextOptions)
    if (stopping) throw new ComparisonDeadlineError()
    const page = await context.newPage()
    if (stopping) throw new ComparisonDeadlineError()
    page.on('crash', () => {
      result.crashed = true
    })
    page.on('pageerror', (error) => result.pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') result.pageErrors.push(message.text())
      const prefix = 'legacy-original-unicode '
      if (message.text().startsWith(prefix))
        result.trace.push(JSON.parse(message.text().slice(prefix.length)))
    })
    const probe = await operation(page, result)
    if (stopping) throw new ComparisonDeadlineError()
    Object.assign(result, probe)
    result.status =
      result.crashed ||
      result.pageErrors.length ||
      Object.values(probe).some((api) => api?.accepted === false)
        ? 'failed'
        : 'complete'
    return result
  } catch (error) {
    result.status = 'failed'
    result.error = String(error.stack ?? error)
    return result
  } finally {
    try {
      await ownership.close()
    } catch (error) {
      result.status = 'failed'
      result.cleanupError = String(error.stack ?? error)
    }
    contexts.delete(ownership)
    if (result.crashed) result.status = 'failed'
  }
}
