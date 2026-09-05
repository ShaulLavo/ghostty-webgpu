import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { CanvasTerminalRenderer } from '../canvas/renderer.js'
import {
  WebGpuTerminalRenderer,
  WebGpuUnavailableError,
  type RenderStateSource,
  type WebGpuTerminalRendererOptions,
} from '../renderer.js'
import type { RenderSchedulerClock } from '../scheduler.js'
import { createCompatibleTerminalRenderer, type CompatibleTerminalRenderer } from '../selector.js'
import { WebGlTerminalRenderer } from '../webgl/renderer.js'

const canvases = new Set<HTMLCanvasElement>()
const devices = new Set<GPUDevice>()
const renderers = new Set<CompatibleTerminalRenderer>()
let sentinelDevice: GPUDevice

beforeAll(async () => {
  sentinelDevice = await requestDevice()
  devices.delete(sentinelDevice)
})

afterEach(async () => {
  for (const renderer of renderers) renderer.dispose()
  const losses = [...devices].map((device) => device.lost)
  for (const device of devices) device.destroy()
  await Promise.all(losses)
  for (const canvas of canvases) canvas.remove()
  renderers.clear()
  devices.clear()
  canvases.clear()
  vi.restoreAllMocks()
})

afterAll(async () => {
  const loss = sentinelDevice.lost
  sentinelDevice.destroy()
  await loss
})

class TestClock implements RenderSchedulerClock {
  private nextHandle = 0
  readonly frames = new Map<number, () => void>()

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  clearTimer(): void {}

  requestFrame(callback: () => void): number {
    const handle = this.nextHandle++
    this.frames.set(handle, callback)
    return handle
  }

  setTimer(): number {
    return this.nextHandle++
  }
}

const renderState: RenderStateSource = {
  acknowledge: () => 0,
  readCursor: () => ({
    blinking: false,
    passwordInput: false,
    style: 'block',
    visible: false,
  }),
  readRows: () => [],
  update: () => RenderStateDirty.False,
}

const font: TerminalFittedFont = {
  charLeft: 0,
  charTop: 2,
  cssCellHeight: 20,
  cssCellWidth: 10,
  deviceBaseline: 16,
  deviceCellHeight: 20,
  deviceCellWidth: 10,
  deviceCharHeight: 16,
  deviceCharWidth: 10,
  pixelRatio: 1,
  settings: {
    boldWeight: 700,
    family: 'monospace',
    letterSpacing: 0,
    lineHeight: 1.25,
    size: 16,
    weight: 400,
  },
}

async function requestDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('The browser test requires a WebGPU adapter')
  const device = await adapter.requestDevice()
  devices.add(device)
  return device
}

function unavailableDevice(): Promise<GPUDevice> {
  return Promise.reject(new WebGpuUnavailableError('adapter', 'No supported adapter'))
}

function fixture() {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  canvases.add(canvas)
  const clock = new TestClock()
  const options: WebGpuTerminalRendererOptions = {
    canvas,
    columns: 1,
    deviceFactory: requestDevice,
    font,
    renderState,
    rows: 1,
    schedulerClock: clock,
  }
  return { canvas, clock, options }
}

async function select(options: WebGpuTerminalRendererOptions) {
  const renderer = await createCompatibleTerminalRenderer(options)
  renderers.add(renderer)
  return renderer
}

function replaceGetContext(
  canvas: HTMLCanvasElement,
  implementation: (type: string, attributes?: unknown) => RenderingContext | null,
) {
  const getContext = vi.fn(implementation)
  Object.defineProperty(canvas, 'getContext', { configurable: true, value: getContext })
  return getContext
}

