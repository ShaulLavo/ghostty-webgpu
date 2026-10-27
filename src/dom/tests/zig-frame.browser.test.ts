import { testFontUrl } from '../../tests/fonts.js'
import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyResult } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import { createGhosttyError } from '../../core/error.js'
import type { WebGpuTextPass } from '../../render/webgpu/text-pass.js'
import { ZigFrameBuilder } from '../../core/zig-frame.js'
import { GlyphAtlas } from '../../render/shared/atlas/atlas.js'
import {
  GLYPH_INSTANCE_FLOATS,
  GlyphFlag,
  GlyphOffset,
} from '../../render/shared/instances/layout.js'
import { CanvasGlyphRasterizer } from '../../render/shared/atlas/canvas-rasterizer.js'
import { defaultRendererTheme } from '../../render/shared/instances/types.js'
import { WebGpuTerminalRenderer } from '../../render/webgpu/renderer.js'
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
    rendererFactory: async (options) => {
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
    runtime,
    state: session.renderState,
    terminal,
  }
}

it.each(['webgl2', 'webgpu'] as const)('uses the native GPU producer (%s)', async (backend) => {
  const { canvas, terminal, renderer, errors } = await hostFixture(backend)
  await expect.poll(() => terminal.hasPendingFrame).toBe(false)
  const before = await displayedPixels(canvas)
  terminal.write('\x1b[?25l\x1b[31;44mASCII')
  await expect.poll(() => terminal.hasPendingFrame).toBe(false)
  expect(terminal.diagnostics.rendererBackend).toBe(backend)
  expect(renderer.metrics.zigFrames).toBe(renderer.metrics.submittedFrames)
  expect(await displayedPixels(canvas)).not.toEqual(before)
  expect(errors).toEqual([])
  terminal.dispose()
  expect(terminal.hasPendingFrame).toBe(false)
  expect(terminal.hasPendingTimer).toBe(false)
})

async function expectPainted(
  native: Awaited<ReturnType<typeof hostFixture>>,
  errorCount = 0,
): Promise<void> {
  await expect.poll(() => native.terminal.hasPendingFrame).toBe(false)
  const pixels = await displayedPixels(native.canvas)
  expect(pixels.byteLength).toBe(native.canvas.width * native.canvas.height * 4)
  expect(native.renderer.metrics.zigFrames).toBe(native.renderer.metrics.submittedFrames)
  expect(native.errors).toHaveLength(errorCount)
}

it.each(['webgl2', 'webgpu'] as const)(
  'keeps Unicode resident in the default native producer (%s)',
  async (backend) => {
    const native = await hostFixture(backend)
    native.terminal.write('\x1b[?25lASCII\r\nsecond\r\nthird')
    await expectPainted(native)
    expect(native.terminal.diagnostics.rendererBackend).toBe(backend)
    expect(native.renderer.metrics.zigFrames).toBeGreaterThan(0)
    const nativeFrames = native.renderer.metrics.zigFrames
    const build = vi.spyOn(ZigFrameBuilder.prototype, 'build')
    native.terminal.write('\x1b[3;1H界')
    await expectPainted(native)
    expect(build.mock.results.map((result) => result.value)).toEqual([2, 0])
    expect(native.renderer.metrics.zigFrames).toBe(nativeFrames + 1)
    build.mockClear()
    native.terminal.write('\x1b[1;1Hchanged')
    await expectPainted(native)
    expect(build.mock.results.at(-1)?.value).toBe(0)
    expect(native.renderer.metrics.zigFrames).toBe(nativeFrames + 2)
    build.mockClear()
    native.terminal.write('\x1b[3;1H\x1b[2KASCII')
    await expectPainted(native)
    expect(build.mock.results.at(-1)?.value).toBe(0)
    expect(native.renderer.metrics.zigFrames).toBe(nativeFrames + 3)

    native.terminal.dispose()
    expect(native.terminal.hasPendingFrame).toBe(false)
    expect(native.terminal.hasPendingTimer).toBe(false)
  },
)

