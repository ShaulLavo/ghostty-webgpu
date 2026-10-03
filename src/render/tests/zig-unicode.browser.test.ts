import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import {
  zigFrameCursorStyles,
  zigGlyphCollisionFixtures,
  zigUnicodeFixtures,
} from '../../core/tests/zig-frame-fixtures.js'
import { ZigFrameBuilder } from '../../core/zig-frame.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import { defaultRendererTheme } from '../instances/types.js'
import { WebGpuTerminalRenderer, type WebGpuTerminalRendererOptions } from '../renderer.js'
import { WebGlTerminalRenderer } from '../webgl/renderer.js'
import { displayedPixels, fittedFont, TestClock } from '../webgl/tests/fixture.js'

const disposables: (() => void)[] = []
const devices: GPUDevice[] = []
const devicePool: GPUDevice[] = []
const resourceChecks: (() => void)[] = []
let sentinel: GPUDevice
const viewport = { width: window.innerWidth, height: window.innerHeight }
const intrinsicFont = new FontFace(
  'Zig Intrinsic Colors',
  `url(${new URL('./fixtures/intrinsic-colors.ttf', import.meta.url).href})`,
)

beforeAll(async () => {
  await page.viewport(900, 650)
  document.fonts.add(await intrinsicFont.load())
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  expect(adapter).not.toBeNull()
  // Keep Dawn's instance alive between independently owned renderer devices.
  sentinel = await adapter!.requestDevice()
})

afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
  for (const check of resourceChecks.splice(0)) check()
  await Promise.all(devices.splice(0).map((device) => device.queue.onSubmittedWorkDone()))
  vi.restoreAllMocks()
})

afterAll(async () => {
  document.fonts.delete(intrinsicFont)
  const losses = devicePool.map((device) => device.lost)
  for (const device of devicePool) device.destroy()
  await Promise.all(losses)
  if (sentinel) {
    const lost = sentinel.lost
    sentinel.destroy()
    await lost
  }
  await page.viewport(viewport.width, viewport.height)
})

async function createDevice(): Promise<GPUDevice> {
  let device = devicePool[devices.length]
  if (!device) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    expect(adapter).not.toBeNull()
    device = await adapter!.requestDevice()
    devicePool.push(device)
  }
  // The injected factory owns the pooled devices; renderer buffers and contexts still tear down.
  vi.spyOn(device, 'destroy').mockImplementation(() => {})
  const createBuffer = device.createBuffer.bind(device)
  vi.spyOn(device, 'createBuffer').mockImplementation((descriptor) => {
    const buffer = createBuffer(descriptor)
    const destroy = vi.spyOn(buffer, 'destroy')
    resourceChecks.push(() => expect(destroy).toHaveBeenCalledOnce())
    return buffer
  })
  const createTexture = device.createTexture.bind(device)
  vi.spyOn(device, 'createTexture').mockImplementation((descriptor) => {
    const texture = createTexture(descriptor)
    const destroy = vi.spyOn(texture, 'destroy')
    resourceChecks.push(() => expect(destroy).toHaveBeenCalledOnce())
    return texture
  })
  devices.push(device)
  return device
}

async function sourceFixture(content: string) {
  const runtime = await GhosttyRuntime.create()
  disposables.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
  const state = runtime.createRenderState(terminal)
  terminal.write(`\x1b[?25l\x1b[?2027h${content}`)
  return { runtime, state, terminal }
}

async function parityFixture(
  backend: 'webgpu' | 'webgl2',
  content: string,
  options: Partial<WebGpuTerminalRendererOptions> = {},
) {
  const fixture = document.createElement('div')
  document.body.append(fixture)
  disposables.push(() => fixture.remove())
  const Renderer = backend === 'webgpu' ? WebGpuTerminalRenderer : WebGlTerminalRenderer
  const create = async (zigFrame: boolean) => {
    const source = await sourceFixture(content)
    const label = document.createElement('p')
    label.textContent = `${backend} / ${zigFrame ? 'Zig' : 'JavaScript'}`
    const canvas = document.createElement('canvas')
    const background = options.theme?.background ?? defaultRendererTheme.background
    canvas.style.backgroundColor = `rgb(${background.r}, ${background.g}, ${background.b})`
    fixture.append(label, canvas)
    const clock = new TestClock()
    const unconfigure =
      backend === 'webgpu' ? vi.spyOn(canvas.getContext('webgpu')!, 'unconfigure') : undefined
    const renderer = await Renderer.create({
      canvas,
      columns: 40,
      rows: 3,
      renderState: source.state,
      font: fittedFont(),
      schedulerClock: clock,
      deviceFactory: createDevice,
      ...options,
      zigFrame,
    })
    disposables.push(() => {
      renderer.dispose()
      expect(clock.frames.size).toBe(0)
      expect(clock.timers.size).toBe(0)
      if (unconfigure) expect(unconfigure).toHaveBeenCalledOnce()
      if (backend === 'webgl2')
        canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
    })
    return { ...source, canvas, clock, renderer }
  }
  const native = await create(true)
  const js = await create(false)
  const readRows = vi.spyOn(native.state, 'readRows')
  const builds = vi.spyOn(ZigFrameBuilder.prototype, 'build')
  return { fixture, native, js, readRows, builds }
}

