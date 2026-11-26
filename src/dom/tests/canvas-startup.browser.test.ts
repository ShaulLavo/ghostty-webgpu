import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Terminal } from '../../../dist/index.js'
import { CanvasTerminalRenderer } from '../../../dist/render/canvas/renderer.js'
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

async function open(
  rendererMode: 'auto' | 'webgl2' | 'webgpu',
  extra: {
    readonly activateUri?: (uri: string) => void
    readonly linkActivationModifier?: (event: MouseEvent) => boolean
  } = {},
) {
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
    linkActivationModifier: extra.linkActivationModifier,
    links: extra.activateUri ? { activateUri: extra.activateUri } : undefined,
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

function visiblePixelDifference(
  before: ImageData,
  after: ImageData,
  background: readonly number[],
): number {
  expect([after.width, after.height]).toEqual([before.width, before.height])
  let maxDelta = 0
  for (let i = 0; i < before.data.length; i += 4) {
    const beforeAlpha = before.data[i + 3]! / 255
    const afterAlpha = after.data[i + 3]! / 255
    for (let channel = 0; channel < 3; channel += 1) {
      const bg = background[channel]!
      const first = Math.round(bg + (before.data[i + channel]! - bg) * beforeAlpha)
      const next = Math.round(bg + (after.data[i + channel]! - bg) * afterAlpha)
      maxDelta = Math.max(maxDelta, Math.abs(first - next))
    }
  }
  return maxDelta
}

function holdCanvas() {
  const gate = Promise.withResolvers<void>()
  onTestFinished(() => gate.resolve())
  const create = CanvasTerminalRenderer.create.bind(CanvasTerminalRenderer)
  return {
    release: gate.resolve,
    create: vi.spyOn(CanvasTerminalRenderer, 'create').mockImplementation(async (options) => {
      await gate.promise
      return create(options)
    }),
  }
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
    // Compare what the browser displays over the terminal's background.
    const { r, g, b } = terminal.appearance.rendererTheme.background
    expect(visiblePixelDifference(before, firstGpuFrame, [r, g, b])).toBeLessThanOrEqual(4)
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

it('defers GPU handoff during a modified OSC 8 link click', async () => {
  const gpu = holdWebGl()
  const activated: string[] = []
  const { terminal, canvas } = await open('webgl2', {
    activateUri: (uri) => {
      activated.push(uri)
    },
    linkActivationModifier: (event) => event.ctrlKey,
  })
  terminal.write(`${hideCursor}\x1b]8;;https://example.com/click\x07click-here\x1b]8;;\x07`)
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('click-here')
  await expect.poll(() => gpu.create.mock.calls.length).toBe(1)

  const rect = canvas.getBoundingClientRect()
  const { cellWidth, cellHeight } = terminal.appearance.grid
  const clientX = rect.left + 5 + cellWidth * 2
  const clientY = rect.top + 4 + cellHeight * 0.5
  vi.spyOn(canvas, 'setPointerCapture').mockImplementation(() => {})
  vi.spyOn(canvas, 'hasPointerCapture').mockReturnValue(true)
  vi.spyOn(canvas, 'releasePointerCapture').mockImplementation(() => {})

  canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      clientX,
      clientY,
      ctrlKey: true,
      pointerId: 1,
    }),
  )
  gpu.release()
  const staged = gpu.create.mock.results[0]
  if (staged?.type !== 'return') throw new Error('WebGL2 creation did not start')
  await staged.value
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  expect(terminal.diagnostics.rendererBackend).toBe('canvas2d')
  expect(terminal.canvas).toBe(canvas)

  canvas.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX,
      clientY,
      ctrlKey: true,
      pointerId: 1,
    }),
  )
  canvas.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX,
      clientY,
      ctrlKey: true,
    }),
  )
  await expect.poll(() => activated).toEqual(['https://example.com/click'])
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('webgl2')
  expect(terminal.canvas).not.toBe(canvas)
})

it('preserves keyboard link focus across GPU handoff and activates it with Enter', async () => {
  const gpu = holdWebGl()
  const activated: string[] = []
  const { terminal } = await open('webgl2', {
    activateUri: (uri) => {
      activated.push(uri)
    },
  })
  terminal.write(`${hideCursor}\x1b]8;;https://example.com/key\x07open-link\x1b]8;;\x07`)
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('open-link')
  await expect.poll(() => gpu.create.mock.calls.length).toBe(1)

  await expect(terminal.focusNextLink()).resolves.toBe(true)
  const focused = document.activeElement
  expect(focused?.classList.contains('ghostty-webgpu-link')).toBe(true)

  gpu.release()
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('webgl2')
  expect(document.activeElement).toBe(focused)

  focused?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  await expect.poll(() => activated).toEqual(['https://example.com/key'])
})