it.each(['webgl2', 'webgpu'] as const)(
  'recovers real atlas pressure entirely through Zig and retains clean-row pixels (%s)',
  async (backend) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    onTestFinished(() => page.viewport(viewport.width, viewport.height))
    await page.viewport(800, 2400)
    const clocks = [new TestClock()]
    const native = await hostFixture(backend, { columns: 1, rows: 2 }, clocks[0])
    const flush = () => {
      for (const clock of clocks) {
        for (let attempt = 0; attempt < 8 && clock.frames.size > 0; attempt += 1) clock.flushFrame()
        expect(clock.frames.size).toBe(0)
      }
    }
    const font = fittedFont(320, 512, 500)

    native.host.style.height = '1040px'
    native.renderer.setFont(font)
    native.terminal.write('\x1b[?25lM\x1b[2;1H_')

    flush()
    await expectPainted(native)
    const before = await displayedPixels(native.canvas)
    const builds = vi.spyOn(ZigFrameBuilder.prototype, 'build')
    const invalidateAll = vi.spyOn(GlyphAtlas.prototype, 'invalidateAll')
    const clearGlyphs = vi.spyOn(ZigFrameBuilder.prototype, 'clearGlyphs')
    const submitted = native.renderer.metrics.submittedFrames
    const rebuilt = native.renderer.metrics.rebuiltRows
    const builder: unknown = Reflect.get(native.renderer, 'zigBuilder')
    if (!(builder instanceof ZigFrameBuilder)) throw new Error('Expected the native frame builder')
    const cleanGlyph = builder.glyphData.slice(GLYPH_INSTANCE_FLOATS)
    const glyphs = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].flatMap((letter) => [
      `\x1b[0m${letter}`,
      `\x1b[1m${letter}`,
    ])
    for (const glyph of glyphs) {
      native.terminal.write(`\x1b[1;1H${glyph}`)
      flush()
      expect(native.renderer.metrics.zigFrames).toBe(native.renderer.metrics.submittedFrames)
    }
    expect(native.renderer.metrics.atlasEvictions).toBeGreaterThan(0)
    expect(builds.mock.results.some((result) => result.value === 2)).toBe(true)
    expect(builds.mock.calls.every(([options]) => !options.full)).toBe(true)
    expect(invalidateAll).not.toHaveBeenCalled()
    expect(clearGlyphs).not.toHaveBeenCalled()
    expect(builder.glyphData.slice(GLYPH_INSTANCE_FLOATS)).toEqual(cleanGlyph)
    expect(native.renderer.metrics.submittedFrames - submitted).toBe(glyphs.length)
    // Moving the hidden write cursor also dirties its previous row once.
    expect(native.renderer.metrics.rebuiltRows - rebuilt).toBeLessThanOrEqual(glyphs.length + 1)
    flush()
    await expectPainted(native)
    const after = await displayedPixels(native.canvas)
    const rowBytes = native.canvas.width * font.deviceCellHeight * 4
    expect(after.subarray(rowBytes)).toEqual(before.subarray(rowBytes))
    const zigFrames = native.renderer.metrics.zigFrames

    native.renderer.setFont(fittedFont())
    native.terminal.write('\x1b[1;1H\x1b[0mé')

    flush()
    await expectPainted(native)
    expect(native.renderer.metrics.zigFrames).toBeGreaterThan(zigFrames)
  },
  30_000,
)

