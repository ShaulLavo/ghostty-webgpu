import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { ZigFrameBuilder } from '../../core/zig-frame.js'
import { WebGpuTerminalRenderer } from '../../render/renderer.js'
import { WebGlTerminalRenderer } from '../../render/webgl/renderer.js'
import { displayedPixels } from '../../render/webgl/tests/fixture.js'
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

async function hostFixture(zigFrame: false | undefined, backend: 'webgl2' | 'webgpu' = 'webgl2') {
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
      grid: { columns: 12, pixelRatio: 1, rows: 3 },
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
        renderer = await WebGpuTerminalRenderer.create(options)
        return renderer
      }
      renderer = await WebGlTerminalRenderer.create(options)
      return renderer
    },
  })
  disposables.push(() => terminal.dispose())
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error))
  await terminal.open(host)
  expect(renderer).toBeDefined()
  return { canvas: host.querySelector('canvas')!, errors, renderer: renderer!, terminal }
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
  'uses whole-frame Unicode fallback and returns to the default native producer (%s)',
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
    expect(build.mock.results.map((result) => result.value)).toEqual([1])
    expect(native.renderer.metrics.zigFrames).toBe(nativeFrames)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(1)
    build.mockClear()
    for (const host of [native, js]) host.terminal.write('\x1b[1;1Hchanged')
    await expectHostParity(native, js)
    expect(build.mock.results.map((result) => result.value)).toEqual([1])
    expect(native.renderer.metrics.zigFrames).toBe(nativeFrames)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(2)
    build.mockClear()
    for (const host of [native, js]) host.terminal.write('\x1b[3;1H\x1b[2KASCII')
    await expectHostParity(native, js)
    expect(build.mock.results.at(-1)?.value).toBe(0)
    expect(native.renderer.metrics.zigFrames).toBeGreaterThan(nativeFrames)
    expect(native.renderer.metrics.jsFallbackFrames).toBe(2)
    expect(js.renderer.metrics.zigFrames).toBe(0)
    for (const host of [native, js]) {
      host.terminal.dispose()
      expect(host.terminal.hasPendingFrame).toBe(false)
      expect(host.terminal.hasPendingTimer).toBe(false)
    }
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
