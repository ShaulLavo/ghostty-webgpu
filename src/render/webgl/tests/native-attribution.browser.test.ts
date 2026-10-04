import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ComparisonTracing } from '../../../../bench/comparison-tracing.js'
import { GhosttyRuntime } from '../../../core/runtime.js'
import type { ZigFrameBuilder } from '../../../core/zig-frame.js'
import { CELL_INSTANCE_BYTES, GLYPH_INSTANCE_BYTES } from '../../instances/layout.js'
import { WebGlTerminalRenderer } from '../renderer.js'
import type { WebGlTextPass } from '../text-pass.js'
import { TestClock, displayedPixels, fittedFont } from './fixture.js'

const disposables: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
})

async function fixture(tracing?: ComparisonTracing) {
  const runtime = await GhosttyRuntime.create()
  disposables.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns: 40, rows: 12 })
  const state = runtime.createRenderState(terminal)
  tracing?.native(0, terminal, state)
  terminal.write(`\x1b[?25l${viewport('MN'.repeat(20))}`)
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  disposables.push(() => {
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
    canvas.remove()
  })
  const clock = new TestClock()
  const painted: number[][] = []
  const renderer = await WebGlTerminalRenderer.create({
    canvas,
    columns: 40,
    rows: 12,
    renderState: state,
    font: fittedFont(),
    schedulerClock: clock,
    onRowsPainted: (rows) => painted.push(rows.map((row) => row.y)),
  })
  disposables.push(() => renderer.dispose())
  tracing?.nativeRenderer(0, renderer)
  clock.flushFrame()
  expect(clock.frames.size).toBe(0)
  return { canvas, clock, painted, renderer, terminal }
}

function viewport(line: string): string {
  return `\x1b[1;1H${Array.from({ length: 12 }, () => line).join('\r\n')}`
}

function counts(records: ReturnType<ComparisonTracing['end']>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const counter of records.counters)
    result[counter.operation] = (result[counter.operation] ?? 0) + counter.value
  return result
}

function operations(records: ReturnType<ComparisonTracing['end']>, operation: string) {
  return records.spans.filter((span) => span.operation === operation)
}

