import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import {
  GhosttyRuntime,
  Terminal,
  WebGpuTerminalRenderer,
  type GhosttyWebGpuRendererFactory,
  type GhosttyWebGpuTerminalOptions,
} from '../../../../dist/index.js'
import { WebGlTerminalRenderer } from '../../../../dist/render/webgl/renderer.js'
import { FallbackTerminalRenderer } from '../../../../dist/render/shared/fallback.js'
import { CanvasTerminalRenderer } from '../../../../dist/render/canvas/renderer.js'
import { createShaderAddon, type CompiledShader } from '../../dist/index.js'
import { frameUniforms, UniformState } from '../../dist/terminal-uniforms.js'
import { Terminal as WorkerTerminal } from '../../../../dist/worker/index.js'
import { testFontUrl } from '../../../../src/tests/fonts.js'
import { copyShader, greenShader, language, uniformShader, timeShader } from './artifacts.js'

const cleanups: (() => unknown)[] = []
let runtime: GhosttyRuntime
beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(() => runtime.dispose())

type SourceBackend = 'webgpu' | 'webgl2' | 'canvas2d' | 'pixels'

function factory(backend: SourceBackend): GhosttyWebGpuRendererFactory {
  if (backend === 'webgpu')
    return (options) => WebGpuTerminalRenderer.create({ ...options, adapterPolicy: 'any' })
  if (backend === 'webgl2')
    return (options) =>
      options.replaceCanvas
        ? FallbackTerminalRenderer.create(options, options.replaceCanvas)
        : WebGlTerminalRenderer.create(options)
  return (options) =>
    CanvasTerminalRenderer.create({
      ...options,
      rendererMode: backend === 'pixels' ? 'canvas2d-pixels' : 'canvas2d-fill-text',
    })
}

async function fixture(
  backend: SourceBackend,
  shader: CompiledShader = copyShader,
  beforeOpen = false,
  output?: 'webgpu' | 'webgl2',
  existing = false,
  content = '\x1b[?25l\x1b[48;2;255;0;0m          \r\n\x1b[48;2;0;255;0m          \r\n\x1b[48;2;0;0;255m          ',
  overrides: Pick<GhosttyWebGpuTerminalOptions, 'rendererFactory'> = {},
) {
  const host = document.createElement('div')
  host.style.cssText = 'width:340px;height:180px'
  document.body.append(host)
  cleanups.push(() => host.remove())
  const terminal = await Terminal.create({
    appearance: {
      grid: { columns: 10, rows: 3, pixelRatio: 2 },
      cursor: { blink: false },
      font: { family: 'monospace', size: 16 },
    },
    padding: { top: 9, left: 13, bottom: 4, right: 6 },
    fitEnvironment: {
      requestFrame: () => 0,
      cancelFrame: () => {},
      getPixelRatio: () => 2,
      subscribePixelRatio: () => () => {},
      createResizeObserver: () => ({ observe: () => {}, disconnect: () => {} }),
    },
    rendererFactory: overrides.rendererFactory ?? factory(backend),
    runtime: { kind: 'borrowed', runtime },
  })
  cleanups.push(() => terminal.dispose())
  const errors: unknown[] = []
  terminal.on('error', (event) => errors.push(event))
  const addon = createShaderAddon(shader, {
    backend: output,
    onError: (error) => errors.push(error),
  })
  if (!beforeOpen) {
    await terminal.open(host)
    terminal.write('\x1b[?25l')
  }
  if (existing) {
    terminal.write(content)
    const source = terminal.canvas
    if (!source) throw new TypeError('Missing presented source')
    await expect.poll(async () => pixel(await pixels(source), 0.5, 1 / 6)).toEqual([255, 0, 0])
    await frames(2)
  }
  const handle = terminal.use(addon)
  cleanups.push(() => handle.dispose())
  if (beforeOpen) await terminal.open(host)
  await handle.api.ready
  if (!existing) terminal.write(content)
  await expect
    .poll(
      () =>
        terminal.element?.querySelector<HTMLCanvasElement>('[data-ghostty-shader]')?.style.display,
    )
    .toBe('block')
  const canvas = terminal.element?.querySelector<HTMLCanvasElement>('[data-ghostty-shader]')
  if (!canvas) throw new TypeError('Missing shader output')
  return { terminal, canvas, handle, errors, host }
}