describe('compatible renderer selection', () => {
  it('selects real WebGPU without acquiring a fallback context', async () => {
    const { canvas, options } = fixture()
    const getContext = vi.spyOn(canvas, 'getContext')
    const renderer = await select(options)

    expect(renderer.backend).toBe('webgpu')
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgpu'])
  })

  it('selects real WebGL2 when no WebGPU adapter is available', async () => {
    const { canvas, options } = fixture()
    const getContext = vi.spyOn(canvas, 'getContext')
    const renderer = await select({ ...options, deviceFactory: unavailableDevice })

    expect(renderer.backend).toBe('webgl2')
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2'])
    expect(canvas.getContext('webgl2')).toBeInstanceOf(WebGL2RenderingContext)
  })

  it('releases the real WebGPU device before selecting WebGL2 after a missing context', async () => {
    const { canvas, options } = fixture()
    const device = await requestDevice()
    const destroy = vi.spyOn(device, 'destroy')
    const originalGetContext = canvas.getContext.bind(canvas)
    const getContext = replaceGetContext(canvas, (type, attributes) =>
      type === 'webgpu' ? null : originalGetContext(type, attributes),
    )
    const renderer = await select({ ...options, deviceFactory: () => Promise.resolve(device) })

    expect(renderer.backend).toBe('webgl2')
    expect(destroy).toHaveBeenCalledOnce()
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgpu', 'webgl2'])
  })

  it('selects real Canvas2D after both GPU capabilities are unavailable', async () => {
    const { canvas, options } = fixture()
    const attempts: string[] = []
    const originalGetContext = canvas.getContext.bind(canvas)
    replaceGetContext(canvas, (type, attributes) => {
      attempts.push(type)
      if (type === 'webgl2') return null
      return originalGetContext(type, attributes)
    })
    const renderer = await select({
      ...options,
      deviceFactory: () => {
        attempts.push('webgpu')
        return unavailableDevice()
      },
    })

    expect(renderer.backend).toBe('canvas2d')
    expect(attempts).toEqual(['webgpu', 'webgl2', '2d'])
    expect(canvas.getContext('2d')).toBeInstanceOf(CanvasRenderingContext2D)
  })

  it('propagates WebGPU programming failures without trying another context', async () => {
    const { canvas, options } = fixture()
    const getContext = vi.spyOn(canvas, 'getContext')
    const failure = new TypeError('Device setup failed')

    await expect(
      createCompatibleTerminalRenderer({
        ...options,
        deviceFactory: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure)
    expect(getContext).not.toHaveBeenCalled()
  })

  it('propagates invalid input before acquiring any device or context', async () => {
    const { canvas, options } = fixture()
    const getContext = vi.spyOn(canvas, 'getContext')
    const deviceFactory = vi.fn(unavailableDevice)

    await expect(
      createCompatibleTerminalRenderer({ ...options, columns: 0, deviceFactory }),
    ).rejects.toThrow(RangeError)
    expect(deviceFactory).not.toHaveBeenCalled()
    expect(getContext).not.toHaveBeenCalled()
  })

  it('propagates WebGL shader failures without claiming a Canvas2D context', async () => {
    const { canvas, options } = fixture()
    const context = canvas.getContext('webgl2')
    if (!context) throw new Error('The browser test requires a WebGL2 context')
    vi.spyOn(context, 'getShaderParameter').mockReturnValue(false)
    const getContext = vi.spyOn(canvas, 'getContext')

    await expect(
      createCompatibleTerminalRenderer({ ...options, deviceFactory: unavailableDevice }),
    ).rejects.toThrow()
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2'])
  })

  it('does not start a renderer when already aborted', async () => {
    const { canvas, options } = fixture()
    const controller = new AbortController()
    controller.abort()
    const deviceFactory = vi.fn(unavailableDevice)
    const getContext = vi.spyOn(canvas, 'getContext')

    await expect(
      createCompatibleTerminalRenderer({ ...options, deviceFactory }, controller.signal),
    ).rejects.toBe(controller.signal.reason)
    expect(deviceFactory).not.toHaveBeenCalled()
    expect(getContext).not.toHaveBeenCalled()
  })

  it('stops fallback when aborted while WebGPU initialization fails', async () => {
    const { canvas, options } = fixture()
    const controller = new AbortController()
    const getContext = vi.spyOn(canvas, 'getContext')

    await expect(
      createCompatibleTerminalRenderer(
        {
          ...options,
          deviceFactory: () => {
            controller.abort()
            return unavailableDevice()
          },
        },
        controller.signal,
      ),
    ).rejects.toBe(controller.signal.reason)
    expect(getContext).not.toHaveBeenCalled()
  })

  it('disposes a WebGPU renderer that finishes after cancellation', async () => {
    const { clock, options } = fixture()
    const controller = new AbortController()
    const dispose = vi.spyOn(WebGpuTerminalRenderer.prototype, 'dispose')

    await expect(
      createCompatibleTerminalRenderer(
        {
          ...options,
          deviceFactory: async () => {
            const device = await requestDevice()
            controller.abort()
            return device
          },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(dispose).toHaveBeenCalledOnce()
    expect(clock.frames.size).toBe(0)
  })

  it.each(['webgl2', 'canvas2d'] as const)(
    'disposes a %s renderer that finishes after cancellation',
    async (backend) => {
      const { canvas, clock, options } = fixture()
      const controller = new AbortController()
      const prototype =
        backend === 'webgl2' ? WebGlTerminalRenderer.prototype : CanvasTerminalRenderer.prototype
      const dispose = vi.spyOn(prototype, 'dispose')
      const originalGetContext = canvas.getContext.bind(canvas)
      replaceGetContext(canvas, (type, attributes) => {
        if (backend === 'canvas2d' && type === 'webgl2') return null
        const context = originalGetContext(type, attributes)
        controller.abort()
        return context
      })

      await expect(
        createCompatibleTerminalRenderer(
          { ...options, deviceFactory: unavailableDevice },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(dispose).toHaveBeenCalledOnce()
      expect(clock.frames.size).toBe(0)
    },
  )

  it('stops fallback when aborted while WebGL2 is found unavailable', async () => {
    const { canvas, options } = fixture()
    const controller = new AbortController()
    const getContext = replaceGetContext(canvas, () => {
      controller.abort()
      return null
    })

    await expect(
      createCompatibleTerminalRenderer(
        { ...options, deviceFactory: unavailableDevice },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2'])
  })
})