type Pair = Awaited<ReturnType<typeof parityFixture>>

function flushPair(pair: Pair): void {
  for (const side of [pair.native, pair.js]) {
    for (let attempt = 0; attempt < 8 && side.clock.frames.size > 0; attempt += 1)
      side.clock.flushFrame()
    expect(side.clock.frames.size).toBe(0)
    expect(side.clock.timers.size).toBe(0)
  }
}

function writePair(pair: Pair, content: string): void {
  for (const side of [pair.native, pair.js]) {
    side.terminal.write(content)
    side.renderer.notifyWrite()
  }
  flushPair(pair)
}

async function expectParity(pair: Pair, submitted: number): Promise<Uint8Array> {
  expect(pair.native.renderer.metrics.submittedFrames).toBe(submitted)
  expect(pair.native.renderer.metrics.zigFrames).toBe(submitted)
  expect(pair.native.renderer.metrics.jsFallbackFrames).toBe(0)
  expect(pair.js.renderer.metrics.zigFrames).toBe(0)
  expect(pair.readRows).not.toHaveBeenCalled()
  const native = await displayedPixels(pair.native.canvas)
  const js = await displayedPixels(pair.js.canvas)
  expect(native.byteLength).toBe(js.byteLength)
  const firstDifference = native.findIndex((value, index) => value !== js[index])
  expect(firstDifference, 'Scheduled compositor pixels match without capture redraw').toBe(-1)
  expect(pair.native.renderer.hasPendingFrame).toBe(false)
  return native
}

