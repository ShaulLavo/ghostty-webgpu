import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import { ZigFrameBuilder } from '../../core/zig-frame.js'
import { CanvasGlyphRasterizer } from '../../render/atlas/canvas-rasterizer.js'
import { defaultRendererTheme } from '../../render/instances/types.js'
import { WebGpuTerminalRenderer } from '../../render/renderer.js'
import { WebGlTerminalRenderer } from '../../render/webgl/renderer.js'
import { displayedPixels, fittedFont, TestClock } from '../../render/webgl/tests/fixture.js'
import { TerminalSession } from '../../term/session.js'
import { createGhosttyWebGpuTerminalFromSession } from '../terminal.js'

const disposables: (() => void)[] = []
let sentinelDevice: GPUDevice | undefined

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
})

afterAll(async () => {
  if (!sentinelDevice) return
  const loss = sentinelDevice.lost
  sentinelDevice.destroy()
  await loss
})

async function retainGpuInstance(): Promise<void> {
  if (sentinelDevice) return
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  expect(adapter).not.toBeNull()
  // Keep Dawn's external instance alive across test-owned device teardown.
  sentinelDevice = await adapter!.requestDevice()
}

async function hostFixture(
  zigFrame: false | undefined,
  backend: 'webgl2' | 'webgpu' = 'webgl2',
  grid = { columns: 12, rows: 3 },
  clock?: TestClock,
) {
  const runtime = await GhosttyRuntime.create()
  disposables.push(() => runtime.dispose())
  const host = document.createElement('div')
  host.style.width = '320px'
  host.style.height = '160px'
  document.body.append(host)
  disposables.push(() => {
    host
      .querySelector('canvas')
      ?.getContext('webgl2')
      ?.getExtension('WEBGL_lose_context')
      ?.loseContext()
    host.remove()
  })
  const session = await TerminalSession.create<Event>({
    appearance: {
      cursor: { blink: false },
      font: { family: 'monospace', size: 16 },
      grid: { ...grid, pixelRatio: 1 },
    },
    runtime: { kind: 'borrowed', runtime },
  })
  let renderer: WebGlTerminalRenderer | WebGpuTerminalRenderer | undefined
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    ...(zigFrame === undefined ? {} : { zigFrame }),
    rendererFactory: async (options) => {
      expect(options.zigFrame).toBe(zigFrame ?? true)
      if (backend === 'webgpu') {
        await retainGpuInstance()
        renderer = await WebGpuTerminalRenderer.create({ ...options, schedulerClock: clock })
        return renderer
      }
      renderer = await WebGlTerminalRenderer.create({ ...options, schedulerClock: clock })
      return renderer
    },
  })
  disposables.push(() => terminal.dispose())
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error))
  await terminal.open(host)
  expect(renderer).toBeDefined()
  return {
    canvas: host.querySelector('canvas')!,
    errors,
    host,
    renderer: renderer!,
    state: session.renderState,
    terminal,
  }
}

it.each([
  { backend: 'webgl2', zigFrame: undefined },
  { backend: 'webgl2', zigFrame: false },
  { backend: 'webgpu', zigFrame: undefined },
  { backend: 'webgpu', zigFrame: false },
] as const)(
  'resolves the real Terminal producer choice ($backend, zigFrame=$zigFrame)',
  async ({ backend, zigFrame }) => {
    const { canvas, terminal, renderer, errors } = await hostFixture(zigFrame, backend)
    await expect.poll(() => terminal.hasPendingFrame).toBe(false)
    const before = await displayedPixels(canvas)
    terminal.write('\x1b[?25l\x1b[31;44mASCII')
    await expect.poll(() => terminal.hasPendingFrame).toBe(false)
    expect(terminal.diagnostics.rendererBackend).toBe(backend)
    expect(renderer.metrics.submittedFrames).toBeGreaterThan(0)
    expect(renderer.metrics.jsFallbackFrames).toBe(0)
    if (zigFrame === undefined) expect(renderer.metrics.zigFrames).toBeGreaterThan(0)
    if (zigFrame === false) expect(renderer.metrics.zigFrames).toBe(0)
    expect(await displayedPixels(canvas)).not.toEqual(before)
    expect(errors).toEqual([])
    terminal.dispose()
    expect(terminal.hasPendingFrame).toBe(false)
    expect(terminal.hasPendingTimer).toBe(false)
  },
)