async function pixels(canvas: HTMLCanvasElement): Promise<ImageData> {
  const png = await page.screenshot({ element: canvas, save: false })
  const image = new Image()
  image.src = `data:image/png;base64,${png}`
  await image.decode()
  const read = document.createElement('canvas')
  read.width = image.naturalWidth
  read.height = image.naturalHeight
  const context = read.getContext('2d')
  if (!context) throw new TypeError('Missing pixel reader')
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, read.width, read.height)
}
function pixel(image: ImageData, x: number, y: number): number[] {
  const offset = (Math.floor(y * image.height) * image.width + Math.floor(x * image.width)) * 4
  return Array.from(image.data.subarray(offset, offset + 3))
}
async function color(canvas: HTMLCanvasElement): Promise<number[]> {
  return pixel(await pixels(canvas), 0.5, 0.5)
}

const captureBackends = [
  { source: 'webgpu', output: 'webgpu' },
  { source: 'webgpu', output: 'webgl2' },
  { source: 'webgl2', output: 'webgpu' },
  { source: 'webgl2', output: 'webgl2' },
  { source: 'canvas2d', output: 'webgpu' },
  { source: 'canvas2d', output: 'webgl2' },
] satisfies { source: 'webgpu' | 'webgl2' | 'canvas2d'; output: 'webgpu' | 'webgl2' }[]

const transparentBlank = '\x1b[?25l\x1b[0m\x1b[2J\x1b[H'
const transparentGlyphs = `${transparentBlank}\x1b[38;2;255;255;255mAgjmW`

async function transparentFixture(backend: (typeof captureBackends)[number], content: string) {
  const f = await fixture(backend.source, copyShader, false, backend.output, false, content)
  await frames(3)
  expect(f.terminal.diagnostics.rendererBackend).toBe(backend.source)
  expect(f.canvas.dataset['backend']).toBe(backend.output)
  return f
}

function differentPixels(actual: ImageData, expected: ImageData): number {
  expect([actual.width, actual.height]).toEqual([expected.width, expected.height])
  let count = 0
  for (let offset = 0; offset < actual.data.length; offset += 4) {
    if (
      actual.data[offset] !== expected.data[offset] ||
      actual.data[offset + 1] !== expected.data[offset + 1] ||
      actual.data[offset + 2] !== expected.data[offset + 2] ||
      actual.data[offset + 3] !== expected.data[offset + 3]
    )
      count += 1
  }
  return count
}

async function afterFrame(terminal: Terminal, action: () => void): Promise<void> {
  await new Promise<void>((resolve) => {
    const subscription = terminal.on('frame', () => {
      subscription.dispose()
      resolve()
    })
    action()
  })
  await frames(3)
}

it.each(captureBackends)(
  'replaces erased transparent pixels from $source with $output output',
  async ({ source, output }) => {
    const actual = await transparentFixture({ source, output }, transparentGlyphs)
    const expected = await transparentFixture({ source, output }, transparentBlank)
    const reference = await pixels(expected.canvas)
    expect(differentPixels(await pixels(actual.canvas), reference)).toBeGreaterThan(0)
    const dimensions = [actual.canvas.width, actual.canvas.height]
    await afterFrame(actual.terminal, () => actual.terminal.write(transparentBlank))
    expect([actual.canvas.width, actual.canvas.height]).toEqual(dimensions)
    expect(actual.terminal.visibleLines()).toEqual(expected.terminal.visibleLines())
    expect(actual.errors.concat(expected.errors)).toEqual([])
    await page.screenshot({
      element: actual.canvas,
      path: `../../.artifacts/erase-${source}-${output}-actual.png`,
    })
    await page.screenshot({
      element: expected.canvas,
      path: `../../.artifacts/erase-${source}-${output}-expected.png`,
    })
    expect(differentPixels(await pixels(actual.canvas), reference)).toBe(0)
  },
)

