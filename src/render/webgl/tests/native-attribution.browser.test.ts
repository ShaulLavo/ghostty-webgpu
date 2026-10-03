import { afterEach, expect, it } from 'vitest'
import { ComparisonTracing } from '../../../../bench/comparison-tracing.js'
import { GhosttyRuntime } from '../../../core/runtime.js'
import { WebGlTerminalRenderer } from '../renderer.js'
import { TestClock, fittedFont } from './fixture.js'

const disposables: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
})

async function fixture(zigFrame: boolean, tracing?: ComparisonTracing) {
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
    zigFrame,
    onRowsPainted: (rows) => painted.push(rows.map((row) => row.y)),
  })
  disposables.push(() => renderer.dispose())
  tracing?.nativeRenderer(0, renderer)
  clock.flushFrame()
  expect(clock.frames.size).toBe(0)
  return { clock, painted, renderer, terminal }
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

it('distinguishes native warm builds, missing-glyph retry uploads and unsupported fallback', async ({
  onTestFinished,
}) => {
  const original = location.href
  const url = new URL(original)
  url.searchParams.set('trace', '')
  history.replaceState(null, '', url)
  onTestFinished(() => history.replaceState(null, '', original))
  const tracing = new ComparisonTracing()
  const native = await fixture(true, tracing)
  const js = await fixture(false)
  for (const control of [
    { name: 'warm', content: viewport('NM'.repeat(20)), writes: 12, bytes: 46_080, submits: 1 },
    { name: 'unchanged', content: viewport('NM'.repeat(20)), writes: 0, bytes: 0, submits: 0 },
    {
      name: 'missing',
      content: `\x1b[31;44m${viewport('Z'.repeat(40))}`,
      writes: 24,
      bytes: 76_800,
      submits: 1,
    },
    {
      name: 'unsupported',
      content: viewport('界'.repeat(20)),
      writes: 2,
      bytes: 76_800,
      submits: 1,
    },
  ]) {
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
      expect(observed.zigGlyphIndexClears ?? 0).toBe(0)
    }
    if (control.name === 'missing') {
      expect(observed.zigBuilds).toBe(2)
      expect(observed.zigReadyBuilds).toBe(1)
      expect(observed.zigMissingGlyphBuilds).toBe(1)
      expect(observed.zigGlyphIndexClears ?? 0).toBe(0)
      const builds = operations(records, 'build')
      expect(builds).toHaveLength(2)
      expect(builds[0]!.end).toBeLessThanOrEqual(builds[1]!.start)
    }
    if (control.name === 'unsupported') {
      expect(observed.zigBuilds).toBe(1)
      expect(observed.zigUnsupportedBuilds).toBe(1)
      expect(observed.zigReadyBuilds ?? 0).toBe(0)
      expect(observed.zigGlyphIndexClears).toBe(1)
      expect(observed.zigFallbackFrames).toBe(1)
    }
    js.terminal.write(control.content)
    js.renderer.notifyWrite()
    js.clock.flushFrame()
    expect(js.clock.frames.size).toBe(0)
    const pixels = await native.renderer.capturePixels()
    expect(pixels).toEqual(await js.renderer.capturePixels())
    expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
    if (control.name === 'missing') expect(pixels[3]).toBe(255)
    expect(native.painted.at(-1)).toEqual(Array.from({ length: 12 }, (_, index) => index))
  }
}, 20_000)
