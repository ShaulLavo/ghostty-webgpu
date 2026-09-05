import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { browserRenderClock } from '../config.js'
import type { RendererFrameSnapshot, WebGpuTerminalRendererOptions } from '../renderer.js'
import { WebGlTerminalRenderer } from './renderer.js'
import {
  TestClock,
  TestRenderState,
  cell,
  cellRegion,
  fittedFont,
  maximumAlpha,
  pixel,
  regionPixels,
  rgb,
  row,
  style,
} from './tests/fixture.js'

const canvases = new Set<HTMLCanvasElement>()
const renderers = new Set<WebGlTerminalRenderer>()

afterEach(() => {
  for (const renderer of renderers) renderer.dispose()
  for (const canvas of canvases) canvas.remove()
  renderers.clear()
  canvases.clear()
  vi.restoreAllMocks()
})

async function fixture(
  source: TestRenderState,
  overrides: Partial<WebGpuTerminalRendererOptions> = {},
) {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  canvases.add(canvas)
  const clock = new TestClock()
  const renderer = await WebGlTerminalRenderer.create({
    canvas,
    columns: source.rows[0]?.cells.length ?? 1,
    font: fittedFont(),
    renderState: source,
    rows: source.rows.length,
    schedulerClock: clock,
    ...overrides,
  })
  renderers.add(renderer)
  return { canvas, clock, renderer }
}

function context(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('These browser tests require real WebGL2')
  return gl
}

function contextLossExtension(gl: WebGL2RenderingContext): WEBGL_lose_context {
  const extension = gl.getExtension('WEBGL_lose_context')
  if (!extension) throw new Error('These browser tests require WEBGL_lose_context')
  return extension
}

function nextEvent(canvas: HTMLCanvasElement, name: string): Promise<Event> {
  return new Promise((resolve) => canvas.addEventListener(name, resolve, { once: true }))
}

async function displayedPixels(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const screenshot = await page.screenshot({ element: canvas, save: false, scale: 'css' })
  const image = new Image()
  image.src = `data:image/png;base64,${screenshot}`
  await image.decode()
  expect([image.naturalWidth, image.naturalHeight]).toEqual([canvas.width, canvas.height])

  // Decode the browser screenshot separately so reading pixels cannot redraw the WebGL canvas.
  const decoded = document.createElement('canvas')
  decoded.width = image.naturalWidth
  decoded.height = image.naturalHeight
  const context = decoded.getContext('2d')
  if (!context) throw new Error('Screenshot decoding requires Canvas2D')
  context.drawImage(image, 0, 0)
  return new Uint8Array(context.getImageData(0, 0, decoded.width, decoded.height).data)
}

