import type { BrowserCommands } from 'vitest/internal/browser'
import type { BrowserCommand } from 'vitest/node'
import type { ProviderScreenshotOptions } from './ios-browser.ts'
import {
  measureCapture,
  planEnclosingCrop,
  prepareCapture,
  UnsupportedCapture,
  type CaptureGeometry,
} from './ios-browser-capture-geometry.ts'
import { cropPngLossless, inspectCapturePng } from './ios-browser-capture-png.ts'
import {
  readDiagnosticMetrics,
  rejectionMessage,
  type CaptureDiagnostic,
} from './ios-browser-capture-diagnostic.ts'

export type ScreenshotCall = BrowserCommands['__vitest_takeScreenshot']
export type ScreenshotPayload = Parameters<ScreenshotCall>
export type ScreenshotResult = Awaited<ReturnType<ScreenshotCall>>
export type ScreenshotCommand = BrowserCommand<ScreenshotPayload, ReturnType<ScreenshotCall>>
export type EnclosingOptions = ProviderScreenshotOptions & {
  element: NonNullable<ProviderScreenshotOptions['element']>
  target?: undefined
  scale: 'device'
  save: false
}

export type CaptureEvidence = {
  before: CaptureGeometry
  after: CaptureGeometry
  viewport: { width: number; height: number; profiles: string[] }
  png: { width: number; height: number; profiles: string[] }
  crop: { x: number; y: number; width: number; height: number }
}

export function isEnclosingDeviceCapture(
  options: ProviderScreenshotOptions,
): options is EnclosingOptions {
  return (
    options.element !== undefined &&
    options.target === undefined &&
    options.scale === 'device' &&
    options.save === false
  )
}

type CaptureRequest = {
  browser: WebdriverIO.Browser
  testerSelected: boolean
  options: EnclosingOptions
  observe?: (evidence: CaptureEvidence) => void
  diagnose?: (evidence: CaptureDiagnostic) => void
}

export async function enclosingDeviceCapture(
  official: (next: ProviderScreenshotOptions) => Promise<ScreenshotResult>,
  request: CaptureRequest,
): Promise<ScreenshotResult> {
  const { browser, testerSelected, options } = request
  if (!testerSelected || browser.isBidi)
    throw new UnsupportedCapture(
      'Enclosing capture requires a selected tester in classic WebDriver',
    )
  const element = await browser.$(options.element.selector)
  await browser.execute(prepareCapture, element)
  const before = await browser.execute(measureCapture, element)
  if (!before) throw new UnsupportedCapture('Unsupported enclosing capture geometry')
  // Validate containment before asking the official callback to create its temporary PNG.
  planEnclosingCrop(before, {
    width: Math.round(before.top.visual.width * before.top.dpr),
    height: Math.round(before.top.visual.height * before.top.dpr),
  })
  const { element: _element, ...pageOptions } = options
  let result: ScreenshotResult
  try {
    result = await official({ ...pageOptions, target: 'page' })
  } catch (error) {
    request.diagnose?.({ kind: 'official-rejected', before, rejection: rejectionMessage(error) })
    throw error
  }
  return finishCapture(request, element, before, result)
}

async function finishCapture(
  request: CaptureRequest,
  element: Awaited<ReturnType<WebdriverIO.Browser['$']>>,
  before: CaptureGeometry,
  result: ScreenshotResult,
): Promise<ScreenshotResult> {
  let after: CaptureGeometry | null = null
  let outcome: { kind: 'fulfilled'; value: ScreenshotResult } | { kind: 'rejected'; error: unknown }
  try {
    after = await request.browser.execute(measureCapture, element)
    outcome = { kind: 'fulfilled', value: validateCapture(request, before, after, result) }
  } catch (error) {
    outcome = { kind: 'rejected', error }
  }
  if (request.diagnose) {
    const metrics = await readDiagnosticMetrics(request.browser)
    request.diagnose({
      kind: 'captured',
      before,
      after,
      raw: result.buffer,
      metrics,
      outcome:
        outcome.kind === 'fulfilled'
          ? { kind: 'fulfilled' }
          : { kind: 'rejected', rejection: rejectionMessage(outcome.error) },
    })
  }
  if (outcome.kind === 'rejected') throw outcome.error
  return outcome.value
}

function validateCapture(
  request: CaptureRequest,
  before: CaptureGeometry,
  after: CaptureGeometry | null,
  result: ScreenshotResult,
): ScreenshotResult {
  if (!after || !after.frame.cornersHitFrame || JSON.stringify(before) !== JSON.stringify(after))
    throw new UnsupportedCapture('Capture geometry changed during screenshot')
  const info = inspectCapturePng(result.buffer)
  const crop = planEnclosingCrop(before, info)
  const buffer = cropPngLossless(result.buffer, crop)
  request.observe?.({
    before,
    after,
    viewport: { width: info.width, height: info.height, profiles: info.profiles },
    png: { width: crop.width, height: crop.height, profiles: info.profiles },
    crop,
  })
  return { ...result, buffer }
}
