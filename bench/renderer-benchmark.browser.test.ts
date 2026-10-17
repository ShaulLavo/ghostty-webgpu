import { expect, it, onTestFinished, vi } from 'vitest'
import { GhosttyRuntime } from '../src/core/runtime.js'
import { fitTerminalFont } from '../src/dom/fit.js'
import { CanvasTerminalRenderer } from '../src/render/canvas/renderer.js'
import { measuredRenderState } from './native-state.js'
import { createBenchmarkRenderer, parseBenchmarkBackend } from './renderer-factory.js'

const cases = [
  { backend: 'webgl2', path: 'instanced' },
  { backend: 'webgpu', path: 'instanced' },
] as const

it.each(cases)('benchmarks $backend with native frames and no idle work', async (sample) => {
  const runtime = await GhosttyRuntime.create()
  let created: Awaited<ReturnType<typeof createBenchmarkRenderer>> | undefined
  onTestFinished(async () => {
    await created?.renderer.dispose()
    runtime.dispose()
  })
  const font = fitTerminalFont(
    document,
    {
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      size: 13,
      weight: 400,
    },
    1,
  )
  const terminal = runtime.createTerminal({
    columns: 4,
    rows: 2,
    cellWidth: font.deviceCellWidth,
    cellHeight: font.deviceCellHeight,
  })
  const state = runtime.createRenderState(terminal)
  const decoded = { rows: 0, cells: 0 }
  const renderState = measuredRenderState(state, decoded)
  const builder = renderState.createFrameBuilder?.(4, 2)
  expect(builder?.columns).toBe(4)
  builder?.dispose()
  const errors: unknown[] = []
  const canvas = document.createElement('canvas')
  const backend = parseBenchmarkBackend(sample.backend)
  if (backend === 'ghostty-web') throw new Error('Native backend required')
  created = await createBenchmarkRenderer(backend, {
    canvas,
    columns: 4,
    rows: 2,
    font,
    renderState,
    onError: (cause) => errors.push(cause),
    onFrame: () => {},
    needsFrameRows: () => false,
  })
  expect(created.path).toBe(sample.path)
  const renderer = created.renderer
  terminal.write('Hi')
  renderer.notifyWrite()
  await vi.waitFor(() => expect(renderer.metrics.submittedFrames).toBeGreaterThan(0))
  await vi.waitFor(() => expect(renderer.hasPendingFrame).toBe(false))
  expect(errors).toEqual([])
  const submitted = renderer.metrics.submittedFrames
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(renderer.metrics.submittedFrames).toBe(submitted)
  expect(renderer.hasPendingFrame).toBe(false)
})

it.each([
  { backend: 'canvas2d', path: 'fill-text' },
  { backend: 'canvas2d-pixels', path: 'pixels' },
] as const)('selects and paints $backend in the benchmark factory', async (sample) => {
  const runtime = await GhosttyRuntime.create()
  let created: Awaited<ReturnType<typeof createBenchmarkRenderer>> | undefined
  onTestFinished(async () => {
    await created?.renderer.dispose()
    runtime.dispose()
  })
  const font = fitTerminalFont(
    document,
    {
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      size: 13,
      weight: 400,
    },
    1,
  )
  const terminal = runtime.createTerminal({
    columns: 4,
    rows: 2,
    cellWidth: font.deviceCellWidth,
    cellHeight: font.deviceCellHeight,
  })
  const state = runtime.createRenderState(terminal)
  created = await createBenchmarkRenderer(sample.backend, {
    canvas: document.createElement('canvas'),
    columns: 4,
    rows: 2,
    font,
    renderState: measuredRenderState(state, { rows: 0, cells: 0 }),
  })
  expect(created.path).toBe(sample.path)
  expect(created.renderer).toBeInstanceOf(CanvasTerminalRenderer)
  expect(Reflect.get(created.renderer, 'canvasPaintMode')).toBe(sample.path)
  terminal.write('Hi')
  created.renderer.notifyWrite()
  const renderer = created.renderer
  await vi.waitFor(() => expect(renderer.metrics.submittedFrames).toBeGreaterThan(0))
})
