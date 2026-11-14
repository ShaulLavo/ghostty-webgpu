import { requireWebGpu } from '../../render/tests/webgpu-capability.js'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { GhosttyRuntime, Terminal, WebGpuTerminalRenderer } from '../../../dist/index.js'
import { WebGlTerminalRenderer } from '../../../dist/render/webgl/renderer.js'
import { CanvasTerminalRenderer } from '../../../dist/render/canvas/renderer.js'
import { DomTerminalRenderer } from '../../../dist/render/dom/renderer.js'
import { WebGpuTextPass } from '../../../dist/render/webgpu/text-pass.js'
import { FrameCoordinator } from '../../../dist/render/shared/frame-coordinator.js'
import { TestClock } from '../../render/webgl/tests/fixture.js'
import { subscribeCanvasImage } from '../../../packages/shaders/src/canvas-image.js'
import { CanvasImageRelay } from '../canvas-image.js'

const cleanups: (() => unknown)[] = []
let runtime: GhosttyRuntime
beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterAll(() => runtime.dispose())
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Backend = 'webgl2' | 'webgpu-direct' | 'webgpu-coordinated' | 'canvas2d' | 'pixels' | 'dom'

async function fixture(backend: Backend, controlled = false) {
  if (backend.startsWith('webgpu')) requireWebGpu()
  const host = document.createElement('div')
  host.style.cssText = 'width:340px;height:160px'
  document.body.append(host)
  cleanups.push(() => host.remove())
  const clock = backend === 'webgpu-coordinated' && !controlled ? undefined : new TestClock()
  let renderer:
    | WebGpuTerminalRenderer
    | WebGlTerminalRenderer
    | CanvasTerminalRenderer
    | DomTerminalRenderer
    | undefined
  const terminal = await Terminal.create({
    appearance: {
      grid: { columns: 10, rows: 3, pixelRatio: 1 },
      font: { family: 'monospace', size: 16 },
      cursor: { blink: false },
    },
    runtime: { kind: 'borrowed', runtime },
    rendererFactory: async (options) => {
      const prepared = { ...options, schedulerClock: clock, adapterPolicy: 'any' as const }
      if (backend === 'webgl2') renderer = await WebGlTerminalRenderer.create(prepared)
      else if (backend.startsWith('webgpu'))
        renderer = await WebGpuTerminalRenderer.create(prepared)
      else if (backend === 'dom') renderer = await DomTerminalRenderer.create(prepared)
      else
        renderer = await CanvasTerminalRenderer.create({
          ...prepared,
          rendererMode: backend === 'pixels' ? 'canvas2d-pixels' : 'canvas2d-fill-text',
        })
      if (backend === 'webgpu-coordinated' && clock) {
        const coordinator = new FrameCoordinator(clock)
        Reflect.set(renderer, 'coordinator', coordinator)
        Reflect.set(Reflect.get(renderer, 'scheduler'), 'clock', coordinator)
      }
      return renderer
    },
  })
  cleanups.push(() => terminal.dispose())
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error))
  await terminal.open(host)
  if (!renderer) throw new Error('Missing source renderer')
  const source = renderer
  const flush = async () => {
    if (clock) {
      if (clock.frames.size) clock.flushFrame()
      return
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  await flush()
  return { terminal, renderer: source, flush, clock, errors }
}

function ownedImage(terminal: Terminal): ImageData {
  const source = terminal.canvas
  if (!source) throw new Error('Missing source canvas')
  const copy = document.createElement('canvas')
  copy.width = source.width
  copy.height = source.height
  const context = copy.getContext('2d')
  if (!context) throw new Error('Missing owned capture context')
  context.drawImage(source, 0, 0)
  return context.getImageData(0, 0, copy.width, copy.height)
}

it.each([
  'webgl2',
  'webgpu-direct',
  'webgpu-coordinated',
  'canvas2d',
  'pixels',
] satisfies Backend[])(
  'copies an accepted complete image synchronously on %s, including transparent erasure',
  async (backend) => {
    const f = await fixture(backend)
    const images: ImageData[] = []
    const order: string[] = []
    const submitted: number[] = []
    cleanups.push(
      subscribeCanvasImage(f.terminal, () => {
        images.push(ownedImage(f.terminal))
        submitted.push(f.renderer.metrics.submittedFrames)
        order.push('image')
      }),
    )
    f.terminal.on('frame', () => order.push('public'))
    f.terminal.write('\x1b[?25l\x1b[38;2;255;255;255mAgjmW')
    await f.flush()
    expect(order).toEqual(['image', 'public'])
    expect(submitted[0]).toBe(f.renderer.metrics.submittedFrames)
    const glyph = images.at(-1)!
    expect(glyph.data.some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true)
    const held = glyph.data.slice()
    f.terminal.write('\x1b[0m\x1b[2J\x1b[H')
    await f.flush()
    expect(images.at(-1)!.data.every((v) => v === 0)).toBe(true)
    expect(glyph.data).toEqual(held)
    expect(f.errors).toEqual([])
    const descriptor = Object.getOwnPropertyDescriptor(
      f.terminal,
      Symbol.for('ghostty-webgpu.observeCanvasImage'),
    )
    expect(descriptor?.enumerable).toBe(false)
    expect(Reflect.get(f.renderer, 'coordinator') instanceof FrameCoordinator).toBe(
      backend === 'webgpu-coordinated',
    )
  },
)

it.each(['webgl2', 'webgpu-direct', 'webgpu-coordinated'] satisfies Backend[])(
  'keeps the image for source no-submit publications on %s',
  async (backend) => {
    const f = await fixture(backend)
    f.terminal.write('\x1b[?25lSAME')
    await f.flush()
    const images = vi.fn()
    cleanups.push(subscribeCanvasImage(f.terminal, images))
    const events: number[][] = []
    f.terminal.on('frame', ({ rows }) => events.push(Array.from(rows)))
    const before = f.renderer.metrics.submittedFrames
    if (backend === 'webgl2') f.terminal.refresh(0, 2)
    else f.terminal.write('\rSAME')
    await f.flush()
    expect(f.renderer.metrics.submittedFrames).toBe(before)
    expect(images).not.toHaveBeenCalled()
    expect(events).toEqual(backend === 'webgl2' ? [[0, 1, 2]] : [[0]])
    if (backend === 'webgl2') return
    f.terminal.refresh(0, 2)
    await f.flush()
    expect(f.renderer.metrics.submittedFrames).toBe(before + 1)
    expect(images).toHaveBeenCalledTimes(1)
  },
)

it.each(['webgpu-direct', 'webgpu-coordinated'] satisfies Backend[])(
  'does not publish a failed %s submit and captures recovery',
  async (backend) => {
    const f = await fixture(backend)
    const image = vi.fn(() => ownedImage(f.terminal))
    cleanups.push(subscribeCanvasImage(f.terminal, image))
    const device: unknown = Reflect.get(f.renderer, 'device')
    if (!(device instanceof GPUDevice)) throw new Error('Missing source device')
    const fail = () => {
      throw new Error('injected source failure')
    }
    const submit =
      backend === 'webgpu-direct'
        ? vi.spyOn(WebGpuTextPass.prototype, 'submit').mockImplementation(fail)
        : vi.spyOn(device.queue, 'submit').mockImplementation(fail)
    cleanups.push(() => submit.mockRestore())
    f.terminal.write('\x1b[?25lNEW')
    await f.flush()
    expect(image).not.toHaveBeenCalled()
    expect(f.errors.length).toBeGreaterThan(0)
    submit.mockRestore()
    f.terminal.clearTextureAtlas()
    await f.flush()
    expect(image).toHaveBeenCalledTimes(1)
    const recovered: unknown = image.mock.results[0]?.value
    if (!(recovered instanceof ImageData)) throw new Error('Missing recovery capture')
    expect(recovered.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
  },
)

it('never acknowledges DOM as a canvas-image publisher', async () => {
  const f = await fixture('dom')
  expect(() => subscribeCanvasImage(f.terminal, () => {})).toThrow('does not publish canvas images')
  f.terminal.write('alive')
  await f.flush()
  expect(f.terminal.visibleLines()[0]).toContain('alive')
})

it.each([false, true])(
  'preserves expected public rows and observer order, image subscriber=%s',
  async (listen) => {
    const f = await fixture('webgl2')
    const events: string[] = []
    if (listen) cleanups.push(subscribeCanvasImage(f.terminal, () => {}))
    f.terminal.onText(() => events.push('text'))
    f.terminal.on('frame', ({ rows }) => events.push(`frame:${rows.join(',')}`))
    const step = async (action: () => void) => {
      action()
      await f.flush()
    }
    await step(() => f.terminal.write('\x1b[?25lA'))
    await step(() => f.terminal.refresh(0, 2))
    await step(() => f.terminal.selectAll())
    await step(() => f.terminal.clearSelection())
    await step(() => f.terminal.write('\x1b[2J\x1b[H'))
    await step(() => f.terminal.clearTextureAtlas())
    expect(events).toEqual([
      'text',
      'frame:0',
      'text',
      'frame:0,1,2',
      'text',
      'frame:0,1,2',
      'text',
      'frame:0,1,2',
      'text',
      'frame:0,1,2',
      'text',
      'frame:0,1,2',
    ])
  },
)

it('notifies a clear-only full WebGL rebuild even when no instances draw', async () => {
  const f = await fixture('webgl2')
  f.terminal.write('\x1b[?25l')
  await f.flush()
  const images: ImageData[] = []
  cleanups.push(subscribeCanvasImage(f.terminal, () => images.push(ownedImage(f.terminal))))
  const context = f.terminal.canvas?.getContext('webgl2')
  if (!context) throw new Error('Missing source WebGL context')
  const draw = vi.spyOn(context, 'drawArraysInstanced')
  cleanups.push(() => draw.mockRestore())
  const submitted = f.renderer.metrics.submittedFrames
  f.terminal.clearTextureAtlas()
  await f.flush()
  expect(draw).not.toHaveBeenCalled()
  expect(f.renderer.metrics.submittedFrames).toBe(submitted + 1)
  expect(images).toHaveLength(1)
  expect(images[0]!.data.every((value) => value === 0)).toBe(true)
})

it('stops image and public delivery immediately when an image listener disposes the terminal', async () => {
  const f = await fixture('webgl2')
  const second = vi.fn()
  const publicFrame = vi.fn()
  cleanups.push(subscribeCanvasImage(f.terminal, () => f.terminal.dispose()))
  cleanups.push(subscribeCanvasImage(f.terminal, second))
  f.terminal.on('frame', publicFrame)
  f.terminal.write('dispose')
  await f.flush()
  expect(f.terminal.lifecycle).toBe('disposed')
  expect(second).not.toHaveBeenCalled()
  expect(publicFrame).not.toHaveBeenCalled()
})

it.each([false, true])(
  'preserves deterministic blink publications, image subscriber=%s',
  async (listen) => {
    const f = await fixture('webgl2')
    if (listen) cleanups.push(subscribeCanvasImage(f.terminal, () => {}))
    f.terminal.focus()
    f.terminal.setCursor({ blink: true })
    f.terminal.write('\x1b[?25h')
    await f.flush()
    const events: string[] = []
    f.terminal.onText(() => events.push('text'))
    f.terminal.on('frame', ({ rows }) => events.push(`frame:${rows.join(',')}`))
    const blink = Array.from(f.clock?.timers.values() ?? []).at(-1)
    if (!blink) throw new Error('Missing cursor blink timer')
    blink()
    await f.flush()
    expect(events).toEqual(['text', 'frame:0'])
  },
)

it('reports a foreign-realm listener rejection once without an unhandled rejection', async () => {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  const child = iframe.contentWindow
  if (!child) throw new Error('Missing foreign realm')
  const evaluate: unknown = Reflect.get(child, 'eval')
  if (typeof evaluate !== 'function') throw new Error('Missing foreign evaluator')
  const rejected: unknown = evaluate.call(child, 'Promise.reject("foreign capture")')
  expect(rejected instanceof Promise).toBe(false)
  const unhandled: unknown[] = []
  const preventUnhandled = (event: PromiseRejectionEvent) => {
    event.preventDefault()
    unhandled.push(event.reason)
  }
  child.addEventListener('unhandledrejection', preventUnhandled)
  const reported: unknown[] = []
  const relay = new CanvasImageRelay((cause) => reported.push(cause))
  const publisher = relay.attach()
  cleanups.push(
    () => iframe.remove(),
    () => relay.dispose(),
  )
  try {
    relay.subscribe(() => rejected)
    expect(() => publisher.notify(() => true)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reported).toEqual(['foreign capture'])
    expect(unhandled).toEqual([])
  } finally {
    await Promise.resolve(rejected).catch(() => {})
    child.removeEventListener('unhandledrejection', preventUnhandled)
  }
})

function snapshotText(snapshot: ReturnType<Terminal['frameSnapshot']>) {
  return snapshot?.rows.map((row) => row.text.trimEnd())
}

it.each(
  (['webgl2', 'webgpu-direct', 'webgpu-coordinated', 'canvas2d'] satisfies Backend[]).flatMap(
    (backend) =>
      [false, true].flatMap((damaged) =>
        [false, true].map((cached) => ({ backend, damaged, cached })),
      ),
  ),
)(
  'reads the previous published image on $backend, damaged $damaged, cached $cached',
  async ({ backend, damaged, cached }) => {
    const f = await fixture(backend, true)
    expect(f.terminal.diagnostics.rendererBackend).toBe(
      backend.startsWith('webgpu') ? 'webgpu' : backend,
    )
    f.terminal.write('\x1b[?25lone')
    await f.flush()
    const expected = Array.from({ length: f.terminal.submittedFrame!.grid.rows }, (_, y) =>
      y === 0 ? 'one' : '',
    )
    const first = cached ? f.terminal.frameSnapshot() : undefined
    const seen: { snapshot: ReturnType<Terminal['frameSnapshot']>; text: string[] }[] = []
    cleanups.push(
      subscribeCanvasImage(f.terminal, () => {
        seen.push({
          snapshot: f.terminal.frameSnapshot(),
          text: f.terminal.visibleLines().map((line) => line.trimEnd()),
        })
      }),
    )
    if (damaged) f.terminal.write('\r\ntwo')
    else f.terminal.clearTextureAtlas()
    await f.flush()
    expect(f.errors).toEqual([])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.text).toEqual(expected)
    if (backend === 'canvas2d' && damaged && !cached) expect(seen[0]!.snapshot).toBeUndefined()
    else expect(snapshotText(seen[0]!.snapshot)).toEqual(expected)
    if (cached && damaged) expect(seen[0]!.snapshot).toBe(first)
  },
)

function liveRevision(terminal: Terminal): number {
  const execution: unknown = Reflect.get(terminal, 'execution')
  if (
    typeof execution !== 'object' ||
    execution === null ||
    !('revision' in execution) ||
    typeof execution.revision !== 'number'
  )
    throw new Error('Missing live execution revision')
  return execution.revision
}

it.each(['webgl2', 'webgpu-direct', 'webgpu-coordinated', 'canvas2d'] satisfies Backend[])(
  'records metadata before listener writes through built dist on %s',
  async (backend) => {
    const f = await fixture(backend, true)
    f.terminal.write('\x1b[?25lone')
    await f.flush()
    let captured = -1
    let once = true
    cleanups.push(
      subscribeCanvasImage(f.terminal, () => {
        if (!once) return
        once = false
        captured = liveRevision(f.terminal)
        f.terminal.write('X')
      }),
    )
    f.terminal.write('B')
    await f.flush()
    expect(captured).toBeGreaterThan(0)
    expect(f.terminal.submittedFrame!.nativeRevision).toBe(captured)
    expect(f.terminal.captureViewport()).toBeUndefined()
    expect(f.terminal.visibleLines()[0]!.trimEnd()).toBe('oneB')
    await f.flush()
    const viewport = f.terminal.captureViewport()
    expect(viewport).toEqual(expect.any(String))
    expect(f.terminal.visibleLines()[0]!.trimEnd()).toBe('oneBX')
    expect(f.errors).toEqual([])
  },
)
