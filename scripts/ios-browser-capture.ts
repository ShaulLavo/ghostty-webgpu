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

export async function enclosingDeviceCapture(
  official: (next: ProviderScreenshotOptions) => Promise<ScreenshotResult>,
  request: {
    browser: WebdriverIO.Browser
    testerSelected: boolean
    options: EnclosingOptions
    observe?: (evidence: CaptureEvidence) => void
  },
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
  const result = await official({ ...pageOptions, target: 'page' })
  const after = await browser.execute(measureCapture, element)
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
