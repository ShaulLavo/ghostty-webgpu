import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { page } from 'vitest/browser'
import { RenderStateDirty } from '../../core/abi.js'
import { createGhosttyError } from '../../core/error.js'
import type { GhosttyRenderState } from '../../core/render-state.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { GhosttyTerminal } from '../../core/terminal.js'
import { zigFrameContents, zigFrameCursorStyles } from '../../core/tests/zig-frame-fixtures.js'
import { ZigFrameBuilder } from '../../core/zig-frame.js'
import type { RenderRow } from '../../core/types.js'
import { GlyphAtlas } from '../atlas/atlas.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import type { AtlasInsertResult } from '../atlas/types.js'
import { buildZigFrame, registerZigGlyphs, zigGlyphRow } from '../atlas/zig-glyphs.js'
import { canonicalRendererTheme } from '../config.js'
import { defaultRendererTheme } from '../instances/types.js'
import type { RendererFrameSnapshot, WebGpuTerminalRendererOptions } from '../renderer.js'
import { WebGlTerminalRenderer } from './renderer.js'
import { TestClock, displayedPixels, fittedFont } from './tests/fixture.js'
import { expectPixelsEqual } from './tests/pixels.js'

const disposables: (() => void)[] = []
const paintObservers = new Map<
  WebGlTerminalRenderer,
  { canvas: HTMLCanvasElement; count: () => number; reset: () => void; draws: number }
>()

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
  paintObservers.clear()
  vi.restoreAllMocks()
})

async function runtimeFixture(columns = 32, rows = 3) {
  const runtime = await GhosttyRuntime.create()
  disposables.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns, rows })
  const state = runtime.createRenderState(terminal)
  return { columns, rows, runtime, state, terminal }
}

async function rendererFixture(
  source: { columns: number; rows: number; state: GhosttyRenderState },
  options: Partial<WebGpuTerminalRendererOptions> = {},
) {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  disposables.push(() => {
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
    canvas.remove()
  })
  const clock = new TestClock()
  const renderer = await WebGlTerminalRenderer.create({
    canvas,
    columns: source.columns,
    rows: source.rows,
    renderState: source.state,
    font: fittedFont(),
    schedulerClock: clock,
    ...options,
  })
  disposables.push(() => renderer.dispose())
  const draw = vi.spyOn(canvas.getContext('webgl2')!, 'drawArraysInstanced')
  paintObservers.set(renderer, {
    canvas,
    count: () => draw.mock.calls.length,
    reset: () => draw.mockClear(),
    draws: 0,
  })
  return { canvas, clock, renderer }
}

async function nativeFixture(content: string) {
  const nativeSource = await runtimeFixture()
  nativeSource.terminal.write(content)
  const native = await rendererFixture(nativeSource)
  const readRows = vi.spyOn(nativeSource.state, 'readRows')
  const build = vi.spyOn(ZigFrameBuilder.prototype, 'build')
  return { build, native, nativeSource, readRows }
}

async function expectPainted(native: WebGlTerminalRenderer): Promise<Uint8Array> {
  const observer = paintObservers.get(native)!
  expect(observer.count()).toBe(native.metrics.draws - observer.draws)
  observer.draws = native.metrics.draws
  const displayed = await displayedPixels(observer.canvas)
  expect(displayed.byteLength).toBe(observer.canvas.width * observer.canvas.height * 4)
  const pixels = await native.capturePixels()
  observer.reset()
  expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
  return pixels
}

function writeFrame(native: { terminal: GhosttyTerminal }, content: string): void {
  native.terminal.write(content)
}