it.each(captureBackends)(
  'keeps repeated antialiased glyphs equal to a fresh $source frame with $output output',
  async ({ source, output }) => {
    const actual = await transparentFixture({ source, output }, transparentGlyphs)
    const first = await pixels(actual.canvas)
    expect(first.data.some((value, i) => i % 4 === 0 && value > 0 && value < 255)).toBe(true)
    for (let repeat = 0; repeat < 4; repeat += 1)
      await afterFrame(actual.terminal, () => actual.terminal.clearTextureAtlas())
    const expected = await transparentFixture({ source, output }, transparentGlyphs)
    const reference = await pixels(expected.canvas)
    expect(reference.data.some((value, i) => i % 4 === 0 && value > 0 && value < 255)).toBe(true)
    expect(actual.errors.concat(expected.errors)).toEqual([])
    await page.screenshot({
      element: actual.canvas,
      path: `../../.artifacts/repeated-${source}-${output}-actual.png`,
    })
    await page.screenshot({
      element: expected.canvas,
      path: `../../.artifacts/repeated-${source}-${output}-expected.png`,
    })
    expect(differentPixels(await pixels(actual.canvas), reference)).toBe(0)
  },
)

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'retains transparent glyph snapshots through a no-draw WebGL publication with %s output',
  async (output) => {
    const f = await transparentFixture({ source: 'webgl2', output }, transparentGlyphs)
    const reference = await pixels(f.canvas)
    const context = f.terminal.canvas?.getContext('webgl2')
    if (!context) throw new TypeError('Missing source WebGL context')
    const draws = vi.spyOn(context, 'drawArraysInstanced')
    cleanups.push(() => draws.mockRestore())
    await afterFrame(f.terminal, () => f.terminal.refresh(0, 2))
    expect(draws).not.toHaveBeenCalled()
    expect(differentPixels(await pixels(f.canvas), reference)).toBe(0)
    expect(f.errors).toEqual([])
  },
)

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'captures top and bottom source colors with default full artifacts on %s',
  async (backend) => {
    const f = await fixture(backend, copyShader, true)
    expect(f.canvas.dataset['backend']).toBe(backend)
    await expect.poll(async () => pixel(await pixels(f.canvas), 0.5, 1 / 6)).toEqual([255, 0, 0])
    const image = await pixels(f.canvas)
    const top = pixel(image, 0.5, 1 / 6)
    const bottom = pixel(image, 0.5, 5 / 6)
    expect(top[0]).toBeGreaterThan(100)
    expect(top[2]).toBeLessThan(30)
    expect(bottom[0]).toBeLessThan(30)
    expect(bottom[2]).toBeGreaterThan(100)
    await page.screenshot({ element: f.host, path: `../../.artifacts/orientation-${backend}.png` })
    const source = f.terminal.canvas
    if (!source) throw new TypeError('Missing source')
    const sourceRect = source.getBoundingClientRect()
    const rect = f.canvas.getBoundingClientRect()
    expect(rect.left - sourceRect.left).toBe(13)
    expect(rect.top - sourceRect.top).toBe(9)
    expect(f.canvas.width).toBe(source.width)
    expect(rect.width).toBeCloseTo(sourceRect.width - 19, 0)
    expect(getComputedStyle(f.canvas).pointerEvents).toBe('none')
    f.terminal.focus()
    expect(document.activeElement).toBe(f.terminal.textarea)
    expect(f.errors).toEqual([])
    f.handle.dispose()
    expect(f.canvas.isConnected).toBe(false)
    expect(f.terminal.canvas).toBe(source)
    expect(f.terminal.lifecycle).toBe('open')
    f.terminal.write('still alive')
  },
)

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'accepts one-language output, newest wins and failed replacements retain the last shader on %s',
  async (backend) => {
    const f = await fixture(backend, language(copyShader, backend), false, backend)
    const first = f.handle.api.setShader(language(copyShader, backend))
    const latest = f.handle.api.setShader(language(greenShader, backend))
    expect(await first).toBe(false)
    expect(await latest).toBe(true)
    await expect.poll(() => color(f.canvas)).toEqual([0, 255, 0])
    const bad = backend === 'webgpu' ? { wgsl: 'invalid shader' } : { glsl: 'invalid shader' }
    await expect(f.handle.api.setShader(bad)).rejects.toThrow()
    expect(await color(f.canvas)).toEqual([0, 255, 0])
    const missing = backend === 'webgpu' ? { glsl: 'shader' } : { wgsl: 'shader' }
    await expect(f.handle.api.setShader(missing)).rejects.toThrow('requires compiled')
    expect(await color(f.canvas)).toEqual([0, 255, 0])
    expect(f.errors).toEqual([])
  },
)

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'updates theme/cursor while paused and cleans terminal disposal on %s',
  async (backend) => {
    const f = await fixture(backend, language(uniformShader, backend), false, backend)
    f.handle.api.setPaused(true)
    f.terminal.setTheme({ ...f.terminal.appearance.theme, background: { r: 128, g: 0, b: 0 } })
    f.terminal.write('\x1b[2J\x1b[H\x1b[?25h')
    f.terminal.focus()
    await expect.poll(() => color(f.canvas)).toEqual([128, 255, 0])
    f.terminal.write('\x1b[2;3H')
    await expect.poll(async () => (await color(f.canvas))[2]).toBeGreaterThan(30)
    f.terminal.setFont({ size: 20 })
    await expect.poll(() => f.canvas.width).toBe(f.terminal.canvas?.width)
    f.terminal.dispose()
    expect(f.canvas.isConnected).toBe(false)
    expect(f.errors).toEqual([])
  },
)

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'uses submitted cursor visibility for hidden and suppressed cursors on %s',
  async (backend) => {
    const f = await fixture(backend)
    const state = new UniformState()
    const read = () => frameUniforms(f.terminal, state, { time: 1, delta: 0, frame: 0 }, f.canvas)
    await expect.poll(() => f.terminal.submittedFrame?.paintedCursor?.visible).toBe(false)
    expect(read().iCursorVisible).toBe(0)
    f.terminal.write('\x1b[?25h')
    await expect.poll(() => f.terminal.submittedFrame?.paintedCursor?.visible).toBe(true)
    expect(read().iCursorVisible).toBe(1)
    f.terminal.setCursorInactiveStyle('none')
    await expect.poll(() => f.terminal.submittedFrame?.paintedCursor?.visible).toBe(false)
    expect(read().iCursorVisible).toBe(0)
  },
)

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'tracks submitted cursor style transitions independently of appearance on %s',
  async (backend) => {
    const f = await fixture(backend)
    const state = new UniformState()
    const read = (time: number) =>
      frameUniforms(f.terminal, state, { time, delta: 0, frame: 0 }, f.canvas)
    f.terminal.setCursor({ style: 'block', blink: false })
    f.terminal.write('\x1b[?25h')
    await expect.poll(() => f.terminal.submittedFrame?.paintedCursor?.visible).toBe(true)
    await expect.poll(() => f.terminal.submittedFrame?.paintedCursor?.style).toBe('block')
    expect(read(1).iCurrentCursorStyle).toBe(0)
    f.terminal.setCursorInactiveStyle('bar')
    await expect.poll(() => f.terminal.submittedFrame?.paintedCursor?.style).toBe('bar')
    expect(f.terminal.appearance.cursor.style).toBe('block')
    expect(read(2)).toMatchObject({
      iCurrentCursorStyle: 2,
      iPreviousCursorStyle: 0,
      iTimeCursorChange: 2,
    })
    f.terminal.setCursorInactiveStyle('underline')
    await expect.poll(() => f.terminal.submittedFrame?.paintedCursor?.style).toBe('underline')
    expect(read(3)).toMatchObject({
      iCurrentCursorStyle: 3,
      iPreviousCursorStyle: 2,
      iTimeCursorChange: 3,
    })
  },
)

