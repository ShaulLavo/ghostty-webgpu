import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { ZigFrameBuilder } from '../../core/zig-frame.js'
import { WebGlTerminalRenderer } from '../../render/webgl/renderer.js'
import { displayedPixels } from '../../render/webgl/tests/fixture.js'
import { TerminalSession } from '../../term/session.js'
import { createGhosttyWebGpuTerminalFromSession } from '../terminal.js'

const disposables: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
})

async function hostFixture(zigFrame: false | undefined) {
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
  let renderer: WebGlTerminalRenderer | undefined
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    ...(zigFrame === undefined ? {} : { zigFrame }),
    rendererFactory: async (options) => {
      expect(options.zigFrame).toBe(zigFrame)
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

it.each([undefined, false] as const)(
  'preserves the WebGL producer choice through the real Terminal host (zigFrame=%s)',
  async (zigFrame) => {
    const { terminal, renderer, errors } = await hostFixture(zigFrame)
    terminal.write('\x1b[?25l\x1b[31;44mASCII')
    await expect.poll(() => terminal.hasPendingFrame).toBe(false)
    expect(terminal.diagnostics.rendererBackend).toBe('webgl2')
    expect(renderer.metrics.submittedFrames).toBeGreaterThan(0)
    expect(renderer.metrics.jsFallbackFrames).toBe(0)
    if (zigFrame === undefined) expect(renderer.metrics.zigFrames).toBeGreaterThan(0)
    if (zigFrame === false) expect(renderer.metrics.zigFrames).toBe(0)
    expect((await renderer.capturePixels()).some((value) => value !== 0)).toBe(true)
    expect(errors).toEqual([])
    terminal.dispose()
    expect(terminal.hasPendingFrame).toBe(false)
    expect(terminal.hasPendingTimer).toBe(false)
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