describe('WebGL WASM frame pixels', () => {
  it.each(zigFrameContents)('paints native records for %j', async (content) => {
    const { native, readRows } = await nativeFixture(`\x1b[?25l${content}`)
    native.clock.flushFrame()
    expect(native.renderer.metrics.zigFrames).toBe(1)
    expect(readRows).not.toHaveBeenCalled()
    const pixels = await expectPainted(native.renderer)
    expect(pixels.some((value) => value !== 0)).toBe(true)
    expect(native.renderer.hasPendingFrame).toBe(false)
  })

  it.each(zigFrameCursorStyles)('matches a visible %s cursor and its movement', async (style) => {
    const { native, nativeSource, readRows } = await nativeFixture('ABC\x1b[1;2H')
    native.renderer.setInactiveCursorStyle(style)
    native.clock.flushFrame()
    const before = await expectPainted(native.renderer)
    writeFrame(nativeSource, '\x1b[2;4H')
    native.renderer.notifyWrite()
    native.clock.flushFrame()
    const after = await expectPainted(native.renderer)
    expect(after).not.toEqual(before)
    expect(native.renderer.metrics.zigFrames).toBe(2)
    expect(readRows).not.toHaveBeenCalled()
    expect([native.clock.frames.size, native.clock.timers.size]).toEqual([0, 0])
  })

  it('uploads newly colored cells after a missing-glyph retry and preserves clean rows', async () => {
    const { native, nativeSource, readRows, build } = await nativeFixture(
      '\x1b[?25lold\r\nsecond\r\nthird\x1b[2;1H',
    )
    native.clock.flushFrame()
    expect(build.mock.results.map((result) => result.value)).toEqual([2, 0])
    const before = await expectPainted(native.renderer)
    build.mockClear()
    const uploaded = native.renderer.metrics.uploadedBytes
    writeFrame(nativeSource, '\x1b[2;6H\x1b[31;44mX')
    native.renderer.notifyWrite()
    native.clock.flushFrame()
    expect(build.mock.results.map((result) => result.value)).toEqual([2, 0])
    const after = await expectPainted(native.renderer)
    expect(after).not.toEqual(before)
    const firstRowBytes = native.canvas.width * fittedFont().deviceCellHeight * 4
    expect(after.subarray(0, firstRowBytes)).toEqual(before.subarray(0, firstRowBytes))
    expect(after.subarray(firstRowBytes * 2)).toEqual(before.subarray(firstRowBytes * 2))
    expect(native.renderer.metrics.uploadedBytes - uploaded).toBeGreaterThan(0)
    expect(native.renderer.metrics.uploadedBytes - uploaded).toBeLessThanOrEqual(32 * (64 + 96))
    expect(native.renderer.metrics.zigFrames).toBe(2)
    expect(readRows).not.toHaveBeenCalled()
  })

  it('diffs viewport scroll records while preserving scheduled pixels', async () => {
    const { native, nativeSource, readRows, build } = await nativeFixture(
      '\x1b[?25lsame\r\nsame\r\nother\r\nsame',
    )
    native.clock.flushFrame()
    const bottom = await expectPainted(native.renderer)
    const fullBufferBytes = 32 * 3 * (64 + 96)
    for (const delta of [-1, 1]) {
      const uploaded = native.renderer.metrics.uploadedBytes
      build.mockClear()
      nativeSource.terminal.scrollBy(delta)
      native.renderer.notifyScroll()
      native.clock.flushFrame()
      const pixels = await expectPainted(native.renderer)
      if (delta === -1) expect(pixels).not.toEqual(bottom)
      if (delta === 1) expect(pixels).toEqual(bottom)
      const uploadedBytes = native.renderer.metrics.uploadedBytes - uploaded
      expect(uploadedBytes).toBeGreaterThan(0)
      expect({ full: build.mock.calls.map(([options]) => options.full), uploadedBytes }).toEqual({
        full: [false],
        uploadedBytes: expect.any(Number),
      })
      expect(uploadedBytes).toBeLessThan(fullBufferBytes)
      expect(readRows).not.toHaveBeenCalled()
    }
  })

  it('keeps Unicode and clean wide rows resident in Zig across ASCII writes', async () => {
    const { native, nativeSource, readRows } = await nativeFixture('\x1b[?25lASCII')
    native.clock.flushFrame()
    await expectPainted(native.renderer)
    writeFrame(nativeSource, '\x1b[3;1H界')
    native.renderer.notifyWrite()
    native.clock.flushFrame()
    expect(native.renderer.metrics.zigFrames).toBe(2)
    expect(readRows).not.toHaveBeenCalled()
    await expectPainted(native.renderer)
    writeFrame(nativeSource, '\x1b[2;1Hchanged')
    native.renderer.notifyWrite()
    native.clock.flushFrame()
    expect(native.renderer.metrics.zigFrames).toBe(3)
    expect(readRows).not.toHaveBeenCalled()
    await expectPainted(native.renderer)
    readRows.mockClear()
    writeFrame(nativeSource, '\x1b[3;1H\x1b[2KASCII')
    native.renderer.notifyWrite()
    native.clock.flushFrame()
    expect(native.renderer.metrics.zigFrames).toBe(4)
    expect(readRows).not.toHaveBeenCalled()
    await expectPainted(native.renderer)
    native.renderer.schedule()
    native.clock.flushFrame()
    expect(native.renderer.metrics.submittedFrames).toBe(4)
    expect(native.clock.frames.size).toBe(0)
  })
})