it('hands off to GPU when synchronized output expires by timeout', async () => {
  const gpu = holdWebGl()
  const { terminal, canvas } = await open('webgl2')
  terminal.write(`${hideCursor}before hold`)
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before hold')
  await expect.poll(() => gpu.create.mock.calls.length).toBe(1)

  terminal.write(`${holdOutput}\r\ntimed out text`)
  gpu.release()
  const staged = gpu.create.mock.results[0]
  if (staged?.type !== 'return') throw new Error('WebGL2 creation did not start')
  await staged.value
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  expect(terminal.diagnostics.rendererBackend).toBe('canvas2d')
  expect(terminal.canvas).toBe(canvas)

  await expect
    .poll(() => terminal.visibleLines()[1]?.trimEnd(), { timeout: 5_000 })
    .toBe('timed out text')
  await expect.poll(() => terminal.diagnostics.rendererBackend, { timeout: 5_000 }).toBe('webgl2')
  expect(terminal.canvas).not.toBe(canvas)
})

it('wakes GPU handoff when the host intercepts a modified link click', async () => {
  const gpu = holdWebGl()
  const activated: string[] = []
  const { terminal, canvas } = await open('webgl2', {
    activateUri: (uri) => {
      activated.push(uri)
    },
    linkActivationModifier: (event) => event.ctrlKey,
  })
  terminal.write(`${hideCursor}\x1b]8;;https://example.com/intercept\x07intercept-me\x1b]8;;\x07`)
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('intercept-me')
  await expect.poll(() => gpu.create.mock.calls.length).toBe(1)

  const suppressClick = (event: MouseEvent): void => {
    event.stopPropagation()
  }
  document.addEventListener('click', suppressClick, { capture: true })
  cleanups.push(() => document.removeEventListener('click', suppressClick, { capture: true }))

  const rect = canvas.getBoundingClientRect()
  const { cellWidth, cellHeight } = terminal.appearance.grid
  const clientX = rect.left + 5 + cellWidth * 2
  const clientY = rect.top + 4 + cellHeight * 0.5
  vi.spyOn(canvas, 'setPointerCapture').mockImplementation(() => {})
  vi.spyOn(canvas, 'hasPointerCapture').mockReturnValue(true)
  vi.spyOn(canvas, 'releasePointerCapture').mockImplementation(() => {})

  canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      clientX,
      clientY,
      ctrlKey: true,
      pointerId: 1,
    }),
  )
  gpu.release()
  const staged = gpu.create.mock.results[0]
  if (staged?.type !== 'return') throw new Error('WebGL2 creation did not start')
  await staged.value
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  expect(terminal.diagnostics.rendererBackend).toBe('canvas2d')

  canvas.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX,
      clientY,
      ctrlKey: true,
      pointerId: 1,
    }),
  )
  canvas.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX,
      clientY,
      ctrlKey: true,
    }),
  )
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('webgl2')
  expect(activated).toEqual([])
})

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

it('opens already fitted so the first frame and GPU handoff never flash an 80x24 canvas', async () => {
  const host = document.createElement('div')
  host.style.cssText = 'width:960px;height:320px'
  document.body.append(host)
  cleanups.push(() => host.remove())

  const startup = holdCanvas()
  const gpu = holdWebGl()

  const terminal = await Terminal.create({
    rendererMode: 'webgl2',
    appearance: {
      cursor: { blink: false },
      font: { family: 'monospace', size: 6, lineHeight: 0.75 },
    },
    fitEnvironment: { getPixelRatio: () => 1 },
    renderWhenOffscreen: true,
    scrollbar: false,
  })
  cleanups.push(() => terminal.dispose())

  const frameSizes: Array<{ width: number; height: number }> = []
  terminal.onFrame(() => {
    const live = terminal.canvas
    if (!live) return
    const rect = live.getBoundingClientRect()
    frameSizes.push({ width: Math.round(rect.width), height: Math.round(rect.height) })
  })

  const startupRects: Array<{ width: number; height: number }> = []
  const sampleLiveRect = (): void => {
    const live = host.querySelector<HTMLCanvasElement>('.ghostty-webgpu-canvas')
    if (!live) return
    const rect = live.getBoundingClientRect()
    startupRects.push({ width: Math.round(rect.width), height: Math.round(rect.height) })
  }

  const opening = terminal.open(host)
  await expect.poll(() => startup.create.mock.calls.length).toBe(1)
  await nextAnimationFrame()
  sampleLiveRect()
  await nextAnimationFrame()
  sampleLiveRect()

  startup.release()
  await opening

  const expected = terminal.appearance.grid
  expect(expected.columns).toBeGreaterThan(100)
  expect(expected.rows).toBeGreaterThan(30)

  const expectedWidth = Math.round(expected.columns * expected.cellWidth)
  const expectedHeight = Math.round(expected.rows * expected.cellHeight)
  expect(expectedWidth).toBeGreaterThan(900)
  expect(expectedHeight).toBeGreaterThan(300)

  terminal.write(`${hideCursor}${'#'.repeat(expected.columns)}`)
  await expect.poll(() => frameSizes.length).toBeGreaterThan(0)
  expect(terminal.diagnostics.rendererBackend).toBe('canvas2d')
  sampleLiveRect()

  gpu.release()
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('webgl2')
  sampleLiveRect()

  expect(startupRects.length).toBeGreaterThanOrEqual(4)
  for (const rect of startupRects) {
    expect(rect).toEqual({ width: expectedWidth, height: expectedHeight })
  }
  expect(frameSizes.length).toBeGreaterThan(0)
  for (const rect of frameSizes) {
    expect(rect).toEqual({ width: expectedWidth, height: expectedHeight })
  }
})