it('freezes effect time while paused, resumes and keeps capture current', async () => {
  const f = await fixture('webgl2', timeShader)
  f.handle.api.setPaused(true)
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  const paused = await color(f.canvas)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(await color(f.canvas)).toEqual(paused)
  f.handle.api.setPaused(false)
  await expect.poll(async () => (await color(f.canvas))[0]).not.toBe(paused[0])
})

it('follows a replaced terminal canvas during renderer recovery', async () => {
  const f = await fixture('webgl2', copyShader)
  const original = f.terminal.canvas
  const lost = original?.getContext('webgl2')?.getExtension('WEBGL_lose_context')
  if (!lost) throw new TypeError('Missing source loss extension')
  lost.loseContext()
  await expect.poll(() => f.terminal.canvas).not.toBe(original)
  f.terminal.write('\x1b[H\x1b[45m          ')
  await expect.poll(async () => pixel(await pixels(f.canvas), 0.5, 1 / 6)[2]).toBeGreaterThan(100)
})

it('disposes during async initialization and keeps the terminal usable', async () => {
  const f = await fixture('webgl2')
  f.handle.dispose()
  const pending = f.terminal.use(createShaderAddon(copyShader, { backend: 'webgpu' }))
  pending.dispose()
  await expect(pending.api.ready).rejects.toThrow('disposed')
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(f.terminal.element?.querySelectorAll('[data-ghostty-shader]').length).toBe(0)
  expect(f.terminal.lifecycle).toBe('open')
})

