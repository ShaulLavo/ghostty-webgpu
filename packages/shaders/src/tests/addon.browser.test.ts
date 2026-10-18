import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import {
  GhosttyRuntime,
  Terminal,
  WebGpuTerminalRenderer,
  type GhosttyWebGpuRendererFactory,
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

function factory(backend: 'webgpu' | 'webgl2' | 'canvas2d'): GhosttyWebGpuRendererFactory {
  if (backend === 'webgpu')
    return (options) => WebGpuTerminalRenderer.create({ ...options, adapterPolicy: 'any' })
  if (backend === 'webgl2')
    return (options) =>
      options.replaceCanvas
        ? FallbackTerminalRenderer.create(options, options.replaceCanvas)
        : WebGlTerminalRenderer.create(options)
  return (options) => CanvasTerminalRenderer.create(options)
}

async function fixture(
  backend: 'webgpu' | 'webgl2' | 'canvas2d',
  shader: CompiledShader = copyShader,
  beforeOpen = false,
  output?: 'webgpu' | 'webgl2',
  existing = false,
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
    rendererFactory: factory(backend),
    runtime: { kind: 'borrowed', runtime },
  })
  cleanups.push(() => terminal.dispose())
  const errors: unknown[] = []
  terminal.on('error', (event) => errors.push(event))
  const addon = createShaderAddon(shader, {
    backend: output,
    onError: (error) => errors.push(error),
  })
  if (!beforeOpen) await terminal.open(host)
  const content =
    '\x1b[?25l\x1b[48;2;255;0;0m          \r\n\x1b[48;2;0;255;0m          \r\n\x1b[48;2;0;0;255m          '
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