it('distinguishes native warm builds and ASCII or Unicode missing-glyph retry uploads', async ({
  onTestFinished,
}) => {
  const original = location.href
  const previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(800, 700)
  onTestFinished(() => page.viewport(previousViewport.width, previousViewport.height))
  const url = new URL(original)
  url.searchParams.set('trace', '')
  history.replaceState(null, '', url)
  onTestFinished(() => history.replaceState(null, '', original))
  const tracing = new ComparisonTracing()
  const native = await fixture(tracing)
  for (const canvas of [native.canvas]) {
    const bounds = canvas.getBoundingClientRect()
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth)
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight)
    expect([bounds.width, bounds.height]).toEqual([canvas.width, canvas.height])
  }
  const builder = Reflect.get(native.renderer, 'zigBuilder') as ZigFrameBuilder
  const pass = Reflect.get(native.renderer, 'state').pass as WebGlTextPass
  const context = Reflect.get(native.renderer, 'context') as WebGL2RenderingContext
  const builds = vi.spyOn(builder, 'build')
  const uploads = vi.spyOn(pass, 'uploadFrame')
  const bufferWrites = vi.spyOn(context, 'bufferSubData')
  onTestFinished(() => {
    builds.mockRestore()
    uploads.mockRestore()
    bufferWrites.mockRestore()
  })
  for (const control of [
    { name: 'warm', content: viewport('NM'.repeat(20)), writes: 1, bytes: 46_080, submits: 1 },
    { name: 'unchanged', content: viewport('NM'.repeat(20)), writes: 0, bytes: 0, submits: 0 },
    {
      name: 'missing',
      content: `\x1b[31;44m${viewport('Z'.repeat(40))}`,
      writes: 2,
      bytes: 76_800,
      submits: 1,
    },
    {
      name: 'unicode',
      content: viewport('界'.repeat(20)),
      // A cold native retry uploads the full extents of both instance buffers.
      writes: 2,
      bytes: 76_800,
      submits: 1,
    },
  ]) {
    builds.mockClear()
    uploads.mockClear()
    bufferWrites.mockClear()
    const before = { ...native.renderer.metrics }
    tracing.begin()
    native.terminal.write(control.content)
    native.renderer.notifyWrite()
    native.clock.flushFrame()
    expect(native.clock.frames.size).toBe(0)
    const records = tracing.end()
    const observed = counts(records)
    expect(observed.stateUpdates).toBe(1)
    expect(observed.buffersWritten).toBe(control.writes)
    expect(observed.bufferBytes).toBe(control.bytes)
    expect(bufferWrites).toHaveBeenCalledTimes(control.writes)
    expect(bufferWrites.mock.calls.reduce((sum, args) => sum + Number(args[4]) * 4, 0)).toBe(
      control.bytes,
    )
    expect(native.renderer.metrics.uploadedBytes - before.uploadedBytes).toBe(control.bytes)
    expect(native.renderer.metrics.instanceUploadOperations - before.instanceUploadOperations).toBe(
      control.writes,
    )
    expect(native.renderer.metrics.zigFrames - before.zigFrames).toBe(control.submits)
    expect(observed.zigFrames ?? 0).toBe(control.submits)
    expect(observed.zigUnsupportedBuilds ?? 0).toBe(0)
    expect(observed.zigGlyphIndexClears ?? 0).toBe(0)
    expect(observed.submissions ?? 0).toBe(control.submits)
    expect(observed.rowsCopied).toBe(12)
    expect(observed.cellsCopied).toBe(480)
    expect(observed.frames ?? 0).toBe(control.submits)
    expect(operations(records, 'drawFrame')).toHaveLength(1)
    expect(operations(records, 'uploadFrame')).toHaveLength(1)
    expect(operations(records, 'submit')).toHaveLength(control.submits)
    expect(observed.instanceUploadBatches ?? 0).toBe(control.submits)
    if (control.name === 'warm' || control.name === 'unchanged') {
      expect(observed.zigBuilds).toBe(1)
      expect(observed.zigReadyBuilds).toBe(1)
      expect(observed.zigMissingGlyphBuilds ?? 0).toBe(0)
      expect(builds.mock.results.map((result) => result.value)).toEqual([0])
    }
    if (control.name === 'missing' || control.name === 'unicode') {
      expect(observed.zigBuilds).toBe(2)
      expect(observed.zigReadyBuilds).toBe(1)
      expect(observed.zigMissingGlyphBuilds).toBe(1)
      expect(builds.mock.results.map((result) => result.value)).toEqual([2, 0])
      const spans = operations(records, 'build')
      expect(spans).toHaveLength(2)
      expect(spans[0]!.end).toBeLessThanOrEqual(spans[1]!.start)
      expect(uploads).toHaveBeenCalledTimes(1)
      expect(uploads.mock.calls[0]![1]).toEqual(
        Array.from({ length: 12 }, (_, row) => ({
          row,
          cell: {
            byteOffset: row * 40 * CELL_INSTANCE_BYTES,
            byteLength: 40 * CELL_INSTANCE_BYTES,
          },
          glyph: {
            byteOffset: row * 40 * GLYPH_INSTANCE_BYTES,
            byteLength: 40 * GLYPH_INSTANCE_BYTES,
          },
        })),
      )
      expect(
        bufferWrites.mock.calls.map((args) => ({
          byteOffset: args[1],
          sourceOffset: args[3],
          byteLength: Number(args[4]) * 4,
        })),
      ).toEqual([
        {
          byteOffset: 0,
          sourceOffset: 0,
          byteLength: 12 * 40 * CELL_INSTANCE_BYTES,
        },
        {
          byteOffset: 0,
          sourceOffset: 0,
          byteLength: 12 * 40 * GLYPH_INSTANCE_BYTES,
        },
      ])
    }
    const submittedFrames = native.renderer.metrics.submittedFrames
    const pixels = await displayedPixels(native.canvas)
    expect(native.renderer.metrics.submittedFrames).toBe(submittedFrames)
    expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
    if (control.name === 'missing') expect(pixels[3]).toBe(255)
    expect(native.painted.at(-1)).toEqual(Array.from({ length: 12 }, (_, index) => index))
    if (control.name === 'unicode')
      await page.screenshot({
        element: native.canvas,
        path: '../../../../.artifacts/native-unicode-attribution.png',
        scale: 'css',
      })
  }
}, 20_000)