describe('WebGL WASM frame lifecycle', () => {
  it('settles native damage and callbacks without uploading or submitting unchanged records', async () => {
    const source = await runtimeFixture(8, 2)
    source.terminal.write('\x1b[?25lfirst')
    const onFrame = vi.fn()
    const { canvas, clock, renderer } = await rendererFixture(source, { onFrame })
    clock.flushFrame()
    const observer = paintObservers.get(renderer)!
    expect(observer.count()).toBe(1)
    const before = await displayedPixels(canvas)
    const submitted = renderer.metrics.submittedFrames
    const uploaded = renderer.metrics.uploadedBytes
    const operations = renderer.metrics.instanceUploadOperations
    const acknowledge = vi.spyOn(source.state, 'acknowledge')
    renderer.refreshRows(0, 1)
    clock.flushFrame()
    expect(onFrame).toHaveBeenCalledTimes(2)
    source.terminal.write('\x1b[2;4H')
    renderer.notifyWrite()
    clock.flushFrame()
    expect(onFrame).toHaveBeenCalledTimes(3)
    expect(onFrame.mock.calls.at(-1)![0].cursor.viewport).toMatchObject({ x: 3, y: 1 })
    expect(onFrame.mock.calls.at(-1)![0].rows[0].text.trimEnd()).toBe('first')
    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(source.state.dirty).toBe(RenderStateDirty.False)
    expect(renderer.metrics.zigFrames).toBe(1)
    expect(submitted).toBe(1)
    expect(renderer.metrics.submittedFrames).toBe(submitted)
    expect(renderer.metrics.uploadedBytes).toBe(uploaded)
    expect(renderer.metrics.instanceUploadOperations).toBe(operations)
    expect(observer.count()).toBe(1)
    expect(await displayedPixels(canvas)).toEqual(before)
    expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
  })

  it('restores native glyphs and pending writes after real WebGL context loss', async () => {
    const { native, nativeSource, readRows } = await nativeFixture('\x1b[?25lfirst\r\nsecond')
    native.clock.flushFrame()
    await expectPainted(native.renderer)
    const gl = native.canvas.getContext('webgl2')!
    const extension = gl.getExtension('WEBGL_lose_context')!
    expect(extension).toBeDefined()
    const lost = new Promise<Event>((resolve) =>
      native.canvas.addEventListener('webglcontextlost', resolve, { once: true }),
    )
    extension.loseContext()
    expect((await lost).defaultPrevented).toBe(true)
    const acknowledge = vi.spyOn(nativeSource.state, 'acknowledge')
    writeFrame(nativeSource, '\x1b[2;1H\x1b[31;44mX')
    native.renderer.notifyWrite()
    expect(acknowledge).not.toHaveBeenCalled()
    expect(native.renderer.metrics.zigFrames).toBe(1)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    const restored = new Promise<Event>((resolve) =>
      native.canvas.addEventListener('webglcontextrestored', resolve, { once: true }),
    )
    extension.restoreContext()
    await restored
    flushPendingFrames(native.clock)
    await expectPainted(native.renderer)
    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(native.renderer.metrics.zigFrames).toBe(2)
    expect(native.renderer.metrics.deviceRestores).toBe(1)
    expect(readRows).not.toHaveBeenCalled()
    expect(gl.getError()).toBe(gl.NO_ERROR)
  })

  it.each(['onFrame', 'onRowsPainted'] as const)(
    'retains theme and overlay invalidation requested by %s',
    async (callback) => {
      const source = await runtimeFixture(8, 2)
      source.terminal.write('\x1b[?25lfirst')
      let invalidate: (() => void) | undefined
      const onPaint = vi.fn(() => {
        const action = invalidate
        invalidate = undefined
        action?.()
      })
      const { clock, renderer } = await rendererFixture(source, { [callback]: onPaint })
      clock.flushFrame()
      const before = await renderer.capturePixels()
      expect(before.some((value) => value !== 0)).toBe(true)
      invalidate = () => renderer.setTheme({ foreground: { r: 80, g: 40, b: 20 } })
      renderer.refreshRows(0, 1)
      clock.flushFrame()
      expect(source.state.dirty).toBe(RenderStateDirty.False)
      clock.flushFrame()
      expect(renderer.metrics.zigFrames).toBe(2)
      expect(await renderer.capturePixels()).not.toEqual(before)
      invalidate = () => renderer.refreshRows(1, 1)
      renderer.refreshRows(0, 0)
      clock.flushFrame()
      clock.flushFrame()
      expect(renderer.metrics.zigFrames).toBe(2)
      expect(onPaint).toHaveBeenCalledTimes(5)
      expect(clock.frames.size).toBe(0)
    },
  )

  it.each(['onFrame', 'onRowsPainted'] as const)(
    'preserves terminal damage and current text created by %s',
    async (callback) => {
      const source = await runtimeFixture(8, 2)
      source.terminal.write('\x1b[?25lfirst')
      let write = false
      const textByRow = new Map<number, string>()
      const onPaint = (frame: RendererFrameSnapshot | readonly RenderRow[]) => {
        const rows = 'rows' in frame ? frame.rows : frame
        for (const row of rows) {
          const text = 'text' in row ? row.text : row.cells.map((cell) => cell.text).join('')
          textByRow.set(row.y, text.trimEnd())
        }
        if (!write) return
        write = false
        source.terminal.write('\x1b[2;1Hsecond\x1b[1;6H')
        source.state.update()
        renderer.notifyWrite()
      }
      const { clock, renderer } = await rendererFixture(source, { [callback]: onPaint })
      clock.flushFrame()
      expect(textByRow.get(0)).toBe('first')
      expect(textByRow.get(1)).toBe('')
      write = true
      source.terminal.write('\x1b[1;1Halter')
      renderer.notifyWrite()
      clock.flushFrame()
      clock.flushFrame()
      expect(renderer.metrics.zigFrames).toBe(3)
      expect(textByRow.get(0)).toBe('alter')
      expect(textByRow.get(1)).toBe('second')
      expect(source.state.dirty).toBe(RenderStateDirty.False)
      expect(clock.frames.size).toBe(0)
    },
  )

  it('replaces the builder and drops queued overlay rows when the grid shrinks', async () => {
    const source = await runtimeFixture(8, 128)
    const builders = vi.spyOn(source.state, 'createFrameBuilder')
    source.terminal.write('\x1b[?25lfirst')
    const { clock, renderer } = await rendererFixture(source)
    clock.flushFrame()
    const oldBuilder = builders.mock.results[0]!.value as ZigFrameBuilder
    const dispose = vi.spyOn(oldBuilder, 'dispose')
    renderer.refreshRows(127, 127)
    source.terminal.resize({ columns: 8, rows: 2 })
    const overlayRows: number[][] = []
    const build = ZigFrameBuilder.prototype.build
    vi.spyOn(ZigFrameBuilder.prototype, 'build').mockImplementation(function (
      this: ZigFrameBuilder,
      options,
    ) {
      overlayRows.push([...options.overlayRows])
      return build.call(this, options)
    })
    renderer.resize({ columns: 8, rows: 2 })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(builders).toHaveBeenLastCalledWith(8, 2)
    expect(overlayRows.length).toBeGreaterThan(0)
    for (const rows of overlayRows) expect(rows.every((row) => row >= 0 && row < 2)).toBe(true)
    expect(renderer.metrics.zigFrames).toBe(2)
    expect(clock.frames.size).toBe(0)
    expect(() => oldBuilder.cellData).toThrow(/disposed/)
  })

  it('frees partial replacement allocations and recovers from a failed builder resize', async () => {
    const source = await runtimeFixture(8, 2)
    source.terminal.write('\x1b[?25lfirst')
    const onError = vi.fn()
    const { clock, renderer } = await rendererFixture(source, { onError })
    clock.flushFrame()
    source.terminal.resize({ columns: 9, rows: 2 })
    const memory = source.runtime.memory
    const allocate = memory.allocate.bind(memory)
    const allocations: { pointer: number; length: number }[] = []
    const injected = createGhosttyError('ghostty_wasm_alloc', 'Injected allocation failure')
    const failing = vi.spyOn(memory, 'allocate').mockImplementation((length) => {
      if (allocations.length === 2) throw injected
      const pointer = allocate(length)
      allocations.push({ pointer, length })
      return pointer
    })
    const free = vi.spyOn(memory, 'free')
    expect(() => renderer.resize({ columns: 9, rows: 2 })).not.toThrow()
    expect(onError).toHaveBeenCalledExactlyOnceWith(injected)
    expect(free.mock.calls.slice(-2)).toEqual(
      allocations.map(({ pointer, length }) => [pointer, length]),
    )
    failing.mockRestore()
    expect(() => renderer.clearTextureAtlas()).not.toThrow()
    source.terminal.resize({ columns: 8, rows: 2 })
    renderer.resize({ columns: 8, rows: 2 })
    expect(renderer.metrics.zigFrames).toBe(2)
    source.terminal.resize({ columns: 9, rows: 2 })
    renderer.resize({ columns: 9, rows: 2 })
    expect(renderer.metrics.zigFrames).toBe(3)
    expect((await renderer.capturePixels()).some((value) => value !== 0)).toBe(true)
  })

  it.each(['renderer', 'state', 'runtime'] as const)(
    'releases builder allocations once after %s disposal and cancels standing work',
    async (owner) => {
      const source = await runtimeFixture(8, 2)
      source.terminal.write('first\x1b[1 q')
      const allocate = vi.spyOn(source.runtime.memory, 'allocate')
      const builders = vi.spyOn(source.state, 'createFrameBuilder')
      const { clock, renderer } = await rendererFixture(source, { cursorBlink: true })
      renderer.setFocused(true)
      clock.flushFrame()
      const builder = builders.mock.results[0]!.value as ZigFrameBuilder
      const expectedFrees = allocate.mock.calls.map(([length], index) => [
        allocate.mock.results[index]!.value as number,
        length,
      ])
      expect(expectedFrees).toHaveLength(7)
      const free = vi.spyOn(source.runtime.memory, 'free')
      renderer.refreshRows(0, 1)
      expect(clock.frames.size).toBe(1)
      expect(clock.timers.size).toBe(1)
      if (owner === 'state') source.state.dispose()
      if (owner === 'runtime') source.runtime.dispose()
      free.mockClear()
      renderer.dispose()
      expect(free.mock.calls).toEqual(expectedFrees)
      expect(() => builder.cellData).toThrow(/disposed/)
      expect(() => builder.changedRanges()).toThrow(/disposed/)
      free.mockClear()
      renderer.dispose()
      renderer.notifyWrite()
      renderer.schedule()
      expect(free).not.toHaveBeenCalled()
      expect([clock.frames.size, clock.timers.size]).toEqual([0, 0])
    },
  )
})

