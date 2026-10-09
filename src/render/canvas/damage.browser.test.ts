import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { TestClock } from '../webgl/tests/fixture.js'
import { CanvasRowPainter } from './painter.js'
import { CanvasTerminalRenderer } from './renderer.js'
import { fittedFont } from './tests/font.js'

function expectPixels(actual: Uint8ClampedArray, expected: Uint8ClampedArray): void {
  expect(actual.length).toBe(expected.length)
  expect(actual.findIndex((value, index) => value !== expected[index])).toBe(-1)
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

it.each([1, 1.25, 1.5, 2])(
  'uploads only warm edited pixel columns at DPR %s with exact RGBA',
  async (dpr) => {
    const runtime = await GhosttyRuntime.create()
    cleanups.push(() => runtime.dispose())
    const terminal = runtime.createTerminal({ columns: 40, rows: 4 })
    const state = runtime.createRenderState(terminal)
    const reads = vi.spyOn(state, 'readRows')
    cleanups.push(() => {
      state.dispose()
      terminal.dispose()
    })
    terminal.write('\x1b[?25l' + 'abcdef ghijkl '.repeat(3))
    const font = {
      ...fittedFont(dpr),
      charTop: Math.round(2 * dpr),
      deviceCellWidth: Math.ceil(10 * dpr),
      deviceCharWidth: Math.ceil(10 * dpr),
    }
    const canvas = document.createElement('canvas')
    const clock = new TestClock()
    const options = {
      columns: 40,
      rows: 4,
      font,
      renderState: state,
      rendererMode: 'canvas2d-pixels' as const,
    }
    const paint = vi.spyOn(CanvasRowPainter.prototype, 'paint')
    const renderer = await CanvasTerminalRenderer.create({
      ...options,
      canvas,
      schedulerClock: clock,
    })
    cleanups.push(() => renderer.dispose())
    clock.flushFrame()
    const painter = paint.mock.contexts[0]
    expect(reads.mock.lastCall![0]?.packed).toBe(false)
    expect(paint.mock.calls[0]![0].packed).toBeUndefined()
    expect(paint.mock.calls[0]![0]).toBe(reads.mock.results[0]?.value[0])
    for (const content of ['\x1b[1;8HX', '\x1b[1;9HY']) {
      terminal.write(content)
      renderer.notifyWrite()
      clock.flushFrame()
    }
    const upload = vi.spyOn(canvas.getContext('2d')!, 'putImageData')
    const copy = vi.spyOn(canvas.getContext('2d')!, 'drawImage')
    terminal.write('\x1b[1;10HZ')
    renderer.notifyWrite()
    clock.flushFrame()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]![5]).toBeLessThan(canvas.width / 2)
    const referenceCanvas = document.createElement('canvas')
    const referenceClock = new TestClock()
    const reference = await CanvasTerminalRenderer.create({
      ...options,
      canvas: referenceCanvas,
      schedulerClock: referenceClock,
    })
    cleanups.push(() => reference.dispose())
    const referenceUpload = vi.spyOn(referenceCanvas.getContext('2d')!, 'putImageData')
    referenceClock.flushFrame()
    const rgba = () => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    expectPixels(
      rgba(),
      referenceCanvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
    )
    expectPixels(upload.mock.lastCall![0].data, referenceUpload.mock.lastCall![0].data)
    const packing: (boolean | undefined)[] = []
    for (const content of [
      '\x1b[1;9H\x1b[?25h',
      '\x1b[1;10H',
      '\x1b[?25l\x1b[1;9H ',
      '\x1b[1;1H\x1b[3mitalic f\x1b[0m',
      '\x1b[1;1Hplain Ag',
      '\x1b[1;2HX',
      '\x1b[1;1H\x1b[2m\x1b[38;2;230;70;110mfaint\x1b[0m',
      '\x1b[4;1H\r\nemoji 👩‍💻',
      '\r\nplain again',
      '\x1b[4;3HZ',
      '\x1b[2J\x1b[Hone Ag\r\ntwo 😀\r\nthree faint\r\nfour end',
      '\r\nfive 👩‍💻',
      '\x1b[1T',
      '\x1b[1S',
    ]) {
      terminal.write(content)
      renderer.notifyWrite()
      reference.notifyWrite()
      reference.clearTextureAtlas()
      clock.flushFrame()
      packing.push(reads.mock.lastCall![0]?.packed)
      referenceClock.flushFrame()
      expectPixels(
        rgba(),
        referenceCanvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      )
      expectPixels(upload.mock.lastCall![0].data, referenceUpload.mock.lastCall![0].data)
    }
    expect(packing.every((packed) => packed === false)).toBe(true)
    const styled = paint.mock.calls.filter(
      ([row], index) =>
        paint.mock.contexts[index] === painter && row.cells.some((cell) => cell.foreground),
    )
    expect(styled.length).toBeGreaterThan(0)
    expect(styled.every(([row]) => row.packed === undefined)).toBe(true)
    expect(copy).toHaveBeenCalled()
    expect(upload.mock.calls.slice(-2).every((call) => call[6]! < canvas.height)).toBe(true)
    const acknowledge = vi.spyOn(state, 'acknowledge')
    copy.mockImplementationOnce((...args) => {
      Reflect.apply(CanvasRenderingContext2D.prototype.drawImage, canvas.getContext('2d')!, args)
      throw new TypeError('Injected output transport failure')
    })
    terminal.write('\r\nsix new')
    renderer.notifyWrite()
    expect(() => clock.flushFrame()).toThrow('Injected output transport failure')
    expect(acknowledge).not.toHaveBeenCalled()
    copy.mockClear()
    renderer.notifyWrite()
    reference.notifyWrite()
    reference.clearTextureAtlas()
    clock.flushFrame()
    referenceClock.flushFrame()
    expect(copy).not.toHaveBeenCalled()
    expectPixels(
      rgba(),
      referenceCanvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
    )
    expectPixels(upload.mock.lastCall![0].data, referenceUpload.mock.lastCall![0].data)
  },
)

