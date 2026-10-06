import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import { fitTerminalFont } from '../../dom/fit.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import { TestClock } from '../webgl/tests/fixture.js'
import { CanvasTerminalRenderer } from './renderer.js'
import { ComposeKernel } from './kernel.js'
import { CanvasRowPainter } from './painter.js'
import { StampTarget } from './stamp-target.js'
import { fittedFont } from './tests/font.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

async function native(content: string, columns = 24, rows = 4) {
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns, rows })
  const state = runtime.createRenderState(terminal)
  terminal.write(content)
  state.update()
  return { terminal, state }
}

it.each([1, 2])(
  'composes real native owners at DPR %s with warm zero browser raster work',
  async (dpr) => {
    const { state } = await native(
      '\x1b[?25l\x1b[?2027lÁ界👩‍💻\r\n\x1b[?2027h👩‍💻\x1b[1;3;2m faint\x1b[0m\r\n\x1b[4:3mwave\x1b[4:4mdots\x1b[4:5mdash\x1b[0m',
    )
    const font = fittedFont(dpr)
    const canvas = document.createElement('canvas')
    canvas.width = 24 * font.deviceCellWidth
    canvas.height = 4 * font.deviceCellHeight
    const output = canvas.getContext('2d')!
    const kernel = await ComposeKernel.create()
    const target = new StampTarget(kernel, output)
    cleanups.push(() => target.dispose())
    target.resize(canvas.width, canvas.height, font.deviceCellHeight)
    target.setFont(font)
    const painter = new CanvasRowPainter(
      target,
      font,
      canonicalRendererTheme(mergeRendererTheme({ minimumContrast: 1 })),
    )
    painter.resetContext(font)
    const draw = () => {
      for (const row of state.readRows()) {
        target.beginRow(row.y)
        painter.paint(row, undefined, canvas.width)
        target.finishRow(row.y)
      }
      target.present()
    }
    const rasterText = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, 'fillText')
    const readback = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, 'getImageData')
    const submit = vi.spyOn(output, 'putImageData')
    const glyphs = vi.spyOn(target, 'glyph')
    draw()
    expect(
      glyphs.mock.calls
        .filter(([input]) => input.text.includes('👩') || input.text === '💻')
        .map(([input, x, y]) => [input.text, input.cellSpan, x, y]),
    ).toEqual([
      ['👩‍', 2, 30 * dpr, 0],
      ['💻', 2, 50 * dpr, 0],
      ['👩‍💻', 2, 0, 20 * dpr],
    ])
    expect(rasterText.mock.calls.length).toBeGreaterThan(0)
    expect(readback.mock.calls.length).toBeGreaterThan(0)
    const first = target.frame.getImage()
    expect(first.data.buffer).toBe(kernel.memory.buffer)
    const exact = first.data.slice()
    const cache = { ...target.cache.metrics }
    rasterText.mockClear()
    readback.mockClear()
    submit.mockClear()
    draw()
    expect(rasterText).not.toHaveBeenCalled()
    expect(readback).not.toHaveBeenCalled()
    expect(target.cache.metrics.stampCopies).toBe(cache.stampCopies)
    expect(target.cache.metrics.stampCopiedBytes).toBe(cache.stampCopiedBytes)
    expect(target.frame.getImage().data).toEqual(exact)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0].data.buffer).toBe(kernel.memory.buffer)
    expect(target.frame.metrics.copiedFrameBytes).toBe(0)
    expect(target.metrics.rowCopyBytes).toBe(0)
    document.body.append(canvas)
    cleanups.push(() => canvas.remove())
    await page.screenshot({
      element: canvas,
      path: `../../../.artifacts/canvas-packed-dpr-${dpr}.png`,
      scale: 'css',
    })
  },
)

it('keeps default fillText free of compose downloads and explicit pixels on the same native state', async () => {
  const { state } = await native('\x1b[?25lhello 界')
  const options = { columns: 24, rows: 4, font: fittedFont(), renderState: state }
  const fetches = vi.spyOn(globalThis, 'fetch')
  const plainClock = new TestClock()
  const plain = await CanvasTerminalRenderer.create({
    ...options,
    canvas: document.createElement('canvas'),
    schedulerClock: plainClock,
  })
  cleanups.push(() => plain.dispose())
  plainClock.flushFrame()
  expect(plain.canvasPaintMode).toBe('fill-text')
  expect(fetches.mock.calls.some(([url]) => String(url).includes('canvas-compose'))).toBe(false)
  const pixelClock = new TestClock()
  const pixels = await CanvasTerminalRenderer.create({
    ...options,
    canvas: document.createElement('canvas'),
    schedulerClock: pixelClock,
    rendererMode: 'canvas2d-pixels',
  })
  cleanups.push(() => pixels.dispose())
  pixelClock.flushFrame()
  expect(pixels.canvasPaintMode).toBe('pixels')
  expect(fetches.mock.calls.filter(([url]) => String(url).includes('canvas-compose'))).toHaveLength(
    1,
  )
})