it('defaults full artifacts to WebGL2 when WebGPU is unavailable, with strict explicit selection', async () => {
  const adapter = vi.spyOn(navigator.gpu, 'requestAdapter').mockResolvedValue(null)
  cleanups.push(() => adapter.mockRestore())
  const f = await fixture('canvas2d', copyShader)
  expect(f.canvas.dataset['backend']).toBe('webgl2')
  const image = await pixels(f.canvas)
  expect(pixel(image, 0.5, 1 / 6)[0]).toBeGreaterThan(100)
  expect(pixel(image, 0.5, 5 / 6)[2]).toBeGreaterThan(100)
  await expect(fixture('canvas2d', copyShader, false, 'webgpu')).rejects.toThrow('unavailable')
  expect(f.errors).toEqual([])
})

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'captures an unchanged terminal installed after its source buffer was presented on %s',
  async (backend) => {
    const f = await fixture(backend, copyShader, false, undefined, true)
    await expect.poll(async () => pixel(await pixels(f.canvas), 0.5, 1 / 6)).toEqual([255, 0, 0])
    f.terminal.refresh(0, 2)
    await frames(3)
    expect(pixel(await pixels(f.canvas), 0.5, 1 / 6)).toEqual([255, 0, 0])
  },
)

it('bounds unfinished WebGPU submissions and retains the latest source state', async () => {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new TypeError('Missing test WebGPU adapter')
  const device = await adapter.requestDevice()
  cleanups.push(() => device.destroy())
  let release = () => {}
  const pending = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined)
  })
  cleanups.push(() => release())
  const acquireAdapter = vi.spyOn(navigator.gpu, 'requestAdapter').mockResolvedValue(adapter)
  const acquireDevice = vi.spyOn(adapter, 'requestDevice').mockResolvedValue(device)
  const completed = device.queue.onSubmittedWorkDone.bind(device.queue)
  const completion = vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(completed)
  completion.mockReturnValueOnce(pending)
  const submits = vi.spyOn(device.queue, 'submit')
  cleanups.push(() => {
    acquireAdapter.mockRestore()
    acquireDevice.mockRestore()
    completion.mockRestore()
    submits.mockRestore()
  })
  const f = await fixture('canvas2d', copyShader, false, 'webgpu')
  f.terminal.write('\x1b[H\x1b[48;2;255;0;255m          ')
  await frames(4)
  expect(submits).toHaveBeenCalledTimes(1)
  expect(completion).toHaveBeenCalledTimes(1)
  await completed()
  release()
  await expect.poll(async () => pixel(await pixels(f.canvas), 0.5, 1 / 6)).toEqual([255, 0, 255])
  expect(f.errors).toEqual([])
})

it('bounds unfinished WebGL2 submissions and retains the latest source state', async () => {
  const wait = vi
    .spyOn(WebGL2RenderingContext.prototype, 'clientWaitSync')
    .mockReturnValue(WebGL2RenderingContext.TIMEOUT_EXPIRED)
  const draws = vi.spyOn(WebGL2RenderingContext.prototype, 'drawArrays')
  const uploads = vi.spyOn(WebGL2RenderingContext.prototype, 'texImage2D')
  cleanups.push(() => {
    wait.mockRestore()
    draws.mockRestore()
    uploads.mockRestore()
  })
  const f = await fixture('canvas2d', copyShader, false, 'webgl2')
  f.terminal.write('\x1b[H\x1b[48;2;255;0;255m          ')
  await frames(4)
  expect(draws).toHaveBeenCalledTimes(1)
  expect(uploads).toHaveBeenCalledTimes(1)
  wait.mockRestore()
  await expect.poll(async () => pixel(await pixels(f.canvas), 0.5, 1 / 6)).toEqual([255, 0, 255])
  expect(f.errors).toEqual([])
})