function cleanRowRecords(builder: ZigFrameBuilder) {
  const cells = builder.cellData
  const glyphs = builder.glyphData
  return [0, 2].map((row) => ({
    cells: new Uint8Array(cells.buffer, cells.byteOffset + row * 40 * 64, 40 * 64).slice(),
    glyphs: new Uint8Array(glyphs.buffer, glyphs.byteOffset + row * 40 * 96, 40 * 96).slice(),
  }))
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  describe(`${backend} Zig Unicode compositor parity`, () => {
    it.each([...zigUnicodeFixtures, ...zigGlyphCollisionFixtures])(
      'submits $name entirely through Zig',
      async ({ content }) => {
        const pair = await parityFixture(backend, content)
        flushPair(pair)
        await expectParity(pair, 1)
        expect(pair.builds.mock.results.at(-1)?.value).toBe(0)
        const glyphs = pair.native.state
          .readRows()[0]!
          .cells.filter((cell) => cell.text.trim().length > 0 && !cell.continuation)
        expect(glyphs.length).toBeGreaterThan(0)
      },
    )

    it.each(zigFrameCursorStyles)('matches a %s cursor on a wide head and tail', async (style) => {
      const pair = await parityFixture(backend, '\x1b[?25h界é👩‍💻\x1b[1;1H')
      for (const side of [pair.native, pair.js]) side.renderer.setInactiveCursorStyle(style)
      flushPair(pair)
      const head = await expectParity(pair, 1)
      writePair(pair, '\x1b[1;2H')
      expect(pair.native.state.readCursor().viewport).toMatchObject({ x: 1, wideTail: true })
      const tailSubmissions = backend === 'webgpu' ? 2 : 1
      const tail = await expectParity(pair, tailSubmissions)
      expect(tail).toEqual(head)
      writePair(pair, '\x1b[2;1H')
      const away = await expectParity(pair, tailSubmissions + 1)
      expect(away).not.toEqual(tail)
    })

    it('matches selecting and clearing wide, combining and ZWJ glyphs without terminal writes', async () => {
      const pair = await parityFixture(backend, '界é👩‍💻\r\nsecond')
      flushPair(pair)
      const before = await expectParity(pair, 1)
      for (const side of [pair.native, pair.js]) {
        expect(side.terminal.selectAll()).toBe(true)
        side.renderer.refreshRows(0, 2)
      }
      flushPair(pair)
      const selected = await expectParity(pair, 2)
      expect(selected).not.toEqual(before)
      expect(pair.native.terminal.getSelection()).toContain('界é👩‍💻')
      for (const side of [pair.native, pair.js]) {
        side.terminal.clearSelection()
        side.renderer.refreshRows(0, 2)
      }
      flushPair(pair)
      expect(await expectParity(pair, 3)).toEqual(before)
    })

    it.each([0, -1])(
      'keeps clean rows intact through wide missing-glyph retry and continuation erasure at baseline offset %i',
      async (baselineOffset) => {
        const font = fittedFont()
        const pair = await parityFixture(backend, 'first\r\nsecond\r\nlast', {
          font: { ...font, deviceBaseline: font.deviceBaseline + baselineOffset },
        })
        flushPair(pair)
        const before = await expectParity(pair, 1)
        const builder = pair.builds.mock.contexts.at(-1) as ZigFrameBuilder
        const cleanRecords = cleanRowRecords(builder)
        pair.builds.mockClear()
        const uploaded = pair.native.renderer.metrics.uploadedBytes
        writePair(pair, '\x1b[2;1H\x1b[31;44m界é👩‍💻\x1b[0m')
        expect(pair.builds.mock.results.map((result) => result.value)).toEqual([2, 0])
        expect(pair.native.renderer.metrics.uploadedBytes - uploaded).toBe(2 * 40 * (64 + 96))
        const changed = await expectParity(pair, 2)
        expect(changed).not.toEqual(before)
        // Glyph ink can cross screen-row edges; clean logical rows retain their exact records.
        expect(cleanRowRecords(builder)).toEqual(cleanRecords)
        writePair(pair, '\x1b[2;2H\x1b[33mX\x1b[0m')
        const erased = await expectParity(pair, 3)
        expect(erased).not.toEqual(changed)
        expect(cleanRowRecords(builder)).toEqual(cleanRecords)
      },
    )

    it('matches intrinsic color glyph brush identity, selection and cursor recoloring', async () => {
      const fitted = fittedFont(24, 48, 32)
      const font = { ...fitted, settings: { ...fitted.settings, family: '"Zig Intrinsic Colors"' } }
      const rasterizer = new CanvasGlyphRasterizer({ font })
      expect(
        rasterizer.rasterize({
          cellSpan: 1,
          foreground: { r: 0, g: 255, b: 255 },
          italic: false,
          text: 'X',
          weight: 'normal',
        })?.kind,
      ).toBe('color')
      const pair = await parityFixture(backend, '\x1b[36mXWBG\x1b[35mX\x1b[0m', { font })
      flushPair(pair)
      const before = await expectParity(pair, 1)
      for (const side of [pair.native, pair.js]) {
        side.terminal.selectAll()
        side.renderer.refreshRows(0, 2)
      }
      flushPair(pair)
      expect(await expectParity(pair, 2)).not.toEqual(before)
      for (const side of [pair.native, pair.js]) {
        side.terminal.clearSelection()
        side.renderer.setInactiveCursorStyle('block')
      }
      writePair(pair, '\x1b[?25h\x1b[1;1H')
      expect(await expectParity(pair, 3)).not.toEqual(before)
    })

    it('keeps one grayscale descriptor through 1024 truecolor brushes with zero fallback', async () => {
      const pair = await parityFixture(backend, 'A')
      flushPair(pair)
      for (let index = 0; index < 1024; index += 1) {
        writePair(pair, `\x1b[1;1H\x1b[38;2;${index & 255};${index >>> 8};91mA`)
        const builder = pair.builds.mock.contexts.at(-1) as ZigFrameBuilder
        expect(builder.glyphCount).toBe(1)
        expect(builder.glyphIndexRebuilds).toBe(0)
        expect(pair.native.renderer.metrics.jsFallbackFrames).toBe(0)
      }
      await expectParity(pair, 1025)
    })

    it('records a visible Unicode differential specimen', async () => {
      const pair = await parityFixture(backend, 'ASCII café ┌─┬─┐ \r\n界漢字 é ä́\r\n👩‍💻 👨‍👩‍👧‍👦 ❤️ 🏳️‍🌈')
      flushPair(pair)
      await expectParity(pair, 1)
      await page.screenshot({
        element: pair.fixture,
        path: `../../../.artifacts/zig-unicode-${backend}.png`,
        scale: 'css',
      })
    })
  })
}