it('matches a fresh packed repaint after scroll, cursor, theme, DPR and atlas invalidation', async () => {
  const { state, terminal } = await native('\x1b[?25lone 界\r\ntwo é\r\nthree 😀\r\nfour')
  const font = fittedFont()
  const clock = new TestClock()
  const canvas = document.createElement('canvas')
  const renderer = await CanvasTerminalRenderer.create({
    canvas,
    columns: 24,
    rows: 4,
    font,
    renderState: state,
    schedulerClock: clock,
    rendererMode: 'canvas2d-pixels',
    theme: { minimumContrast: 1 },
  })
  cleanups.push(() => renderer.dispose())
  clock.flushFrame()
  const check = async (currentFont = font, theme = { minimumContrast: 1 }) => {
    const referenceCanvas = document.createElement('canvas')
    const referenceClock = new TestClock()
    const reference = await CanvasTerminalRenderer.create({
      canvas: referenceCanvas,
      columns: 24,
      rows: 4,
      font: currentFont,
      renderState: state,
      schedulerClock: referenceClock,
      rendererMode: 'canvas2d-pixels',
      theme,
    })
    try {
      referenceClock.flushFrame()
      expect(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data).toEqual(
        referenceCanvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      )
    } finally {
      reference.dispose()
    }
  }
  terminal.write('\r\nfive 👩‍💻')
  renderer.notifyWrite()
  clock.flushFrame()
  expect(renderer.pixelMetrics.bufferMoves).toBeGreaterThan(0)
  await check()
  terminal.write('\x1b[2;3H\x1b[?25h')
  renderer.notifyWrite()
  clock.flushFrame()
  await check()
  renderer.clearTextureAtlas()
  clock.flushFrame()
  await check()
  const theme = { minimumContrast: 1, foreground: { r: 19, g: 70, b: 200 } }
  renderer.setTheme(theme)
  clock.flushFrame()
  await check(font, theme)
  renderer.setFont(fittedFont(2))
  clock.flushFrame()
  await check(fittedFont(2), theme)
  expect(renderer.hasPendingFrame).toBe(false)
  expect(renderer.hasPendingTimer).toBe(false)
})

it('retains native scheduled damage when a pixel submission fails', async () => {
  const { state, terminal } = await native('\x1b[?25lhello')
  const clock = new TestClock()
  const canvas = document.createElement('canvas')
  const renderer = await CanvasTerminalRenderer.create({
    canvas,
    columns: 24,
    rows: 4,
    font: fittedFont(),
    renderState: state,
    schedulerClock: clock,
    rendererMode: 'canvas2d-pixels',
  })
  cleanups.push(() => renderer.dispose())
  clock.flushFrame()
  terminal.write('\x1b[2;1Hnew text')
  renderer.notifyWrite()
  const output = canvas.getContext('2d')!
  const failure = vi.spyOn(output, 'putImageData').mockImplementationOnce(() => {
    throw new TypeError('external canvas upload failure')
  })
  expect(() => clock.flushFrame()).toThrow('external canvas upload failure')
  failure.mockRestore()
  renderer.schedule()
  clock.flushFrame()
  expect(renderer.hasPendingFrame).toBe(false)
  expect(renderer.pixelMetrics.uploadedRegions).toBeGreaterThan(1)
})

it('rebuilds pixels and native font state after Canvas restoration events', async () => {
  const { state } = await native('\x1b[?25lrestore 界')
  const clock = new TestClock()
  const canvas = document.createElement('canvas')
  const renderer = await CanvasTerminalRenderer.create({
    canvas,
    columns: 24,
    rows: 4,
    font: fittedFont(),
    renderState: state,
    schedulerClock: clock,
    rendererMode: 'canvas2d-pixels',
  })
  cleanups.push(() => renderer.dispose())
  clock.flushFrame()
  const output = canvas.getContext('2d')!
  const expected = output.getImageData(0, 0, canvas.width, canvas.height).data
  canvas.dispatchEvent(new Event('contextlost', { cancelable: true }))
  renderer.refreshRows(0, 3)
  expect(() => clock.flushFrame()).toThrow('awaiting restoration')
  output.reset()
  canvas.dispatchEvent(new Event('contextrestored'))
  clock.flushFrame()
  expect(output.getImageData(0, 0, canvas.width, canvas.height).data).toEqual(expected)
})

it('rejects framebuffer reallocation during synchronous presentation and disposes its alias', async () => {
  const canvas = document.createElement('canvas')
  const output = canvas.getContext('2d')!
  const kernel = await ComposeKernel.create()
  const target = new StampTarget(kernel, output)
  cleanups.push(() => target.dispose())
  target.resize(24, 20, 20)
  const submit = output.putImageData.bind(output)
  vi.spyOn(output, 'putImageData').mockImplementation((...args) => {
    expect(() => target.resize(48, 20, 20)).toThrow('presentation')
    expect(() => target.dispose()).toThrow('presentation')
    submit(...args)
  })
  target.present()
  expect(target.frame.getImage().data.buffer).toBe(kernel.memory.buffer)
  target.dispose()
  expect(() => target.frame.getImage()).toThrow('unavailable')
})