it('removes failed output resources while keeping the source terminal alive', async () => {
  const f = await fixture('webgl2')
  const source = f.terminal.canvas
  const lose = f.canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
  if (!lose) throw new TypeError('Missing output loss extension')
  lose.loseContext()
  await expect.poll(() => f.canvas.isConnected).toBe(false)
  expect(f.errors).toMatchObject([{ code: 'gpu' }])
  expect(f.terminal.canvas).toBe(source)
  expect(f.terminal.lifecycle).toBe('open')
  f.terminal.write('still alive')
})

it('freezes hidden effect time and presents terminal writes after visibility resumes', async () => {
  const f = await fixture('webgl2', timeShader)
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  cleanups.push(() => hidden.mockRestore())
  document.dispatchEvent(new Event('visibilitychange'))
  await frames(2)
  const stopped = await color(f.canvas)
  await frames(4)
  expect(await color(f.canvas)).toEqual(stopped)
  f.terminal.write('\x1b[H\x1b[48;2;255;0;255m          ')
  hidden.mockRestore()
  document.dispatchEvent(new Event('visibilitychange'))
  await f.handle.api.setShader(copyShader)
  await expect.poll(async () => pixel(await pixels(f.canvas), 0.5, 1 / 6)).toEqual([255, 0, 255])
  expect(f.errors).toEqual([])
})

it('clearly rejects asynchronous worker capture and removes its overlay', async () => {
  const host = document.createElement('div')
  host.style.cssText = 'width:340px;height:180px'
  document.body.append(host)
  cleanups.push(() => host.remove())
  const terminal = await WorkerTerminal.create({
    backend: 'webgl',
    fonts: [{ family: 'ShaderWorkerTest', source: { url: testFontUrl } }],
  })
  cleanups.push(() => terminal.dispose())
  await terminal.open(host)
  const errors: unknown[] = []
  const handle = await terminal.use(
    createShaderAddon(copyShader, { onError: (error) => errors.push(error) }),
  )
  cleanups.push(() => handle.dispose())
  await expect(handle.api.ready).rejects.toMatchObject({ code: 'worker' })
  expect(errors).toMatchObject([{ code: 'worker' }])
  expect(terminal.element?.querySelector('[data-ghostty-shader]')).toBeNull()
  expect(terminal.lifecycle).toBe('open')
})

it('disposes safely while a WebGPU replacement pipeline is compiling', async () => {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new TypeError('Missing test WebGPU adapter')
  const device = await adapter.requestDevice()
  cleanups.push(() => device.destroy())
  const acquireAdapter = vi.spyOn(navigator.gpu, 'requestAdapter').mockResolvedValue(adapter)
  const acquireDevice = vi.spyOn(adapter, 'requestDevice').mockResolvedValue(device)
  cleanups.push(() => {
    acquireAdapter.mockRestore()
    acquireDevice.mockRestore()
  })
  const f = await fixture('canvas2d', copyShader, false, 'webgpu')
  let entered = () => {}
  let release = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  cleanups.push(() => release())
  const compile = device.createRenderPipelineAsync.bind(device)
  const compiling = vi
    .spyOn(device, 'createRenderPipelineAsync')
    .mockImplementationOnce(async (descriptor) => {
      const pipeline = await compile(descriptor)
      entered()
      await pending
      return pipeline
    })
  cleanups.push(() => compiling.mockRestore())
  const replacement = f.handle.api.setShader(greenShader)
  await started
  f.handle.dispose()
  release()
  expect(await replacement).toBe(false)
  expect(f.canvas.isConnected).toBe(false)
  expect(f.terminal.lifecycle).toBe('open')
  expect(f.errors).toEqual([])
})

function alphaArtifact(): CompiledShader {
  if (!copyShader.wgsl || !copyShader.glsl) throw new Error('Missing copy shader languages')
  return {
    ...copyShader,
    wgsl: copyShader.wgsl.replace(
      '(*color) = _e66;',
      '(*color) = vec4<f32>(vec3<f32>(_e66.a), 1.0);',
    ),
    glsl: copyShader.glsl.replace('color = _e66;', 'color = vec4(vec3(_e66.a), 1.0);'),
  }
}
const alphaShader = alphaArtifact()