it.each(['webgl2', 'webgpu'] as const)(
  'bounds genuine native atlas exhaustion and renders deferred glyphs when the visible set shrinks (%s)',
  async (backend) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    onTestFinished(() => page.viewport(viewport.width, viewport.height))
    await page.viewport(4000, 2100)
    const nativeClock = new TestClock()
    const native = await hostFixture(backend, { columns: 6, rows: 3 }, nativeClock)
    if (nativeClock.frames.size > 0) nativeClock.flushFrame()
    const face = new FontFace('AtlasExhaustionTest', `url(${testFontUrl})`)
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
    native.host.style.width = `${font.deviceCellWidth * 6}px`
    native.host.style.height = `${font.deviceCellHeight * 3}px`
    native.renderer.setFont(font)
    if (nativeClock.frames.size > 0) nativeClock.flushFrame()
    const readRows = vi.spyOn(native.state, 'readRows')
    const build = vi.spyOn(ZigFrameBuilder.prototype, 'build')
    const before = native.renderer.metrics.submittedFrames
    const acknowledge = vi.spyOn(native.state, 'acknowledge')
    const atlas: unknown = Reflect.get(native.renderer, 'atlas')
    if (!(atlas instanceof GlyphAtlas)) throw new Error('Expected the renderer atlas')
    const invalidateAll = vi.spyOn(atlas, 'invalidateAll')
    const clearGlyphs = vi.spyOn(ZigFrameBuilder.prototype, 'clearGlyphs')
    native.terminal.write(
      '\x1b[?25l' +
        glyphs
          .map(
            (glyph, index) =>
              `\x1b[${Math.floor(index / 6) + 1};${(index % 6) + 1}H\x1b[${glyph.weight === 'bold' ? 1 : 0}m${glyph.text}`,
          )
          .join(''),
    )
    expect(() => nativeClock.flushFrame()).not.toThrow()
    await expectPainted(native)
    expect(build.mock.results.map((result) => result.value)).toEqual([2, 0])
    expect(build.mock.calls.every(([options]) => !options.full)).toBe(true)
    expect(readRows).not.toHaveBeenCalled()
    expect(native.renderer.metrics.submittedFrames).toBe(before + 1)
    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(native.renderer.metrics.atlasPages).toBe(16)
    expect(native.renderer.metrics.atlasEvictions).toBe(0)
    const builder = build.mock.contexts.at(-1)
    if (!(builder instanceof ZigFrameBuilder)) throw new Error('Expected the native frame builder')
    const data = builder.glyphData
    const deferred = Array.from({ length: glyphs.length }, (_, index) => index).filter(
      (index) => (data[index * GLYPH_INSTANCE_FLOATS + GlyphOffset.Meta]! & GlyphFlag.Glyph) === 0,
    )
    expect(deferred).toHaveLength(2)
    expect(builder.hasDeferredGlyphs).toBe(true)
    const snapshot = native.terminal.frameSnapshot()!
    expect(snapshot.rows.map((row) => row.text)).toEqual(
      Array.from({ length: 3 }, (_, row) =>
        glyphs
          .slice(row * 6, row * 6 + 6)
          .map((glyph) => glyph.text)
          .join(''),
      ),
    )
    const partialPixels = await native.renderer.capturePixels()
    expectGlyphPixels(partialPixels)
    native.terminal.write(
      deferred.map((index) => `\x1b[${Math.floor(index / 6) + 1};${(index % 6) + 1}H `).join(''),
    )
    if (nativeClock.frames.size > 0) nativeClock.flushFrame()
    await expectPainted(native)
    expectExactPixels(await native.renderer.capturePixels(), partialPixels)
    expect(native.renderer.metrics.submittedFrames).toBe(before + 2)
    expect(acknowledge).toHaveBeenCalledTimes(2)
    const target = glyphs[deferred[0]!]!
    native.terminal.write(`\x1b[2J\x1b[H\x1b[${target.weight === 'bold' ? 1 : 0}m${target.text}`)
    if (nativeClock.frames.size > 0) nativeClock.flushFrame()
    await expectPainted(native)
    expect(native.renderer.metrics.submittedFrames).toBe(before + 3)
    expect(acknowledge).toHaveBeenCalledTimes(3)
    expect(builder.hasDeferredGlyphs).toBe(false)
    expect(builder.glyphData[GlyphOffset.Meta]! & GlyphFlag.Glyph).toBe(GlyphFlag.Glyph)
    expect(native.terminal.visibleLines()[0]?.trimEnd()).toBe(target.text)
    expect(readRows).not.toHaveBeenCalled()
    expect(invalidateAll).not.toHaveBeenCalled()
    expect(clearGlyphs).not.toHaveBeenCalled()
    expect(native.renderer.hasPendingTimer).toBe(false)
    expect(native.terminal.hasPendingFrame).toBe(false)
    const recovered = await native.renderer.capturePixels()
    expectGlyphPixels(recovered)
    native.renderer.clearTextureAtlas()
    if (nativeClock.frames.size > 0) nativeClock.flushFrame()
    await expectPainted(native)
    expectExactPixels(await native.renderer.capturePixels(), recovered)
  },
  30_000,
)

