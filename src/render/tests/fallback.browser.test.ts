import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasTerminalRenderer } from '../canvas/renderer.js'
import { WebGpuUnavailableError, type WebGpuTerminalRendererOptions } from '../renderer.js'
import { createCompatibleTerminalRenderer, type CompatibleTerminalRenderer } from '../selector.js'
import { TestClock, TestRenderState, cell, fittedFont, rgb, row } from '../webgl/tests/fixture.js'

const canvases = new Set<HTMLCanvasElement>()
const renderers = new Set<CompatibleTerminalRenderer>()

afterEach(() => {
  for (const renderer of renderers) renderer.dispose()
  for (const canvas of canvases) canvas.remove()
  renderers.clear()
  canvases.clear()
  vi.restoreAllMocks()
})

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  canvases.add(canvas)
  return canvas
}

async function fixture(
  source: TestRenderState,
  overrides: Partial<WebGpuTerminalRendererOptions> = {},
  signal?: AbortSignal,
) {
  const canvas = createCanvas()
  const clock = new TestClock()
  let currentCanvas = canvas
  const replaceCanvas = vi.fn(() => {
    const replacement = createCanvas()
    currentCanvas.replaceWith(replacement)
    currentCanvas = replacement
    return replacement
  })
  const renderer = await createCompatibleTerminalRenderer(
    {
      canvas,
      columns: source.rows[0]?.cells.length ?? 1,
      deviceFactory: () => Promise.reject(new WebGpuUnavailableError('api', 'No WebGPU')),
      font: fittedFont(),
      renderState: source,
      replaceCanvas,
      rows: source.rows.length,
      schedulerClock: clock,
      ...overrides,
    },
    signal,
  )
  renderers.add(renderer)
  return { canvas, clock, currentCanvas: () => currentCanvas, renderer, replaceCanvas }
}

async function loseContext(canvas: HTMLCanvasElement): Promise<void> {
  const gl = canvas.getContext('webgl2')
  const extension = gl?.getExtension('WEBGL_lose_context')
  if (!extension) throw new Error('Browser requires WebGL context loss support')
  const lost = new Promise((resolve) =>
    canvas.addEventListener('webglcontextlost', resolve, { once: true }),
  )
  extension.loseContext()
  await lost
}

function pixels(canvas: HTMLCanvasElement, x: number, y: number): readonly number[] {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Fallback did not acquire Canvas2D')
  return [...context.getImageData(x, y, 1, 1).data]
}

describe('managed renderer fallback', () => {
  it('replaces a lost WebGL canvas once and paints pending writes through the original callback', async () => {
    const source = new TestRenderState([row(0, [cell(0, { background: rgb(255, 0, 0) })])])
    const onFrame = vi.fn()
    const { canvas, clock, currentCanvas, renderer, replaceCanvas } = await fixture(source, {
      onFrame,
    })
    clock.flushFrame()
    expect(renderer.backend).toBe('webgl2')
    source.replaceRow(0, [cell(0, { background: rgb(0, 255, 0) })])
    await loseContext(canvas)
    await vi.waitFor(() => expect(renderer.backend).toBe('canvas2d'))
    clock.flushFrame()

    expect(replaceCanvas).toHaveBeenCalledOnce()
    expect(canvas.isConnected).toBe(false)
    expect(pixels(currentCanvas(), 8, 12)).toEqual([0, 255, 0, 255])
    expect(source.acknowledgements).toBe(2)
    expect(onFrame).toHaveBeenCalledTimes(2)
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
    canvas.dispatchEvent(new Event('webglcontextlost'))
    renderer.notifyWrite()
    clock.flushFrame()
    expect(replaceCanvas).toHaveBeenCalledOnce()
  })

  it('applies changes received during replacement before drawing and preserves hidden/focus state', async () => {
    const source = new TestRenderState([row(0, [cell(0), cell(1, { text: '█' })])])
    source.cursor = {
      blinking: true,
      passwordInput: false,
      style: 'block',
      viewport: { wideTail: false, x: 0, y: 0 },
      visible: true,
    }
    const { canvas, clock, currentCanvas, renderer } = await fixture(source)
    renderer.setFocused(true)
    clock.flushFrame()
    const createCanvasRenderer = CanvasTerminalRenderer.create.bind(CanvasTerminalRenderer)
    vi.spyOn(CanvasTerminalRenderer, 'create').mockImplementation(async (options) => {
      const replacement = await createCanvasRenderer(options)
      source.replaceRow(1, [cell(0, { background: rgb(0, 0, 255) }), cell(1)])
      renderer.setFont(fittedFont(20, 30, 24))
      renderer.resize({ columns: 2, rows: 2 })
      renderer.setTheme({ cursor: rgb(255, 0, 0), foreground: rgb(0, 255, 0) })
      renderer.setCursorBlinkEnabled(true)
      renderer.setFocused(false)
      renderer.setInactiveCursorStyle('none')
      renderer.setDocumentVisible(false)
      return replacement
    })
    await loseContext(canvas)
    await vi.waitFor(() => expect(renderer.backend).toBe('canvas2d'))

    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
    expect(source.acknowledgements).toBe(1)
    renderer.setDocumentVisible(true)
    clock.flushFrame()
    const replacement = currentCanvas()
    expect([replacement.width, replacement.height]).toEqual([40, 60])
    expect(pixels(replacement, 10, 15)).toEqual([0, 0, 0, 0])
    expect(pixels(replacement, 30, 15)).toEqual([0, 255, 0, 255])
    expect(pixels(replacement, 10, 45)).toEqual([0, 0, 255, 255])
    expect(clock.timers.size).toBe(0)
    renderer.setFocused(true)
    clock.flushFrame()
    expect(pixels(replacement, 10, 15)).toEqual([255, 0, 0, 255])
    expect(clock.timers.size).toBe(1)
  })

  it.each(['dispose', 'abort'] as const)(
    'disposes Canvas2D completing after %s and leaves no scheduled work',
    async (operation) => {
      const controller = new AbortController()
      const source = new TestRenderState([row(0, [cell(0)])])
      const { canvas, clock, renderer } = await fixture(source, {}, controller.signal)
      clock.flushFrame()
      const createCanvasRenderer = CanvasTerminalRenderer.create.bind(CanvasTerminalRenderer)
      const dispose = vi.spyOn(CanvasTerminalRenderer.prototype, 'dispose')
      vi.spyOn(CanvasTerminalRenderer, 'create').mockImplementation(async (options) => {
        const replacement = await createCanvasRenderer(options)
        if (operation === 'abort') controller.abort()
        if (operation === 'dispose') renderer.dispose()
        return replacement
      })
      await loseContext(canvas)
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())

      expect(source.acknowledgements).toBe(1)
      expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
      renderer.notifyWrite()
      expect(clock.frames.size).toBe(0)
    },
  )

  it('reports a failed replacement once without retrying or leaving scheduled work', async () => {
    const source = new TestRenderState([row(0, [cell(0)])])
    const error = new Error('Replacement failed')
    const onError = vi.fn()
    const replaceCanvas = vi.fn(() => {
      throw error
    })
    const { canvas, clock, renderer } = await fixture(source, { onError, replaceCanvas })
    clock.flushFrame()
    await loseContext(canvas)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error))
    renderer.notifyWrite()
    renderer.schedule()

    expect(replaceCanvas).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
  })
})