it.each(captureBackends)(
  'observes source alpha independently and erases to fresh blank on $source with $output',
  async ({ source, output }) => {
    const actual = await fixture(source, alphaShader, false, output, false, transparentGlyphs)
    const blank = await fixture(source, alphaShader, false, output, false, transparentBlank)
    const background = { r: 29, g: 71, b: 113 }
    actual.terminal.setTheme({ ...actual.terminal.appearance.theme, background })
    blank.terminal.setTheme({ ...blank.terminal.appearance.theme, background })
    await frames(3)
    const glyph = await pixels(actual.canvas)
    const reference = await pixels(blank.canvas)
    expect(glyph.data.some((v, i) => i % 4 === 0 && v > 0)).toBe(true)
    expect(glyph.data.some((v, i) => i % 4 === 0 && v > 0 && v < 255)).toBe(true)
    expect(reference.data.every((v, i) => i % 4 === 3 || v === 0)).toBe(true)
    await afterFrame(actual.terminal, () => actual.terminal.write(transparentBlank))
    expect(differentPixels(await pixels(actual.canvas), reference)).toBe(0)
    expect(actual.canvas.style.display).toBe('block')
    expect(actual.errors.concat(blank.errors)).toEqual([])
  },
)

it.each(captureBackends)(
  'matches fresh overwrite, cursor movement and selection removal on $source with $output',
  async ({ source, output }) => {
    const actual = await transparentFixture({ source, output }, transparentGlyphs)
    const finalText = `${transparentBlank}\x1b[38;2;255;255;255mHi`
    await afterFrame(actual.terminal, () => actual.terminal.write(finalText))
    const expected = await transparentFixture({ source, output }, finalText)
    expect(differentPixels(await pixels(actual.canvas), await pixels(expected.canvas))).toBe(0)
    await afterFrame(actual.terminal, () => actual.terminal.selectAll())
    await afterFrame(actual.terminal, () => actual.terminal.clearSelection())
    expect(differentPixels(await pixels(actual.canvas), await pixels(expected.canvas))).toBe(0)
    const cursor = '\x1b[?25h\x1b[2;3H'
    await afterFrame(actual.terminal, () => actual.terminal.write(cursor))
    const moved = await transparentFixture({ source, output }, finalText + cursor)
    expect(differentPixels(await pixels(actual.canvas), await pixels(moved.canvas))).toBe(0)
    expect(actual.errors.concat(expected.errors, moved.errors)).toEqual([])
  },
)

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'captures pixels-mode erase and already-presented blank installation with %s output',
  async (output) => {
    const actual = await fixture('pixels', alphaShader, false, output, false, transparentGlyphs)
    const expected = await fixture('pixels', alphaShader, false, output, false, transparentBlank)
    await frames(3)
    expect(
      differentPixels(await pixels(actual.canvas), await pixels(expected.canvas)),
    ).toBeGreaterThan(0)
    await afterFrame(actual.terminal, () => actual.terminal.write(transparentBlank))
    expect(differentPixels(await pixels(actual.canvas), await pixels(expected.canvas))).toBe(0)
    actual.handle.dispose()
    await frames(2)
    const handle = actual.terminal.use(createShaderAddon(alphaShader, { backend: output }))
    cleanups.push(() => handle.dispose())
    await handle.api.ready
    await frames(3)
    const overlay =
      actual.terminal.element?.querySelector<HTMLCanvasElement>('[data-ghostty-shader]')
    if (!overlay) throw new Error('Missing blank overlay')
    expect(overlay.style.display).toBe('block')
    expect(differentPixels(await pixels(overlay), await pixels(expected.canvas))).toBe(0)
  },
)