it.each(['webgl2', 'webgpu'] as const)(
  'rebuilds unsubmitted persistent records after a bridge exception (%s)',
  async (backend) => {
    const clock = new TestClock()
    const native = await hostFixture(backend, { columns: 6, rows: 3 }, clock)
    const flush = () => {
      while (clock.frames.size > 0) clock.flushFrame()
    }
    const build = vi.spyOn(ZigFrameBuilder.prototype, 'build')
    native.terminal.write('\x1b[?25lABAB\r\nBBBB\r\nlast')
    flush()
    const before = await displayedPixels(native.canvas)
    const snapshot = native.terminal.frameSnapshot()
    const initialBuilder = build.mock.contexts.at(-1) as ZigFrameBuilder
    const initialGlyphs = initialBuilder.glyphData.slice()
    build.mockClear()
    const acknowledge = vi.spyOn(native.state, 'acknowledge')
    const submitted = native.renderer.metrics.submittedFrames
    const uploaded = native.renderer.metrics.instanceUploadOperations
    const atlasUploads = native.renderer.metrics.atlasUploadOperations
    const bridgeBuild = native.runtime.bridge.buildFrame.bind(native.runtime.bridge)
    const fault = vi
      .spyOn(native.runtime.bridge, 'buildFrame')
      .mockImplementationOnce((...args) => {
        expect(bridgeBuild(...args)).toBe(GhosttyResult.Success)
        return GhosttyResult.OutOfMemory
      })
    native.terminal.write('\x1b[1;1HBBBB')
    native.renderer.refreshRows(2, 2)
    let uncaught: unknown
    try {
      flush()
    } catch (cause) {
      uncaught = cause
    }
    expect(build.mock.results[0]?.type).toBe('throw')
    expect(build.mock.calls[0]?.[0].full).toBe(false)
    const builder = build.mock.contexts[0] as ZigFrameBuilder
    const unsubmitted = { cells: builder.cellData.slice(), glyphs: builder.glyphData.slice() }
    expect(unsubmitted.glyphs).not.toEqual(initialGlyphs)
    expect(native.terminal.frameSnapshot()).toBe(snapshot)
    expect(native.renderer.metrics.submittedFrames).toBe(submitted)
    expect(native.renderer.metrics.instanceUploadOperations).toBe(uploaded)
    expect(native.renderer.metrics.atlasUploadOperations).toBe(atlasUploads)
    expect(acknowledge).not.toHaveBeenCalled()
    expect(await displayedPixels(native.canvas)).toEqual(before)
    fault.mockRestore()
    build.mockClear()
    native.renderer.schedule()
    flush()
    expect(build.mock.calls[0]?.[0].full).toBe(true)
    expect(builder.cellData).toEqual(unsubmitted.cells)
    expect(builder.glyphData).toEqual(unsubmitted.glyphs)
    expect(builder.changedRanges()).toEqual(
      [0, 1, 2].map((row) => ({
        row,
        cell: { byteOffset: row * 6 * 64, byteLength: 6 * 64 },
        glyph: { byteOffset: row * 6 * 96, byteLength: 6 * 96 },
      })),
    )
    expect(native.renderer.metrics.submittedFrames).toBe(submitted + 1)
    const recovered = await displayedPixels(native.canvas)
    expect(recovered).not.toEqual(before)
    const rowBytes = native.canvas.width * (native.canvas.height / 3) * 4
    expect(recovered.subarray(0, rowBytes)).toEqual(before.subarray(rowBytes, rowBytes * 2))
    expect(recovered.subarray(rowBytes)).toEqual(before.subarray(rowBytes))
    expect(native.terminal.frameSnapshot()?.rows[0]?.text).toBe('BBBB  ')
    native.renderer.clearTextureAtlas()
    flush()
    expect(await displayedPixels(native.canvas)).toEqual(recovered)
    expect(uncaught).toBeUndefined()
    expect(native.errors).toEqual([
      expect.objectContaining({
        cause: expect.objectContaining({ operation: 'bridge_build_frame', result: -1 }),
      }),
    ])
  },
)

