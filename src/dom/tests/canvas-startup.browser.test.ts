import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Terminal } from '../../../dist/index.js'
import { WebGlTerminalRenderer } from '../../../dist/render/webgl/renderer.js'
import { WebGpuTerminalRenderer } from '../../../dist/render/webgpu/renderer.js'

const cleanups: (() => void)[] = []
const hideCursor = '\x1b[?25l'
const holdOutput = '\x1b[?2026h'
const releaseOutput = '\x1b[?2026l'

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

async function open(rendererMode: 'auto' | 'webgl2' | 'webgpu') {
  const host = document.createElement('div')
  host.style.cssText = 'width:320px;height:100px'
  document.body.append(host)
  cleanups.push(() => host.remove())

  const terminal = await Terminal.create({
    rendererMode,
    appearance: {
      cursor: { blink: false },
      font: { family: 'monospace', size: 16 },
    },
    fitEnvironment: { getPixelRatio: () => 1 },
    padding: { left: 5, right: 3, top: 4, bottom: 2 },
    renderWhenOffscreen: true,
    scrollbar: false,
  })
  cleanups.push(() => terminal.dispose())
  await terminal.open(host)
  const canvas = terminal.canvas
  if (!canvas) throw new Error('Expected an open terminal canvas')
  expect(terminal.diagnostics.rendererBackend).toBe('canvas2d')
  return { host, terminal, canvas }
}

function image(canvas: HTMLCanvasElement): ImageData {
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  const context = copy.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Expected a Canvas 2D context')
  context.drawImage(canvas, 0, 0)
  return context.getImageData(0, 0, copy.width, copy.height)
}

function comparePixels(before: ImageData, after: ImageData): number {
  expect([after.width, after.height]).toEqual([before.width, before.height])
  let maxDelta = 0
  for (let i = 0; i < before.data.length; i += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(before.data[i]! - after.data[i]!))
  }
  return maxDelta
}

function holdWebGl() {
  const gate = Promise.withResolvers<void>()
  onTestFinished(() => gate.resolve())
  const create = WebGlTerminalRenderer.create.bind(WebGlTerminalRenderer)
  return {
    release: gate.resolve,
    create: vi.spyOn(WebGlTerminalRenderer, 'create').mockImplementation(async (options) => {
      await gate.promise
      return create(options)
    }),
  }
}

function holdWebGpu() {
  const gate = Promise.withResolvers<void>()
  onTestFinished(() => gate.resolve())
  const create = WebGpuTerminalRenderer.create.bind(WebGpuTerminalRenderer)
  return {
    release: gate.resolve,
    create: vi.spyOn(WebGpuTerminalRenderer, 'create').mockImplementation(async (options) => {
      await gate.promise
      return create(options)
    }),
  }
}

it.for(['webgl2', 'webgpu'] as const)(
  'matches the last Canvas and first %s pixels',
  { timeout: 20_000 },
  async (backend, context) => {
    if (backend === 'webgl2' && !document.createElement('canvas').getContext('webgl2')) {
      context.skip('WebGL2 is unavailable')
      return
    }
    if (backend === 'webgpu' && !(await navigator.gpu?.requestAdapter())) {
      context.skip('WebGPU has no adapter')
      return
    }
    const gpu = backend === 'webgl2' ? holdWebGl() : holdWebGpu()
    const { terminal, canvas } = await open(backend)
    terminal.focus()
    terminal.write(
      '\x1b[4m   \x1b[0m \x1b[38;2;255;0;0m██\x1b[0m\r\nhello Ω界\r\n' +
        '\x1b[4:2m  \x1b[4:3m  \x1b[4:4m  \x1b[4:5m  \x1b[9m  \x1b[53m  \x1b[0m',
    )
    terminal.selectRange({ x: 0, y: 1 }, { x: 2, y: 1 })
    await expect.poll(() => terminal.visibleLines()[1]?.trimEnd()).toBe('hello Ω界')
    await expect.poll(() => gpu.create.mock.calls.length).toBe(1)
    const before = image(canvas)
    expect(before.data.some((channel) => channel > 0)).toBe(true)
    let firstGpuFrame: ImageData | undefined
    terminal.on('frame', () => {
      const candidate = terminal.canvas
      if (candidate && terminal.diagnostics.rendererBackend === backend) {
        firstGpuFrame ??= image(candidate)
      }
    })

    const firstCell = terminal.appearance.grid
    const underline = (data: ImageData) =>
      Array.from(
        { length: firstCell.cellHeight },
        (_, y) => data.data[(y * data.width + 1) * 4 + 3],
      )
    const expectedUnderline = Array.from({ length: firstCell.cellHeight }, (_, y) =>
      y === firstCell.cellHeight - 2 ? 255 : 0,
    )
    expect(underline(before)).toEqual(expectedUnderline)
    gpu.release()
    await expect.poll(() => terminal.diagnostics.rendererBackend).toBe(backend)
    expect(firstGpuFrame).toBeDefined()
    if (!firstGpuFrame) throw new Error('Expected the first GPU frame')
    expect(canvas.isConnected).toBe(false)
    expect(terminal.canvas?.style.padding).toBe(canvas.style.padding)
    expect(terminal.getSelection()).toBe('hel')
    expect(document.activeElement).toBe(terminal.textarea)
    expect(underline(firstGpuFrame)).toEqual(expectedUnderline)
    // Software and GPU blending can round antialiased glyph coverage differently.
    expect(comparePixels(before, firstGpuFrame)).toBeLessThanOrEqual(4)
  },
)