it.each([
  ['canvas2d-fill-text', 0],
  ['canvas2d-fill-text', -1],
  ['canvas2d-pixels', 0],
  ['canvas2d-pixels', -1],
] as const)(
  'settles a clipped family owner in a tiny %s viewport with letter spacing %s',
  async (rendererMode, letterSpacing) => {
    const { state, terminal } = await native('\x1b[?25l\x1b[?2027h👨‍👩‍👧‍👦', 2, 1)
    const font = fitTerminalFont(
      document,
      {
        family: 'monospace',
        size: 16,
        weight: 400,
        boldWeight: 700,
        lineHeight: 1,
        letterSpacing,
      },
      1,
    )
    const canvas = document.createElement('canvas')
    const clock = new TestClock()
    let frames = 0
    const renderer = await CanvasTerminalRenderer.create({
      canvas,
      columns: 2,
      rows: 1,
      font,
      renderState: state,
      schedulerClock: clock,
      rendererMode,
      theme: {
        background: { r: 0, g: 0, b: 0 },
        foreground: { r: 255, g: 255, b: 255 },
        minimumContrast: 1,
      },
      onFrame: () => {
        frames += 1
      },
    })
    cleanups.push(() => renderer.dispose())
    expect(() => clock.flushFrame()).not.toThrow()
    expect(frames).toBe(1)
    expect(renderer.hasPendingFrame).toBe(false)
    const output = canvas.getContext('2d')!
    const first = output.getImageData(0, 0, canvas.width, canvas.height).data
    expect(first.some((channel, index) => index % 4 !== 3 && channel > 0)).toBe(true)
    const readback = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, 'getImageData')
    renderer.refreshRows(0, 0)
    clock.flushFrame()
    expect(frames).toBe(2)
    expect(renderer.hasPendingFrame).toBe(false)
    expect(output.getImageData(0, 0, canvas.width, canvas.height).data).toEqual(first)
    expect(readback).not.toHaveBeenCalled()
    readback.mockRestore()
    for (const columns of [8, 2]) {
      terminal.resize({ columns, rows: 1 })
      expect(() => renderer.resize({ columns, rows: 1 })).not.toThrow()
      expect(renderer.hasPendingFrame).toBe(false)
    }
    expect(frames).toBe(4)
    expect(output.getImageData(0, 0, canvas.width, canvas.height).data).toEqual(first)
    document.body.append(canvas)
    cleanups.push(() => canvas.remove())
    await page.screenshot({
      element: canvas,
      path: `../../../.artifacts/canvas-clipped-${rendererMode}-${letterSpacing}.png`,
      scale: 'css',
    })
  },
)

it('keeps packed glyph variants distinct and clears font-scoped stamps across memory growth', async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 240
  canvas.height = 40
  const kernel = await ComposeKernel.create()
  const target = new StampTarget(kernel, canvas.getContext('2d')!)
  cleanups.push(() => target.dispose())
  target.resize(canvas.width, canvas.height, 20)
  target.setFont(fittedFont())
  target.fillStyle = 'rgb(220, 220, 220)'
  const common = {
    cellSpan: 1,
    foreground: { r: 220, g: 220, b: 220 },
    italic: false,
    text: 'W',
    weight: 'normal',
  } as const
  const variants = [
    common,
    { ...common, cellSpan: 2 },
    { ...common, italic: true },
    { ...common, weight: 'bold' as const },
    { ...common, text: 'M' },
    { ...common, foreground: { r: 19, g: 70, b: 200 } },
    { ...common, text: '👩‍💻' },
    { ...common, text: 'é' },
    { ...common, text: '["W",1]' },
  ]
  for (const input of variants) target.glyph(input, 0, 0)
  const cold = { ...target.cache.metrics }
  expect(cold.rasterCalls).toBe(variants.length)
  expect(cold.residentEntries).toBe(variants.length)
  const first = target.frame.getImage()
  const owned = first.data.slice()
  const memory = first.data.buffer
  kernel.memory.grow(1)
  expect(memory.byteLength).toBe(0)
  expect(owned.some((channel) => channel !== 0)).toBe(true)
  for (const input of variants) target.glyph(input, 0, 0)
  expect(target.cache.metrics.rasterCalls).toBe(cold.rasterCalls)
  expect(target.cache.metrics.stampCopies).toBe(cold.stampCopies)
  expect(target.cache.metrics.hits - cold.hits).toBe(variants.length)
  expect(target.frame.getImage().data.buffer).toBe(kernel.memory.buffer)
  const nextFont = { ...fittedFont(), settings: { ...fittedFont().settings, size: 18 } }
  target.setFont(nextFont)
  expect(target.cache.metrics.residentEntries).toBe(0)
  for (const input of variants) target.glyph(input, 0, 0)
  expect(target.cache.metrics.rasterCalls - cold.rasterCalls).toBe(variants.length)
  expect(target.cache.metrics.residentEntries).toBe(variants.length)
})