it.each(['webgl2', 'webgpu'] as const)(
  'reports one scheduled frame error per failure episode and resets after recovery (%s)',
  async (backend) => {
    const clock = new TestClock()
    const native = await hostFixture(backend, { columns: 6, rows: 3 }, clock)
    const flush = () => {
      while (clock.frames.size > 0) clock.flushFrame()
    }
    native.terminal.write('\x1b[?25h\x1b[?12hold')
    native.renderer.setCursorBlinkEnabled(true)
    native.renderer.setFocused(true)
    flush()
    expect(clock.timers.size).toBe(1)
    const before = await displayedPixels(native.canvas)
    const submitted = native.renderer.metrics.submittedFrames
    const acknowledge = vi.spyOn(native.state, 'acknowledge')
    const fault = vi.spyOn(ZigFrameBuilder.prototype, 'build').mockReturnValue(2)
    native.terminal.write('\x1b[1;1Hnew')
    expect(flush).not.toThrow()
    expect(native.errors).toHaveLength(1)
    expect(native.errors[0]).toMatchObject({
      cause: { operation: 'frame_builder' },
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [handle, blink] = clock.timers.entries().next().value!
      clock.timers.delete(handle)
      blink()
      expect(flush).not.toThrow()
    }
    expect(native.errors).toHaveLength(1)
    expect(acknowledge).not.toHaveBeenCalled()
    expect(native.renderer.metrics.submittedFrames).toBe(submitted)
    expect(await displayedPixels(native.canvas)).toEqual(before)
    expect(clock.frames.size).toBe(0)
    fault.mockRestore()
    native.renderer.setCursorBlinkEnabled(false)
    native.renderer.schedule()
    flush()
    expect(native.renderer.metrics.submittedFrames).toBe(submitted + 1)
    const recovered = await displayedPixels(native.canvas)
    expect(recovered).not.toEqual(before)
    native.renderer.clearTextureAtlas()
    flush()
    expect(await displayedPixels(native.canvas)).toEqual(recovered)
    vi.spyOn(ZigFrameBuilder.prototype, 'build').mockReturnValue(2)
    native.terminal.write('\x1b[1;1Hbad')
    expect(flush).not.toThrow()
    expect(native.errors).toHaveLength(2)
  },
)

function submissionSpies(native: Awaited<ReturnType<typeof hostFixture>>) {
  const device = Reflect.get(native.renderer, 'device') as GPUDevice
  const pass = Reflect.get(native.renderer, 'textPass') as WebGpuTextPass
  return {
    texture: () => vi.spyOn(native.canvas.getContext('webgpu')!, 'getCurrentTexture'),
    pass: () => vi.spyOn(pass, 'submit'),
    queue: () => vi.spyOn(device.queue, 'submit'),
  }
}

it.each(['texture', 'pass', 'queue'] as const)(
  'recovers an idle hidden-cursor frame after a one-shot presentation failure (%s)',
  async (location) => {
    const clock = new TestClock()
    const native = await hostFixture('webgpu', { columns: 6, rows: 3 }, clock)
    native.terminal.write('\x1b[?25lABAB\r\nBBBB\r\nlast')
    clock.flushFrame()
    const before = await displayedPixels(native.canvas)
    const snapshot = native.terminal.frameSnapshot()
    const submitted = native.renderer.metrics.submittedFrames
    const acknowledge = vi.spyOn(native.state, 'acknowledge')
    const reports: unknown[] = []
    native.terminal.on('error', () =>
      reports.push({
        acknowledged: acknowledge.mock.calls.length,
        submitted: native.renderer.metrics.submittedFrames,
        snapshot: native.terminal.frameSnapshot(),
      }),
    )
    const injected = createGhosttyError('presentation', 'Injected presentation failure')
    const fault = submissionSpies(native)
      [location]()
      .mockImplementationOnce(() => {
        throw injected
      })
    native.terminal.write('\x1b[1;1HBBBB')
    expect(() => clock.flushFrame()).not.toThrow()
    expect(clock.frames.size).toBe(0)
    expect(clock.timers.size).toBe(0)
    const after = await displayedPixels(native.canvas)
    const rowBytes = native.canvas.width * (native.canvas.height / 3) * 4
    const expected = before.slice()
    expected.set(before.subarray(rowBytes, rowBytes * 2), 0)
    expect(
      after.every((value, index) => value === expected[index]),
      'the idle canvas presents recovered glyph ink without another request',
    ).toBe(true)
    expect(fault).toHaveBeenCalledTimes(2)
    expect(native.errors).toEqual([expect.objectContaining({ cause: injected })])
    expect(reports).toEqual([{ acknowledged: 0, submitted, snapshot }])
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(native.renderer.metrics.submittedFrames).toBe(submitted + 1)
    expect(native.terminal.frameSnapshot()?.rows[0]?.text).toBe('BBBB  ')
  },
)

it('bounds failed presentation retries and resets the error episode after recovery', async () => {
  const clock = new TestClock()
  const native = await hostFixture('webgpu', { columns: 6, rows: 3 }, clock)
  native.terminal.write('\x1b[?25lABAB\r\nBBBB\r\nlast')
  clock.flushFrame()
  const before = await displayedPixels(native.canvas)
  const snapshot = native.terminal.frameSnapshot()
  const submitted = native.renderer.metrics.submittedFrames
  const acknowledge = vi.spyOn(native.state, 'acknowledge')
  const injected = createGhosttyError('presentation', 'Injected persistent presentation failure')
  const fault = submissionSpies(native)
    .queue()
    .mockImplementation(() => {
      throw injected
    })
  native.terminal.write('\x1b[1;1HBBBB')
  expect(() => clock.flushFrame()).not.toThrow()
  expect(fault).toHaveBeenCalledTimes(2)
  native.renderer.schedule()
  expect(() => clock.flushFrame()).not.toThrow()
  expect(fault).toHaveBeenCalledTimes(4)
  expect(native.errors).toEqual([expect.objectContaining({ cause: injected })])
  expect(acknowledge).not.toHaveBeenCalled()
  expect(native.renderer.metrics.submittedFrames).toBe(submitted)
  expect(native.terminal.frameSnapshot()).toBe(snapshot)
  expect(clock.frames.size).toBe(0)
  expect(clock.timers.size).toBe(0)
  fault.mockRestore()
  native.renderer.schedule()
  clock.flushFrame()
  expect(acknowledge).toHaveBeenCalledOnce()
  expect(native.renderer.metrics.submittedFrames).toBe(submitted + 1)
  const recovered = await displayedPixels(native.canvas)
  const rowBytes = native.canvas.width * (native.canvas.height / 3) * 4
  const expected = before.slice()
  expected.set(before.subarray(rowBytes, rowBytes * 2), 0)
  expect(recovered.every((value, index) => value === expected[index])).toBe(true)
  submissionSpies(native)
    .queue()
    .mockImplementationOnce(() => {
      throw injected
    })
  native.terminal.write('\x1b[1;1HABAB')
  expect(() => clock.flushFrame()).not.toThrow()
  expect(native.errors).toHaveLength(2)
  expect(await displayedPixels(native.canvas)).toEqual(before)
  expect(clock.frames.size).toBe(0)
  expect(clock.timers.size).toBe(0)
})

it('settles rolling ASCII scroll notifications without uploading unchanged native records', async () => {
  const native = await hostFixture()
  native.terminal.write('\x1b[?25lsame\r\nsame\r\nsame')
  await expect.poll(() => native.terminal.hasPendingFrame).toBe(false)
  const build = vi.spyOn(ZigFrameBuilder.prototype, 'build')
  const scroll = vi.spyOn(native.renderer, 'notifyScroll')
  const nativeDraw = vi.spyOn(native.canvas.getContext('webgl2')!, 'drawArraysInstanced')
  const uploaded = native.renderer.metrics.uploadedBytes
  const operations = native.renderer.metrics.instanceUploadOperations
  const submitted = native.renderer.metrics.submittedFrames
  native.terminal.write('\r\nsame')
  await expect.poll(() => native.terminal.hasPendingFrame).toBe(false)
  expect(scroll).toHaveBeenCalledOnce()
  expect(nativeDraw).toHaveBeenCalledTimes(
    (native.renderer.metrics.submittedFrames - submitted) * 2,
  )
  expect({
    full: build.mock.calls.map(([options]) => options.full),
    uploadedBytes: native.renderer.metrics.uploadedBytes - uploaded,
    uploadOperations: native.renderer.metrics.instanceUploadOperations - operations,
  }).toEqual({ full: [false], uploadedBytes: 0, uploadOperations: 0 })
  expect(native.errors).toEqual([])
})

function expectExactPixels(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength)
  expect(actual.findIndex((value, index) => value !== expected[index])).toBe(-1)
}

function expectGlyphPixels(pixels: Uint8Array): void {
  expect(pixels.findIndex((value, index) => value !== pixels[index % 4])).toBeGreaterThanOrEqual(0)
}