it.each([false, true])('removes the overlay on actual DOM fallback, paused=%s', async (paused) => {
  const sourceFactory: GhosttyWebGpuRendererFactory = (options, signal) => {
    const replace = options.replaceCanvas
    if (!replace) throw new Error('Missing replacement factory')
    return FallbackTerminalRenderer.create(
      options,
      () => {
        const canvas = replace()
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected HTML canvas')
        const getContext = canvas.getContext.bind(canvas)
        Object.defineProperty(canvas, 'getContext', {
          value: (kind: string, options?: unknown) =>
            kind === '2d' ? null : getContext(kind, options),
        })
        return canvas
      },
      signal,
      [],
    )
  }
  const f = await fixture('webgl2', copyShader, false, 'webgl2', false, transparentGlyphs, {
    rendererFactory: sourceFactory,
  })
  f.handle.api.setPaused(paused)
  const original = f.terminal.canvas
  const lose = original?.getContext('webgl2')?.getExtension('WEBGL_lose_context')
  if (!lose) throw new Error('Missing source context-loss control')
  const backends: unknown[] = []
  f.terminal.on('frame', () => backends.push(f.terminal.diagnostics.rendererBackend))
  lose.loseContext()
  await expect.poll(() => f.terminal.diagnostics.rendererBackend).toBe('dom')
  await expect.poll(() => backends.includes('dom')).toBe(true)
  await expect.poll(() => f.canvas.isConnected).toBe(false)
  expect(f.errors).toMatchObject([{ code: 'backend' }])
  expect(f.terminal.lifecycle).toBe('open')
  await afterFrame(f.terminal, () => f.terminal.write('\rDOM alive'))
  expect(f.terminal.visibleLines()[0]).toContain('DOM alive')
  expect(f.terminal.element?.textContent).toContain('DOM alive')
  expect(f.errors).toHaveLength(1)
})

it('fails a public-options-only factory explicitly while keeping its terminal usable', async () => {
  const independent: GhosttyWebGpuRendererFactory = (options) =>
    CanvasTerminalRenderer.create({
      canvas: options.canvas,
      columns: options.columns,
      rows: options.rows,
      font: options.font,
      renderState: options.renderState,
      onRowsChanged: options.onRowsChanged,
      onError: options.onError,
    })
  const host = document.createElement('div')
  document.body.append(host)
  cleanups.push(() => host.remove())
  const terminal = await Terminal.create({
    rendererFactory: independent,
    runtime: { kind: 'borrowed', runtime },
  })
  const source = terminal
  cleanups.push(() => source.dispose())
  await source.open(host)
  const errors: unknown[] = []
  const handle = source.use(
    createShaderAddon(copyShader, { onError: (error) => errors.push(error) }),
  )
  cleanups.push(() => handle.dispose())
  await expect(handle.api.ready).rejects.toMatchObject({ code: 'backend' })
  expect(errors).toMatchObject([{ code: 'backend' }])
  expect(source.element?.querySelector('[data-ghostty-shader]')).toBeNull()
  source.write('alive')
  expect(source.readLines(0, 1)[0]?.text).toContain('alive')
  expect(source.lifecycle).toBe('open')
  source.dispose()
  expect(source.lifecycle).toBe('disposed')
})

it('erases correctly after canvas-to-canvas source recovery', async () => {
  const f = await transparentFixture({ source: 'webgl2', output: 'webgl2' }, transparentGlyphs)
  const original = f.terminal.canvas
  const lose = original?.getContext('webgl2')?.getExtension('WEBGL_lose_context')
  if (!lose) throw new Error('Missing source loss extension')
  lose.loseContext()
  await expect.poll(() => f.terminal.diagnostics.rendererBackend).toBe('canvas2d')
  await afterFrame(f.terminal, () => f.terminal.write(transparentGlyphs))
  const reference = await transparentFixture(
    { source: 'canvas2d', output: 'webgl2' },
    transparentBlank,
  )
  await afterFrame(f.terminal, () => f.terminal.write(transparentBlank))
  expect(differentPixels(await pixels(f.canvas), await pixels(reference.canvas))).toBe(0)
  expect(f.canvas.style.display).toBe('block')
  expect(f.errors.concat(reference.errors)).toEqual([])
})

it.each(['webgpu', 'webgl2'] satisfies ('webgpu' | 'webgl2')[])(
  'installs visibly on an already-presented blank WebGL source with %s output',
  async (output) => {
    const f = await fixture('webgl2', alphaShader, false, output, false, transparentBlank)
    f.handle.dispose()
    await frames(2)
    const handle = f.terminal.use(createShaderAddon(alphaShader, { backend: output }))
    cleanups.push(() => handle.dispose())
    await handle.api.ready
    await frames(3)
    const overlay = f.terminal.element?.querySelector<HTMLCanvasElement>('[data-ghostty-shader]')
    if (!overlay) throw new Error('Missing blank output')
    expect(overlay.style.display).toBe('block')
    expect(
      (await pixels(overlay)).data.every((value, index) => index % 4 === 3 || value === 0),
    ).toBe(true)
    expect(f.errors).toEqual([])
  },
)