it('preserves scrollback and resize during warm-up and waits for synchronized output', async () => {
  const gpu = holdWebGl()
  const { terminal, host, canvas } = await open('webgl2')
  terminal.write(
    hideCursor + Array.from({ length: 30 }, (_, line) => `old line ${line}\r\n`).join(''),
  )
  terminal.scrollToTop()
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('old line 0')
  const width = canvas.width
  host.style.width = '380px'
  await expect.poll(() => canvas.width).toBeGreaterThan(width)
  const resizedWidth = canvas.width
  const view = terminal.visibleLines()
  terminal.write(holdOutput + 'synchronized write')
  gpu.release()
  await expect.poll(() => gpu.create.mock.results[0]?.type).toBe('return')
  const staged = gpu.create.mock.results[0]
  if (staged?.type !== 'return') throw new Error('WebGL2 creation did not start')
  await staged.value
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  expect(terminal.canvas).toBe(canvas)
  expect(terminal.visibleLines()).toEqual(view)

  terminal.write(releaseOutput)
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('webgl2')
  expect(terminal.canvas?.width).toBe(resizedWidth)
  expect(terminal.visibleLines()).toEqual(view)
  terminal.scrollToBottom()
  await expect
    .poll(() => terminal.visibleLines().some((line) => line.includes('synchronized write')))
    .toBe(true)
})

it('keeps Canvas live when the GPU fails to start', async () => {
  const attempted = vi
    .spyOn(WebGlTerminalRenderer, 'create')
    .mockRejectedValue(new Error('GPU startup failed'))
  const { terminal, canvas } = await open('webgl2')
  await expect.poll(() => attempted.mock.calls.length).toBe(1)
  terminal.write('still painting')
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('still painting')
  expect(terminal.canvas).toBe(canvas)
  expect(terminal.diagnostics.rendererBackend).toBe('canvas2d')
})

it('disposes a GPU renderer returned after the terminal closes', async () => {
  const gpu = holdWebGl()
  const { terminal, host } = await open('webgl2')
  terminal.write('before closing')
  await expect.poll(() => gpu.create.mock.calls.length).toBe(1)
  const dispose = vi.spyOn(WebGlTerminalRenderer.prototype, 'dispose')
  terminal.dispose()
  gpu.release()
  await expect.poll(() => dispose.mock.calls.length).toBe(1)
  expect(terminal.hasPendingFrame).toBe(false)
  expect(host.querySelector('canvas')).toBeNull()
})

it('keeps painting after the WebGL2 canvas is lost', async () => {
  const { terminal } = await open('webgl2')
  terminal.write('before loss')
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('webgl2')
  const canvas = terminal.canvas
  const loss = canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')
  if (!loss) throw new Error('Expected WEBGL_lose_context')
  loss.loseContext()
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('canvas2d')
  terminal.write(' after loss')
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before loss after loss')
  expect(terminal.canvas).not.toBe(canvas)
})

it('restores the WebGPU device after the handoff', async (context) => {
  if (!(await navigator.gpu?.requestAdapter())) {
    context.skip('WebGPU has no adapter')
    return
  }
  const create = WebGpuTerminalRenderer.create.bind(WebGpuTerminalRenderer)
  const started = Promise.withResolvers<WebGpuTerminalRenderer>()
  vi.spyOn(WebGpuTerminalRenderer, 'create').mockImplementation(async (options) => {
    const renderer = await create(options)
    started.resolve(renderer)
    return renderer
  })
  const { terminal } = await open('webgpu')
  terminal.write('before loss')
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('webgpu')
  const renderer = await started.promise
  const canvas = terminal.canvas
  const device: unknown = Reflect.get(renderer, 'device')
  if (!(device instanceof GPUDevice)) throw new Error('Expected a WebGPU device')
  device.destroy()
  await expect.poll(() => renderer.metrics.deviceRestores).toBe(1)
  terminal.write(' after loss')
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before loss after loss')
  expect(terminal.canvas).toBe(canvas)
})