async function expectHostParity(
  native: Awaited<ReturnType<typeof hostFixture>>,
  js: Awaited<ReturnType<typeof hostFixture>>,
): Promise<void> {
  await expect
    .poll(() => native.terminal.hasPendingFrame || js.terminal.hasPendingFrame)
    .toBe(false)
  const nativePixels = await displayedPixels(native.canvas)
  const jsPixels = await displayedPixels(js.canvas)
  expect(nativePixels.byteLength).toBe(jsPixels.byteLength)
  const firstDifference = nativePixels.findIndex((value, index) => value !== jsPixels[index])
  expect(firstDifference, 'Scheduled native and JS compositor pixels match').toBe(-1)
  expect(native.errors).toEqual([])
  expect(js.errors).toEqual([])
}

it.each(['webgl2', 'webgpu'] as const)(
  'keeps Unicode resident in the default native producer (%s)',
  async (backend) => {
    const native = await hostFixture(undefined, backend)
    const js = await hostFixture(false, backend)
    for (const host of [native, js]) host.terminal.write('\x1b[?25lASCII\r\nsecond\r\nthird')
    await expectHostParity(native, js)
    expect(native.terminal.diagnostics.rendererBackend).toBe(backend)
    expect(js.terminal.diagnostics.rendererBackend).toBe(backend)
    expect(native.renderer.metrics.zigFrames).toBeGreaterThan(0)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
    expect(js.renderer.metrics.zigFrames).toBe(0)
    const nativeFrames = native.renderer.metrics.zigFrames
    const build = vi.spyOn(ZigFrameBuilder.prototype, 'build')
    for (const host of [native, js]) host.terminal.write('\x1b[3;1H界')
    await expectHostParity(native, js)
    expect(build.mock.results.map((result) => result.value)).toEqual([2, 0])
    expect(native.renderer.metrics.zigFrames).toBe(nativeFrames + 1)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
    build.mockClear()
    for (const host of [native, js]) host.terminal.write('\x1b[1;1Hchanged')
    await expectHostParity(native, js)
    expect(build.mock.results.at(-1)?.value).toBe(0)
    expect(native.renderer.metrics.zigFrames).toBe(nativeFrames + 2)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
    build.mockClear()
    for (const host of [native, js]) host.terminal.write('\x1b[3;1H\x1b[2KASCII')
    await expectHostParity(native, js)
    expect(build.mock.results.at(-1)?.value).toBe(0)
    expect(native.renderer.metrics.zigFrames).toBe(nativeFrames + 3)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
    expect(js.renderer.metrics.zigFrames).toBe(0)
    for (const host of [native, js]) {
      host.terminal.dispose()
      expect(host.terminal.hasPendingFrame).toBe(false)
      expect(host.terminal.hasPendingTimer).toBe(false)
    }
  },
)