it('preserves pixel-scroll full-repaint RGBA with an inherited output filter', async () => {
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const arms = await Promise.all(
    [0, 1].map(async () => {
      const terminal = runtime.createTerminal({ columns: 40, rows: 6 })
      const state = runtime.createRenderState(terminal)
      cleanups.push(() => {
        state.dispose()
        terminal.dispose()
      })
      terminal.write(
        '\x1b[?25l' +
          ['zero Ag', 'one Bg', 'two Cg', 'three Dg', 'four Eg', 'five Fg'].join('\r\n'),
      )
      const canvas = document.createElement('canvas')
      const clock = new TestClock()
      const renderer = await CanvasTerminalRenderer.create({
        canvas,
        columns: 40,
        rows: 6,
        font: { ...fittedFont(1), charTop: 2, deviceCellWidth: 10, deviceCharWidth: 10 },
        renderState: state,
        rendererMode: 'canvas2d-pixels',
        schedulerClock: clock,
      })
      cleanups.push(() => renderer.dispose())
      clock.flushFrame()
      return { terminal, state, canvas, clock, renderer }
    }),
  )
  const candidate = arms[0]!
  const reference = arms[1]!
  const output = candidate.canvas.getContext('2d')!
  output.save()
  cleanups.push(() => output.restore())
  output.filter = 'opacity(50%)'
  const acknowledge = vi.spyOn(candidate.state, 'acknowledge')
  const before = { ...candidate.renderer.metrics }
  for (const arm of arms) {
    arm.terminal.write('\x1b[6;1H\r\nnew row')
    arm.renderer.notifyWrite()
  }
  reference.renderer.clearTextureAtlas()
  candidate.clock.flushFrame()
  reference.clock.flushFrame()
  expect(acknowledge).toHaveBeenCalledOnce()
  expect(candidate.renderer.metrics.submittedFrames - before.submittedFrames).toBe(1)
  expect(candidate.renderer.metrics.selfCopies - before.selfCopies).toBe(1)
  expect(output.filter).toBe('opacity(50%)')
  expectPixels(
    output.getImageData(0, 0, candidate.canvas.width, candidate.canvas.height).data,
    reference.canvas
      .getContext('2d')!
      .getImageData(0, 0, reference.canvas.width, reference.canvas.height).data,
  )
})