describe('WebGL native atlas residency', () => {
  it('rebuilds fragmented [AB][CD] pages for ABC to ABCE with intact clean-row bytes', async () => {
    const source = await runtimeFixture(2, 2)
    const font = fittedFont()
    const theme = canonicalRendererTheme(defaultRendererTheme)
    const rasterizer = new CanvasGlyphRasterizer({ font })
    const bitmaps = Array.from('ABCDE', (text) =>
      rasterizer.rasterize({
        cellSpan: 1,
        foreground: theme.foreground,
        italic: false,
        text,
        weight: 'normal',
      })!,
    )
    expect(bitmaps.every((bitmap) => bitmap.kind === 'grayscale')).toBe(true)
    const pageWidth = 2 * Math.max(...bitmaps.map((bitmap) => bitmap.width))
    const pageHeight = Math.max(...bitmaps.map((bitmap) => bitmap.height))
    expect(3 * Math.min(...bitmaps.map((bitmap) => bitmap.width))).toBeGreaterThan(pageWidth)
    expect(2 * Math.min(...bitmaps.map((bitmap) => bitmap.height))).toBeGreaterThan(pageHeight)
    const atlas = new GlyphAtlas({ pageWidth, pageHeight, padding: 0, maxLayersPerKind: 2 })
    source.terminal.write('\x1b[?25lAB\x1b[2;1HCD')
    source.state.update()
    const builder = source.state.createFrameBuilder(2, 2)
    disposables.push(() => builder.dispose())
    const options = {
      cellHeight: font.deviceCellHeight,
      cellWidth: font.deviceCellWidth,
      full: true,
      overlayRows: new Set<number>(),
      theme,
    }
    expect(buildZigFrame(builder, atlas, rasterizer, options)).toBe(0)
    expect(atlas.pageCount).toBe(2)
    expect(atlas.evictionCount).toBe(0)
    source.state.acknowledge()
    source.terminal.write('\x1b[2;2H ')
    source.state.update()
    expect(buildZigFrame(builder, atlas, rasterizer, { ...options, full: false })).toBe(0)
    source.state.acknowledge()
    const clean = builder.glyphData.slice(0, 2 * 24)
    const builds = vi.spyOn(builder, 'build')
    source.terminal.write('\x1b[2;2HE')
    source.state.update()
    expect(buildZigFrame(builder, atlas, rasterizer, { ...options, full: false })).toBe(0)
    expect(builds.mock.results.map((result) => result.value)).toEqual([2, 2, 0])
    expect(atlas.evictionCount).toBe(1)
    const records = { cells: builder.cellData.slice(), glyphs: builder.glyphData.slice() }
    expect(buildZigFrame(builder, atlas, rasterizer, { ...options, full: true })).toBe(0)
    expect(builder.cellData).toEqual(records.cells)
    expect(builder.glyphData).toEqual(records.glyphs)
    expect(builder.glyphData.slice(0, 2 * 24)).not.toEqual(new Float32Array(clean.length))
    expect(builder.changedRanges().map((range) => range.row)).toEqual([0, 1])
    expect(builder.missingGlyphs).toEqual([])
  })

  it('keeps native glyph references independent of row zero during real page recycling', async () => {
    const source = await runtimeFixture(8, 2)
    source.terminal.write('\x1b[?25l\x1b[2;1HM')
    source.state.update()
    const builder = source.state.createFrameBuilder(8, 2)
    disposables.push(() => builder.dispose())
    const font = fittedFont()
    const theme = canonicalRendererTheme(defaultRendererTheme)
    const rasterizer = new CanvasGlyphRasterizer({ font })
    const bitmap = rasterizer.rasterize({
      cellSpan: 1,
      foreground: theme.foreground,
      italic: false,
      text: 'M',
      weight: 'normal',
    })!
    expect(bitmap.kind).toBe('grayscale')
    const atlas = new GlyphAtlas({
      maxLayersPerKind: 1,
      padding: 0,
      pageHeight: bitmap.height,
      pageWidth: bitmap.width,
    })
    const options = {
      cellHeight: font.deviceCellHeight,
      cellWidth: font.deviceCellWidth,
      full: true,
      overlayRows: new Set<number>(),
      theme,
    }
    expect(builder.build(options)).toBe(2)
    expect(registerZigGlyphs(builder, atlas, rasterizer)).toBe(true)
    expect(builder.build(options)).toBe(0)
    atlas.beginRow(0)
    const replacement = atlas.getOrInsert('replacement', bitmap, 0)
    expect(replacement.invalidatedRows).toEqual([zigGlyphRow])
    expect(atlas.evictionCount).toBe(1)
    const clearGlyphs = vi.spyOn(builder, 'clearGlyphs')
    expect(registerZigGlyphs(builder, atlas, rasterizer)).toBe(false)
    expect(builder.build(options)).toBe(2)
    // The replacement owns row zero, so a missing native glyph must reject its eviction too.
    expect(registerZigGlyphs(builder, atlas, rasterizer)).toBe(false)
    expect(clearGlyphs).toHaveBeenCalledTimes(2)
    expect(builder.build(options)).toBe(2)
    expect(builder.missingGlyphs.map((key) => builder.glyphInput(key).text)).toContain('M')
  })

  it('rebuilds native pixels after clearing the atlas and changing the fitted font', async () => {
    const { native, readRows, build } = await nativeFixture('\x1b[?25lfirst\r\nsecond')
    native.clock.flushFrame()
    const before = await expectPainted(native.renderer)
    build.mockClear()
    native.renderer.clearTextureAtlas()
    native.clock.flushFrame()
    expect(build.mock.results.map((result) => result.value)).toEqual([2, 0])
    expect(await expectPainted(native.renderer)).toEqual(before)
    build.mockClear()
    const font = fittedFont(20, 30, 24)
    native.renderer.setFont(font)
    native.clock.flushFrame()
    expect(build.mock.results.map((result) => result.value)).toEqual([2, 0])
    expect([native.canvas.width, native.canvas.height]).toEqual([32 * 20, 3 * 30])
    await expectPainted(native.renderer)
    expect(native.renderer.metrics.zigFrames).toBe(3)
    expect(readRows).not.toHaveBeenCalled()
  })

  it('recovers native atlas eviction through native retries and clean-row pixels intact', async ({
    onTestFinished,
  }) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    onTestFinished(() => page.viewport(viewport.width, viewport.height))
    await page.viewport(800, 1200)
    const nativeSource = await runtimeFixture(1, 2)
    const font = fittedFont(320, 512, 500)
    writeFrame(nativeSource, '\x1b[?25lM\x1b[2;1H_')
    const native = await rendererFixture(nativeSource, { font })
    for (const canvas of [native.canvas]) {
      const bounds = canvas.getBoundingClientRect()
      expect(bounds.left).toBeGreaterThanOrEqual(0)
      expect(bounds.top).toBeGreaterThanOrEqual(0)
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth)
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight)
    }
    flushPendingFrames(native.clock)
    const before = await expectPainted(native.renderer)
    const readRows = vi.spyOn(nativeSource.state, 'readRows')
    const glyphs = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].flatMap((letter) => [
      `\x1b[0m${letter}`,
      `\x1b[1m${letter}`,
    ])
    for (const glyph of glyphs) {
      writeFrame(nativeSource, `\x1b[1;1H${glyph}`)
      native.renderer.notifyWrite()
      flushPendingFrames(native.clock)
    }
    expect(native.renderer.metrics.atlasEvictions).toBeGreaterThan(0)
    expect(native.renderer.metrics.zigFrames).toBe(native.renderer.metrics.submittedFrames)
    expect(readRows).not.toHaveBeenCalled()
    const frames = native.renderer.metrics.zigFrames
    writeFrame(nativeSource, '\x1b[1;1H\x1b[0mZ')
    native.renderer.notifyWrite()
    flushPendingFrames(native.clock)
    expect(native.renderer.metrics.zigFrames).toBe(frames + 1)
    const after = await expectPainted(native.renderer)
    const rowBytes = native.canvas.width * font.deviceCellHeight * 4
    expectPixelsEqual(after.subarray(rowBytes), before.subarray(rowBytes))
  }, 20_000)
})