it.each(['webgl2', 'webgpu'] as const)(
  'recovers real atlas pressure entirely through Zig and retains clean-row pixels (%s)',
  async (backend) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    onTestFinished(() => page.viewport(viewport.width, viewport.height))
    await page.viewport(800, 2400)
    const clocks = [new TestClock(), new TestClock()]
    const native = await hostFixture(undefined, backend, { columns: 1, rows: 2 }, clocks[0])
    const js = await hostFixture(false, backend, { columns: 1, rows: 2 }, clocks[1])
    const flush = () => {
      for (const clock of clocks) {
        for (let attempt = 0; attempt < 8 && clock.frames.size > 0; attempt += 1) clock.flushFrame()
        expect(clock.frames.size).toBe(0)
      }
    }
    const font = fittedFont(320, 512, 500)
    for (const host of [native, js]) {
      host.host.style.height = '1040px'
      host.renderer.setFont(font)
      host.terminal.write('\x1b[?25lM\x1b[2;1H_')
    }
    flush()
    await expectHostParity(native, js)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
    const before = await displayedPixels(native.canvas)
    const builds = vi.spyOn(ZigFrameBuilder.prototype, 'build')
    const glyphs = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].flatMap((letter) => [
      `\x1b[0m${letter}`,
      `\x1b[1m${letter}`,
    ])
    for (const glyph of glyphs) {
      for (const host of [native, js]) host.terminal.write(`\x1b[1;1H${glyph}`)
      flush()
      expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
      expect(native.renderer.metrics.zigFrames).toBe(native.renderer.metrics.submittedFrames)
    }
    expect(native.renderer.metrics.atlasEvictions).toBeGreaterThan(0)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
    expect(
      builds.mock.results.some(
        (result, index, results) =>
          result.value === 2 && results[index + 1]?.value === 2 && results[index + 2]?.value === 0,
      ),
    ).toBe(true)
    flush()
    await expectHostParity(native, js)
    const after = await displayedPixels(native.canvas)
    const rowBytes = native.canvas.width * font.deviceCellHeight * 4
    expect(after.subarray(rowBytes)).toEqual(before.subarray(rowBytes))
    const zigFrames = native.renderer.metrics.zigFrames
    for (const host of [native, js]) {
      host.renderer.setFont(fittedFont())
      host.terminal.write('\x1b[1;1H\x1b[0mé')
    }
    flush()
    await expectHostParity(native, js)
    expect(native.renderer.metrics.zigFrames).toBeGreaterThan(zigFrames)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
    expect(js.renderer.metrics.zigFrames).toBe(0)
  },
  30_000,
)

it.each(['webgl2', 'webgpu'] as const)(
  'bounds genuine native atlas exhaustion and returns to exact Zig pixels after shrinking (%s)',
  async (backend) => {
    const nativeClock = new TestClock()
    const native = await hostFixture(undefined, backend, { columns: 6, rows: 3 }, nativeClock)
    if (nativeClock.frames.size > 0) nativeClock.flushFrame()
    const face = new FontFace(
      'AtlasExhaustionTest',
      `url(${new URL('../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2', import.meta.url).href})`,
    )
    document.fonts.add(await face.load())
    onTestFinished(() => {
      document.fonts.delete(face)
    })
    const fitted = fittedFont(400, 650, 650)
    const font = { ...fitted, settings: { ...fitted.settings, family: 'AtlasExhaustionTest' } }
    const rasterizer = new CanvasGlyphRasterizer({ font })
    const glyphs = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
      .flatMap((text) => (['normal', 'bold'] as const).map((weight) => ({ text, weight })))
      .filter((input) => {
        const bitmap = rasterizer.rasterize({
          ...input,
          italic: false,
          cellSpan: 1,
          foreground: defaultRendererTheme.foreground,
        })
        return (
          bitmap &&
          bitmap.kind === 'grayscale' &&
          bitmap.width > 256 &&
          bitmap.height > 256 &&
          bitmap.width <= 510 &&
          bitmap.height <= 510
        )
      })
      .slice(0, 18)
    expect(glyphs).toHaveLength(18)
    native.renderer.setFont(font)
    if (nativeClock.frames.size > 0) nativeClock.flushFrame()
    const readRows = vi.spyOn(native.state, 'readRows')
    const build = vi.spyOn(ZigFrameBuilder.prototype, 'build')
    const before = native.renderer.metrics.submittedFrames
    native.terminal.write(
      '\x1b[?25l' +
        glyphs
          .map(
            (glyph, index) =>
              `\x1b[${Math.floor(index / 6) + 1};${(index % 6) + 1}H\x1b[${glyph.weight === 'bold' ? 1 : 0}m${glyph.text}`,
          )
          .join(''),
    )
    // Both producers share this finite atlas; exhausted fallback throws before submission.
    expect(() => nativeClock.flushFrame()).toThrow(
      expect.objectContaining({
        operation: 'renderer.atlas',
        message: 'The glyph atlas cannot retain the visible viewport',
      }),
    )
    expect(build.mock.results.map((result) => result.value)).toEqual([2, 2, 2, 2])
    expect(readRows.mock.calls.filter(([options]) => options?.packed)).toHaveLength(2)
    expect(native.renderer.metrics.submittedFrames).toBe(before)
    expect(native.terminal.hasPendingFrame).toBe(false)
    const nativeFrames = native.renderer.metrics.zigFrames
    native.terminal.write('\x1b[0m\x1b[2J\x1b[Hrecovered')
    native.renderer.setFont(fittedFont())
    if (nativeClock.frames.size > 0) nativeClock.flushFrame()
    expect(native.renderer.metrics.zigFrames).toBeGreaterThan(nativeFrames)
    const jsClock = new TestClock()
    const js = await hostFixture(false, backend, { columns: 6, rows: 3 }, jsClock)
    if (jsClock.frames.size > 0) jsClock.flushFrame()
    js.terminal.write('\x1b[?25l\x1b[0m\x1b[2J\x1b[Hrecovered')
    js.renderer.setFont(fittedFont())
    if (jsClock.frames.size > 0) jsClock.flushFrame()
    await expectHostParity(native, js)
    expect(native.terminal.hasPendingTimer).toBe(false)
    expect(js.terminal.hasPendingTimer).toBe(false)
  },
)

