import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import { Terminal } from '../../dom/terminal.js'
import type { WebGpuTerminalRendererOptions } from '../renderer.js'
import { TestClock } from '../webgl/tests/fixture.js'
import { CanvasTerminalRenderer } from './renderer.js'

function expectScrollReuse(
  renderer: CanvasTerminalRenderer,
  before: CanvasTerminalRenderer['metrics'],
): void {
  expect(renderer.metrics.repaintedRows - before.repaintedRows).toBe(1)
  expect(renderer.metrics.submittedFrames - before.submittedFrames).toBe(1)
  if (renderer.canvasPaintMode === 'pixels') {
    expect(renderer.metrics.bufferMoves - before.bufferMoves).toBe(1)
    expect(renderer.metrics.movedRows - before.movedRows).toBe(5)
  }
  expect(renderer.metrics.selfCopies - before.selfCopies).toBe(1)
  expect(renderer.metrics.copiedRows - before.copiedRows).toBe(5)
}

async function expectFullRepaint(
  renderer: CanvasTerminalRenderer,
  options: WebGpuTerminalRendererOptions,
): Promise<void> {
  const canvas = document.createElement('canvas')
  const clock = new TestClock()
  const reference = await CanvasTerminalRenderer.create({
    ...options,
    canvas,
    schedulerClock: clock,
  })
  try {
    clock.flushFrame()
    const actual = options.canvas.getContext('2d')
    const expected = canvas.getContext('2d')
    if (!actual || !expected) throw new TypeError('Expected Canvas 2D contexts')
    expect(actual.getImageData(0, 0, canvas.width, canvas.height).data).toEqual(
      expected.getImageData(0, 0, canvas.width, canvas.height).data,
    )
    expect(reference.canvasPaintMode).toBe(renderer.canvasPaintMode)
  } finally {
    reference.dispose()
  }
}

it.each(['canvas2d-fill-text', 'canvas2d-pixels'] as const)(
  'reuses rows after mounted public Terminal output scroll (%s)',
  async (rendererMode) => {
    const runtime = await GhosttyRuntime.create()
    const host = document.createElement('div')
    document.body.append(host)
    const clock = new TestClock()
    let mounted:
      | { renderer: CanvasTerminalRenderer; options: WebGpuTerminalRendererOptions }
      | undefined
    const terminal = await Terminal.create({
      runtime: { kind: 'borrowed', runtime },
      accessibility: false,
      appearance: {
        grid: { columns: 32, rows: 6 },
        cursor: { blink: false },
        font: { family: 'monospace', size: 16 },
      },
      rendererFactory: async (options) => {
        const configured = { ...options, rendererMode, schedulerClock: clock }
        const renderer = await CanvasTerminalRenderer.create(configured)
        mounted = { renderer, options: configured }
        return renderer
      },
    })
    try {
      await terminal.open(host)
      await document.fonts.ready
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      if (!mounted) throw new TypeError('Expected a mounted Canvas renderer')
      const { renderer, options } = mounted
      const scroll = vi.spyOn(renderer, 'notifyScroll')
      const read = vi.spyOn(options.renderState, 'readRows')
      terminal.write(
        '\x1b[?25l' + Array.from({ length: 6 }, (_, row) => `${row} alpha 界 é 😀`).join('\r\n'),
      )
      clock.flushFrame()
      await expectFullRepaint(renderer, options)
      for (let row = 6; row < 10; row += 1) {
        const before = { ...renderer.metrics }
        read.mockClear()
        scroll.mockClear()
        terminal.write(`\r\n${row} alpha 界 é 😀`)
        expect(scroll).toHaveBeenCalledOnce()
        clock.flushFrame()
        expect(read).toHaveBeenCalledOnce()
        expect(read.mock.calls[0]?.[0]).toEqual({
          packed: rendererMode === 'canvas2d-fill-text',
        })
        expectScrollReuse(renderer, before)
        await expectFullRepaint(renderer, options)
      }
      await page.screenshot({
        element: host,
        path: `../../../.artifacts/canvas-mounted-scroll-${rendererMode}-parity0.png`,
      })
    } finally {
      terminal.dispose()
      runtime.dispose()
      host.remove()
      vi.restoreAllMocks()
    }
  },
)