function flushPendingFrames(clock: TestClock): void {
  for (let frame = 0; frame < 8 && clock.frames.size > 0; frame += 1) clock.flushFrame()
  expect(clock.frames.size).toBe(0)
}

it('preserves active native pixels across a full-atlas recycle and bounded empty-atlas rebuild', async ({
  onTestFinished,
}) => {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  onTestFinished(() => page.viewport(viewport.width, viewport.height))
  await page.viewport(1000, 1500)
  const nativeSource = await runtimeFixture(1, 2)
  const face = new FontFace(
    'AtlasResidencyTest',
    `url(${new URL('../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2', import.meta.url).href})`,
  )
  await face.load()
  document.fonts.add(face)
  onTestFinished(() => {
    document.fonts.delete(face)
  })
  const fitted = fittedFont(400, 650, 650)
  const font = { ...fitted, settings: { ...fitted.settings, family: 'AtlasResidencyTest' } }
  writeFrame(nativeSource, '\x1b[?25lM\x1b[2;1HA')
  const insertions = vi.spyOn(GlyphAtlas.prototype, 'getOrInsert')
  const native = await rendererFixture(nativeSource, { font })
  flushPendingFrames(native.clock)
  const nativeM = atlasInsertion(insertions, 0, JSON.stringify([1, 'normal', false, 'M']))?.glyph
  if (!nativeM) expect.fail('The native renderer must register M')
  expect(nativeM.width).toBeGreaterThan(256)
  expect(nativeM.height).toBeGreaterThan(256)
  const rasterizer = new CanvasGlyphRasterizer({ font })
  const theme = canonicalRendererTheme(defaultRendererTheme)
  const seed = [...'BCDEFGHIJKLMNOPQRSTUVWXYZ']
    .flatMap((letter) => [`\x1b[0m${letter}`, `\x1b[1m${letter}`])
    .filter((content) => {
      const bitmap = rasterizer.rasterize({
        cellSpan: 1,
        foreground: theme.foreground,
        italic: false,
        text: content.slice(-1),
        weight: content.startsWith('\x1b[1m') ? 'bold' : 'normal',
      })
      return (
        bitmap &&
        bitmap.width > 256 &&
        bitmap.height > 256 &&
        bitmap.width <= 510 &&
        bitmap.height <= 510
      )
    })
  let next = 0
  while (native.renderer.metrics.atlasPages < 16 && next < seed.length) {
    writeFrame(nativeSource, `\x1b[2;1H${seed[next++]}`)
    native.renderer.notifyWrite()
    flushPendingFrames(native.clock)
  }
  expect(native.renderer.metrics.atlasPages).toBe(16)
  expect(native.renderer.metrics.atlasEvictions).toBe(0)
  const nativeReadRows = vi.spyOn(nativeSource.state, 'readRows')
  const builds = vi.spyOn(ZigFrameBuilder.prototype, 'build')
  const touches = vi.spyOn(GlyphAtlas.prototype, 'touchGlyph')
  const before = { native: { ...native.renderer.metrics } }
  for (const color of [31, 32, 33]) {
    writeFrame(nativeSource, `\x1b[1;1H\x1b[0;${color}mM`)
    native.renderer.notifyWrite()
    flushPendingFrames(native.clock)
  }
  expect(native.renderer.metrics.zigFrames).toBe(before.native.zigFrames + 3)
  expect(nativeReadRows).not.toHaveBeenCalled()
  expect(touches).not.toHaveBeenCalled()
  const warm = { native: { ...native.renderer.metrics } }
  const warmPixels = await expectPainted(native.renderer)
  let nativeFirstEviction: AtlasInsertResult | undefined
  for (; next < seed.length && !nativeFirstEviction; next++) {
    const cold = seed[next]!
    const coldKey = JSON.stringify([
      1,
      cold.startsWith('\x1b[1m') ? 'bold' : 'normal',
      false,
      cold.slice(-1),
    ])
    writeFrame(nativeSource, `\x1b[2;1H${cold}`)
    native.renderer.notifyWrite()
    const nativeCall = insertions.mock.calls.length
    const nativeEvictions = native.renderer.metrics.atlasEvictions
    flushPendingFrames(native.clock)
    if (native.renderer.metrics.atlasEvictions > nativeEvictions)
      nativeFirstEviction = atlasInsertion(insertions, nativeCall, coldKey)
  }
  if (!nativeFirstEviction)
    expect.fail('The native renderer must insert the first cold glyph after an eviction')
  const finalPixels = await expectPainted(native.renderer)
  const rowBytes = native.canvas.width * font.deviceCellHeight * 4
  expectPixelsEqual(finalPixels.subarray(0, rowBytes), warmPixels.subarray(0, rowBytes))
  expect(nativeFirstEviction.glyph.layer).not.toBe(nativeM.layer)
  expect(native.renderer.metrics.atlasEvictions - warm.native.atlasEvictions).toBe(1)
  expect(native.renderer.metrics.atlasCacheMisses - warm.native.atlasCacheMisses).toBe(3)
  expect(native.renderer.metrics.atlasUploadOperations - warm.native.atlasUploadOperations).toBe(16)
  expect(native.renderer.metrics.atlasUploadedBytes - warm.native.atlasUploadedBytes).toBe(
    16 * 512 * 512,
  )
  expect(builds.mock.results.map((result) => result.value)).toEqual([2, 0, 0, 0, 2, 2, 0])
  expect(native.renderer.metrics.zigFrames).toBe(native.renderer.metrics.submittedFrames)
  expect(nativeReadRows).not.toHaveBeenCalled()
  expect(touches.mock.calls).toEqual([
    [{ generation: nativeM.generation, kind: 'grayscale', layer: nativeM.layer }, zigGlyphRow],
  ])
}, 20_000)

function atlasInsertion(
  insertions: MockInstance<GlyphAtlas['getOrInsert']>,
  start: number,
  key: string,
): AtlasInsertResult | undefined {
  for (const result of insertions.mock.results.slice(start)) {
    if (result.type !== 'return') continue
    if (result.value.glyph.key === key) return result.value
  }
}