it('settles rolling ASCII scroll notifications without uploading unchanged native records', async () => {
  const native = await hostFixture(undefined)
  const js = await hostFixture(false)
  for (const host of [native, js]) host.terminal.write('\x1b[?25lsame\r\nsame\r\nsame')
  await expect
    .poll(() => native.terminal.hasPendingFrame || js.terminal.hasPendingFrame)
    .toBe(false)
  expect(await displayedPixels(native.canvas)).toEqual(await displayedPixels(js.canvas))
  const build = vi.spyOn(ZigFrameBuilder.prototype, 'build')
  const scroll = vi.spyOn(native.renderer, 'notifyScroll')
  const nativeDraw = vi.spyOn(native.canvas.getContext('webgl2')!, 'drawArraysInstanced')
  const jsDraw = vi.spyOn(js.canvas.getContext('webgl2')!, 'drawArraysInstanced')
  const uploaded = native.renderer.metrics.uploadedBytes
  const operations = native.renderer.metrics.instanceUploadOperations
  const submitted = native.renderer.metrics.submittedFrames
  const jsSubmitted = js.renderer.metrics.submittedFrames
  for (const host of [native, js]) host.terminal.write('\r\nsame')
  await expect
    .poll(() => native.terminal.hasPendingFrame || js.terminal.hasPendingFrame)
    .toBe(false)
  expect(scroll).toHaveBeenCalledOnce()
  expect(nativeDraw).toHaveBeenCalledTimes(
    (native.renderer.metrics.submittedFrames - submitted) * 2,
  )
  expect(jsDraw).toHaveBeenCalledTimes((js.renderer.metrics.submittedFrames - jsSubmitted) * 2)
  expect(await displayedPixels(native.canvas)).toEqual(await displayedPixels(js.canvas))
  expect(await native.renderer.capturePixels()).toEqual(await js.renderer.capturePixels())
  expect({
    full: build.mock.calls.map(([options]) => options.full),
    uploadedBytes: native.renderer.metrics.uploadedBytes - uploaded,
    uploadOperations: native.renderer.metrics.instanceUploadOperations - operations,
  }).toEqual({ full: [false], uploadedBytes: 0, uploadOperations: 0 })
  expect(native.renderer.metrics.jsFallbackFrames).toBe(0)
  expect(native.errors).toEqual([])
  expect(js.errors).toEqual([])
})