describe('WebGlTerminalRenderer', () => {
  it('presents initial pixels and live theme changes to the browser compositor', async ({
    onTestFinished,
  }) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    onTestFinished(() => page.viewport(viewport.width, viewport.height))
    await page.viewport(320, 240)
    const source = new TestRenderState([
      row(0, [cell(0, { text: '█' }), cell(1, { background: rgb(0, 0, 255) }), cell(2)]),
    ])
    const { canvas, renderer } = await fixture(source, {
      schedulerClock: browserRenderClock(),
      theme: { foreground: rgb(255, 0, 0) },
    })
    canvas.style.backgroundColor = '#112233'
    await expect.poll(() => renderer.metrics.submittedFrames).toBe(1)

    const initial = await displayedPixels(canvas)
    const initialGlyph = regionPixels(initial, canvas.width, cellRegion(0))
    expect(initialGlyph.some(([r, g, b]) => r === 255 && g === 0 && b === 0)).toBe(true)
    expect(pixel(initial, canvas.width, 24, 12)).toEqual([0, 0, 255, 255])
    expect(pixel(initial, canvas.width, 40, 12)).toEqual([17, 34, 51, 255])

    renderer.setTheme({ foreground: rgb(0, 255, 0) })
    await expect.poll(() => renderer.metrics.submittedFrames).toBe(2)

    const updated = await displayedPixels(canvas)
    const updatedGlyph = regionPixels(updated, canvas.width, cellRegion(0))
    expect(updatedGlyph.some(([r, g, b]) => r === 0 && g === 255 && b === 0)).toBe(true)
    expect(updatedGlyph.some(([r, g, b]) => r === 255 && g === 0 && b === 0)).toBe(false)
    expect(pixel(updated, canvas.width, 24, 12)).toEqual([0, 0, 255, 255])
    expect(pixel(updated, canvas.width, 40, 12)).toEqual([17, 34, 51, 255])
    expect(renderer.hasPendingFrame).toBe(false)
  })

  it('keeps default cells transparent and explicit backgrounds opaque in top-left pixel order', async () => {
    const source = new TestRenderState([
      row(0, [cell(0), cell(1, { background: rgb(255, 0, 0) })]),
      row(1, [cell(0, { background: rgb(0, 0, 255) }), cell(1)]),
    ])
    const { canvas, clock, renderer } = await fixture(source)
    clock.flushFrame()
    const pixels = await renderer.capturePixels()

    expect(renderer.backend).toBe('webgl2')
    expect(pixel(pixels, canvas.width, 8, 12)).toEqual([0, 0, 0, 0])
    expect(pixel(pixels, canvas.width, 24, 12)).toEqual([255, 0, 0, 255])
    expect(pixel(pixels, canvas.width, 8, 36)).toEqual([0, 0, 255, 255])
    expect(pixel(pixels, canvas.width, 24, 36)).toEqual([0, 0, 0, 0])
    expect(context(canvas).getError()).toBe(0)

    source.replaceRow(1, [cell(0), cell(1)])
    renderer.notifyWrite()
    clock.flushFrame()
    const cleared = await renderer.capturePixels()
    expect(pixel(cleared, canvas.width, 8, 36)).toEqual([0, 0, 0, 0])
    expect(pixel(cleared, canvas.width, 24, 12)).toEqual([255, 0, 0, 255])
  })

  it('preserves foreground colors and reduces faint glyph coverage on transparent cells', async () => {
    const source = new TestRenderState([
      row(0, [
        cell(0, { foreground: rgb(255, 0, 0), text: '█' }),
        cell(1, { foreground: rgb(255, 0, 0), style: style({ faint: true }), text: '█' }),
        cell(2, { style: style({ invisible: true }), text: '█' }),
      ]),
    ])
    const { canvas, clock, renderer } = await fixture(source)
    clock.flushFrame()
    const pixels = await renderer.capturePixels()
    const normal = regionPixels(pixels, canvas.width, cellRegion(0))
    const faint = regionPixels(pixels, canvas.width, cellRegion(1))
    const invisible = regionPixels(pixels, canvas.width, cellRegion(2))

    expect(maximumAlpha(normal)).toBeGreaterThan(240)
    expect(maximumAlpha(faint)).toBeGreaterThan(0)
    expect(maximumAlpha(faint)).toBeLessThan(maximumAlpha(normal) * 0.75)
    expect(normal.some(([red, green, blue]) => red === 255 && green === 0 && blue === 0)).toBe(true)
    expect(maximumAlpha(invisible)).toBe(0)
  })

  it('renders color emoji without tinting their atlas pixels to the text foreground', async () => {
    const source = new TestRenderState([
      row(0, [
        cell(0, { foreground: rgb(255, 0, 0), text: '🧪' }),
        cell(1, { continuation: true }),
      ]),
    ])
    const { canvas, clock, renderer } = await fixture(source)
    clock.flushFrame()
    const pixels = await renderer.capturePixels()
    const colors = regionPixels(pixels, canvas.width, {
      height: canvas.height,
      width: canvas.width,
      x: 0,
      y: 0,
    })

    expect(
      colors.some(([, green = 0, blue = 0, alpha = 0]) => alpha > 128 && (green > 80 || blue > 80)),
    ).toBe(true)
    expect(context(canvas).getError()).toBe(0)
  })

  it('uses selection and cursor text colors and makes low-contrast glyphs readable', async () => {
    const source = new TestRenderState([
      row(0, [
        cell(0, { selected: true, text: '█' }),
        cell(1, { text: '█' }),
        cell(2, { background: rgb(128, 128, 128), foreground: rgb(128, 128, 128), text: '█' }),
      ]),
    ])
    source.cursor = {
      blinking: false,
      passwordInput: false,
      style: 'block',
      viewport: { wideTail: false, x: 1, y: 0 },
      visible: true,
    }
    const { canvas, clock, renderer } = await fixture(source, {
      theme: {
        cursor: rgb(0, 255, 0),
        cursorText: rgb(0, 0, 255),
        minimumContrast: 1,
        selectionBackground: rgb(255, 0, 0),
        selectionForeground: rgb(255, 255, 0),
      },
    })
    renderer.setFocused(true)
    clock.flushFrame()
    const pixels = await renderer.capturePixels()
    const selection = regionPixels(pixels, canvas.width, cellRegion(0))
    const cursor = regionPixels(pixels, canvas.width, cellRegion(1))

    expect(selection.some(([r, g, b]) => r === 255 && g === 0 && b === 0)).toBe(true)
    expect(selection.some(([r, g, b]) => r === 255 && g === 255 && b === 0)).toBe(true)
    expect(cursor.some(([r, g, b]) => r === 0 && g === 255 && b === 0)).toBe(true)
    expect(cursor.some(([r, g, b]) => r === 0 && g === 0 && b === 255)).toBe(true)

    renderer.setTheme({ minimumContrast: 7 })
    clock.flushFrame()
    const contrasted = regionPixels(await renderer.capturePixels(), canvas.width, cellRegion(2))
    expect(
      contrasted.some(([r = 255, g = 255, b = 255, a]) => r < 25 && g < 25 && b < 25 && a === 255),
    ).toBe(true)
  })

  it('applies live theme, font and grid changes to rendered pixels and frame snapshots', async () => {
    const source = new TestRenderState([row(0, [cell(0, { text: '█' }), cell(1)])])
    const frames: RendererFrameSnapshot[] = []
    const { canvas, clock, renderer } = await fixture(source, {
      onFrame: (snapshot) => frames.push(snapshot),
      theme: { foreground: rgb(255, 0, 0) },
    })
    clock.flushFrame()
    const before = regionPixels(await renderer.capturePixels(), canvas.width, cellRegion(0))
    expect(before.some(([r, g, b]) => r === 255 && g === 0 && b === 0)).toBe(true)

    renderer.setTheme({ foreground: rgb(0, 255, 0) })
    renderer.setFont(fittedFont(20, 30, 24))
    source.replaceRow(1, [cell(0, { background: rgb(0, 0, 255) }), cell(1)])
    renderer.resize({ columns: 2, rows: 2 })
    clock.flushFrame()
    const after = await renderer.capturePixels()

    expect([canvas.width, canvas.height]).toEqual([40, 60])
    expect([canvas.style.width, canvas.style.height]).toEqual(['40px', '60px'])
    expect(pixel(after, canvas.width, 10, 45)).toEqual([0, 0, 255, 255])
    const glyph = regionPixels(after, canvas.width, { height: 30, width: 20, x: 0, y: 0 })
    expect(glyph.some(([r, g, b]) => r === 0 && g === 255 && b === 0)).toBe(true)
    expect(frames.at(-1)?.rows.map((value) => value.text)).toEqual(['█ ', '  '])
    expect(renderer.hasPendingFrame).toBe(false)
  })

  it('coalesces dirty writes, preserves clean rows and suspends work while hidden', async () => {
    const source = new TestRenderState([
      row(0, [cell(0, { background: rgb(255, 0, 0) })]),
      row(1, [cell(0, { background: rgb(0, 0, 255) })]),
    ])
    const { canvas, clock, renderer } = await fixture(source)
    clock.flushFrame()
    const rebuilt = renderer.metrics.rebuiltRows
    source.replaceRow(1, [cell(0, { background: rgb(0, 255, 0) })])
    for (let write = 0; write < 100; write += 1) renderer.notifyWrite()
    expect(clock.frames.size).toBe(1)
    clock.flushFrame()
    expect(renderer.metrics.rebuiltRows).toBe(rebuilt + 1)
    const pixels = await renderer.capturePixels()
    expect(pixel(pixels, canvas.width, 8, 12)).toEqual([255, 0, 0, 255])
    expect(pixel(pixels, canvas.width, 8, 36)).toEqual([0, 255, 0, 255])

    const submitted = renderer.metrics.submittedFrames
    renderer.schedule()
    clock.flushFrame()
    expect(renderer.metrics.submittedFrames).toBe(submitted)
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])

    renderer.setDocumentVisible(false)
    source.replaceRow(0, [cell(0, { background: rgb(255, 255, 0) })])
    renderer.notifyWrite()
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
    expect(source.acknowledgements).toBe(2)
    renderer.setDocumentVisible(true)
    clock.flushFrame()
    expect(pixel(await renderer.capturePixels(), canvas.width, 8, 12)).toEqual([255, 255, 0, 255])
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
  })

  it('restores glyphs and writes received during real context loss without acknowledging lost work', async () => {
    const source = new TestRenderState([
      row(0, [cell(0, { foreground: rgb(255, 0, 0), text: '█' }), cell(1)]),
    ])
    const { canvas, clock, renderer } = await fixture(source)
    clock.flushFrame()
    const before = await renderer.capturePixels()
    const gl = context(canvas)
    const extension = contextLossExtension(gl)
    const lost = nextEvent(canvas, 'webglcontextlost')
    extension.loseContext()
    expect((await lost).defaultPrevented).toBe(true)
    source.replaceRow(0, [
      cell(0, { foreground: rgb(255, 0, 0), text: '█' }),
      cell(1, { background: rgb(0, 0, 255) }),
    ])
    renderer.notifyWrite()
    if (clock.frames.size > 0) clock.flushFrame()
    expect(source.acknowledgements).toBe(1)

    // Restoration is allowed after the browser finishes dispatching the cancelable loss event.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    const restored = nextEvent(canvas, 'webglcontextrestored')
    extension.restoreContext()
    await restored
    clock.flushFrame()
    const after = await renderer.capturePixels()
    expect(regionPixels(after, canvas.width, cellRegion(0))).toEqual(
      regionPixels(before, canvas.width, cellRegion(0)),
    )
    expect(pixel(after, canvas.width, 24, 12)).toEqual([0, 0, 255, 255])
    expect(source.acknowledgements).toBe(2)
    expect(gl.getError()).toBe(0)
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
  })

  it('reports failed restoration and retries pending pixels on the next write without standing work', async () => {
    const source = new TestRenderState([
      row(0, [cell(0, { foreground: rgb(255, 0, 0), text: '█' }), cell(1)]),
    ])
    source.cursor = {
      blinking: true,
      passwordInput: false,
      style: 'block',
      viewport: { wideTail: false, x: 0, y: 0 },
      visible: true,
    }
    const errors: unknown[] = []
    const { canvas, clock, renderer } = await fixture(source, {
      cursorBlink: true,
      onError: (cause) => errors.push(cause),
    })
    renderer.setFocused(true)
    clock.flushFrame()
    expect(renderer.hasPendingTimer).toBe(true)
    const before = await renderer.capturePixels()
    const submitted = renderer.metrics.submittedFrames
    const gl = context(canvas)
    const extension = contextLossExtension(gl)
    const lost = nextEvent(canvas, 'webglcontextlost')
    extension.loseContext()
    expect((await lost).defaultPrevented).toBe(true)
    source.replaceRow(0, [
      cell(0, { foreground: rgb(255, 0, 0), text: '█' }),
      cell(1, { background: rgb(0, 0, 255) }),
    ])
    const createProgram = vi.spyOn(gl, 'createProgram').mockImplementation(() => {
      throw new Error('Injected WebGL resource allocation failure')
    })

    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    const restored = nextEvent(canvas, 'webglcontextrestored')
    extension.restoreContext()
    await restored
    clock.flushFrame()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(source.acknowledgements).toBe(1)
    expect(renderer.metrics.submittedFrames).toBe(submitted)
    expect(renderer.metrics.deviceRestores).toBe(0)
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])

    createProgram.mockRestore()
    renderer.notifyWrite()
    clock.flushFrame()
    const after = await renderer.capturePixels()

    expect(regionPixels(after, canvas.width, cellRegion(0))).toEqual(
      regionPixels(before, canvas.width, cellRegion(0)),
    )
    expect(pixel(after, canvas.width, 24, 12)).toEqual([0, 0, 255, 255])
    expect(errors).toHaveLength(1)
    expect(source.acknowledgements).toBe(2)
    expect(renderer.metrics.submittedFrames).toBe(submitted + 1)
    expect(renderer.metrics.deviceRestores).toBe(1)
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 1])
  })

  it('releases live resources and cancels cursor work when disposed repeatedly', async () => {
    const source = new TestRenderState([row(0, [cell(0, { text: 'A' })])])
    source.cursor = {
      blinking: true,
      passwordInput: false,
      style: 'block',
      viewport: { wideTail: false, x: 0, y: 0 },
      visible: true,
    }
    const { canvas, clock, renderer } = await fixture(source, { cursorBlink: true })
    const gl = context(canvas)
    const deleteBuffer = vi.spyOn(gl, 'deleteBuffer')
    const deleteTexture = vi.spyOn(gl, 'deleteTexture')
    const deleteProgram = vi.spyOn(gl, 'deleteProgram')
    renderer.setFocused(true)
    clock.flushFrame()
    expect(renderer.hasPendingTimer).toBe(true)
    renderer.dispose()
    renderer.dispose()
    renderer.notifyWrite()

    expect(deleteBuffer).toHaveBeenCalled()
    expect(deleteTexture).toHaveBeenCalled()
    expect(deleteProgram).toHaveBeenCalled()
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
  })
})
