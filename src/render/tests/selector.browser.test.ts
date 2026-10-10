import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import type { TerminalFittedFont } from '../../term/types.js'
import type { RendererPlatform } from './platforms.js'
import { stubRendererNavigator, restoreRendererNavigator } from './navigator.js'
import { rendererPlatforms } from './platforms.js'
import { FallbackTerminalRenderer } from '../fallback.js'
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
  const losses = Array.from(devices, (device) => device.lost)
  for (const device of devices) device.destroy()
  await Promise.all(losses)
  for (const canvas of canvases) canvas.remove()
  renderers.clear()
  devices.clear()
  canvases.clear()
  vi.restoreAllMocks()
  restoreRendererNavigator()
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

async function select(
  options: WebGpuTerminalRendererOptions,
  signal?: AbortSignal,
  platform: RendererPlatform = { platform: 'MacIntel', userAgent: '' },
) {
  stubRendererNavigator(platform)
  const renderer = await createCompatibleTerminalRenderer(options, signal)
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
  it.each(rendererPlatforms)('selects the automatic renderer for $name', async (platform) => {
    const { canvas, options } = fixture()
    const deviceFactory = vi.fn(requestDevice)
    const getContext = vi.spyOn(canvas, 'getContext')
    const renderer = await select({ ...options, deviceFactory }, undefined, platform.navigator)

    expect(renderer.backend).toBe(platform.backend)
    expect(getContext.mock.calls.map(([type]) => type)).toEqual([platform.backend])
    expect(deviceFactory.mock.calls.length).toBe(platform.backend === 'webgpu' ? 1 : 0)
  })

  it.each([
    'createShader',
    'createProgram',
    'createBuffer',
    'createVertexArray',
    'createTexture',
  ] as const)(
    'replaces the claimed Linux canvas after %s allocation fails and selects WebGPU',
    async (allocation) => {
      const { canvas, options } = fixture()
      const replacement = fixture().canvas
      const replaceCanvas = vi.fn(() => {
        canvas.replaceWith(replacement)
        return replacement
      })
      const deviceFactory = vi.fn(requestDevice)
      vi.spyOn(WebGL2RenderingContext.prototype, allocation).mockReturnValue(null)
      const renderer = await select({ ...options, replaceCanvas, deviceFactory }, undefined, {
        platform: 'Linux x86_64',
        userAgent: '',
      })
      expect(renderer.backend).toBe('webgpu')
      expect(replaceCanvas).toHaveBeenCalledOnce()
      expect(canvas.isConnected).toBe(false)
      expect(replacement.getContext('webgpu')).not.toBeNull()
      expect(deviceFactory).toHaveBeenCalledOnce()
    },
  )

  it.each(['limits', 'out-of-memory'] as const)(
    'continues to WebGPU after a Linux WebGL %s capability failure',
    async (failure) => {
      const { canvas, options } = fixture()
      const replaceCanvas = vi.fn(() => {
        const next = fixture().canvas
        canvas.replaceWith(next)
        return next
      })
      if (failure === 'limits')
        vi.spyOn(WebGL2RenderingContext.prototype, 'getParameter').mockReturnValue(1)
      else vi.spyOn(WebGL2RenderingContext.prototype, 'getError').mockReturnValue(0x0505)
      const renderer = await select({ ...options, replaceCanvas }, undefined, {
        platform: 'Linux x86_64',
        userAgent: '',
      })
      expect(renderer.backend).toBe('webgpu')
      expect(replaceCanvas).toHaveBeenCalledOnce()
    },
  )

  it('keeps Linux shader programming failures visible without replacing the canvas', async () => {
    const { options } = fixture()
    const replaceCanvas = vi.fn(() => fixture().canvas)
    const deviceFactory = vi.fn(requestDevice)
    vi.spyOn(WebGL2RenderingContext.prototype, 'getShaderParameter').mockReturnValue(false)
    await expect(
      select({ ...options, replaceCanvas, deviceFactory }, undefined, {
        platform: 'Linux x86_64',
        userAgent: '',
      }),
    ).rejects.toThrow('WebGL shader compilation failed')
    expect(replaceCanvas).not.toHaveBeenCalled()
    expect(deviceFactory).not.toHaveBeenCalled()
  })

  it.each(['canvas2d', 'dom'] as const)(
    'selects %s after Linux WebGL allocation and WebGPU capability failures',
    async (backend) => {
      const { canvas, options } = fixture()
      const replacement = fixture().canvas
      if (backend === 'dom') replaceGetContext(replacement, () => null)
      vi.spyOn(WebGL2RenderingContext.prototype, 'createShader').mockReturnValue(null)
      const renderer = await select(
        {
          ...options,
          deviceFactory: unavailableDevice,
          replaceCanvas: () => {
            canvas.replaceWith(replacement)
            return replacement
          },
        },
        undefined,
        { platform: 'Linux x86_64', userAgent: '' },
      )
      expect(renderer.backend).toBe(backend)
    },
  )

  it('replaces an unmanaged HTML canvas after Linux resource allocation fails', async () => {
    const { canvas, options } = fixture()
    vi.spyOn(WebGL2RenderingContext.prototype, 'createShader').mockReturnValue(null)
    const replaceWith = vi.spyOn(canvas, 'replaceWith')
    const renderer = await select(options, undefined, { platform: 'Linux x86_64', userAgent: '' })
    expect(renderer.backend).toBe('webgpu')
    expect(canvas.isConnected).toBe(false)
    expect(replaceWith).toHaveBeenCalledOnce()
    canvases.add(replaceWith.mock.calls[0]![0] as HTMLCanvasElement)
  })

  it('tries hardware WebGPU after the initial Linux WebGL context is lost', async () => {
    const { canvas, options } = fixture()
    const replacement = fixture().canvas
    const replaceCanvas = vi.fn(() => {
      canvas.replaceWith(replacement)
      return replacement
    })
    const deviceFactory = vi.fn(requestDevice)
    const renderer = await select({ ...options, replaceCanvas, deviceFactory }, undefined, {
      platform: 'Linux x86_64',
      userAgent: '',
    })
    expect(renderer.backend).toBe('webgl2')
    expect(deviceFactory).not.toHaveBeenCalled()
    const lost = new Promise<void>((resolve) =>
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }),
    )
    canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext()
    await lost
    await vi.waitFor(() => expect(renderer.backend).toBe('webgpu'))
    expect(replaceCanvas).toHaveBeenCalledOnce()
    expect(deviceFactory).toHaveBeenCalledOnce()
  })

  it('skips previously unavailable WebGPU after a WebGL-first fallback on macOS loses its context', async () => {
    const { canvas, options } = fixture()
    const replacement = fixture().canvas
    const deviceFactory = vi.fn(unavailableDevice)
    const renderer = await select({
      ...options,
      deviceFactory,
      replaceCanvas: () => {
        canvas.replaceWith(replacement)
        return replacement
      },
    })
    expect(renderer.backend).toBe('webgl2')
    expect(deviceFactory).toHaveBeenCalledOnce()
    const lost = new Promise<void>((resolve) =>
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }),
    )
    canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext()
    await lost
    await vi.waitFor(() => expect(renderer.backend).toBe('canvas2d'))
    expect(deviceFactory).toHaveBeenCalledOnce()
  })

  it.each(['abort', 'dispose'] as const)(
    'disposes WebGPU recovery that finishes after %s and preserves settings while acquiring it',
    async (action) => {
      const { canvas, clock, options } = fixture()
      const controller = new AbortController()
      const gate = Promise.withResolvers<void>()
      const deviceFactory = vi.fn(async () => {
        await gate.promise
        return requestDevice()
      })
      const dispose = vi.spyOn(WebGpuTerminalRenderer.prototype, 'dispose')
      const renderer = await select(
        {
          ...options,
          deviceFactory,
          replaceCanvas: () => {
            const replacement = fixture().canvas
            canvas.replaceWith(replacement)
            return replacement
          },
        },
        controller.signal,
        { platform: 'Linux x86_64', userAgent: '' },
      )
      const lost = new Promise<void>((resolve) =>
        canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }),
      )
      canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext()
      await lost
      await vi.waitFor(() => expect(deviceFactory).toHaveBeenCalledOnce())
      renderer.resize({ columns: 2, rows: 2 })
      renderer.setFont(font)
      renderer.setTheme({ foreground: { r: 0, g: 255, b: 0 } })
      renderer.setFocused(true)
      renderer.setDocumentVisible(false)
      if (action === 'abort') controller.abort()
      else await renderer.dispose()
      gate.resolve()
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
      expect(clock.frames.size).toBe(0)
    },
  )

  it('uses the managed WebGL fallback first on desktop Linux', async () => {
    const { canvas, options } = fixture()
    const deviceFactory = vi.fn(requestDevice)
    const renderer = await select(
      { ...options, deviceFactory, replaceCanvas: () => canvas },
      undefined,
      { platform: 'Linux x86_64', userAgent: '' },
    )

    expect(renderer).toBeInstanceOf(FallbackTerminalRenderer)
    expect(renderer.backend).toBe('webgl2')
    expect(deviceFactory).not.toHaveBeenCalled()
  })

  it('selects WebGPU on desktop Linux when WebGL is unavailable', async () => {
    const { canvas, options } = fixture()
    const originalGetContext = canvas.getContext.bind(canvas)
    const getContext = replaceGetContext(canvas, (type, attributes) =>
      type === 'webgl2' ? null : originalGetContext(type, attributes),
    )
    const renderer = await select(options, undefined, { platform: 'Linux x86_64', userAgent: '' })

    expect(renderer.backend).toBe('webgpu')
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2', 'webgpu'])
  })

  it.each(['canvas2d', 'dom'] as const)(
    'selects %s on desktop Linux after both GPU capabilities are unavailable',
    async (backend) => {
      const { canvas, options } = fixture()
      const attempts: string[] = []
      const originalGetContext = canvas.getContext.bind(canvas)
      replaceGetContext(canvas, (type, attributes) => {
        attempts.push(type)
        if (type === 'webgl2' || backend === 'dom') return null
        return originalGetContext(type, attributes)
      })
      const renderer = await select(
        {
          ...options,
          deviceFactory: () => {
            attempts.push('webgpu')
            return unavailableDevice()
          },
        },
        undefined,
        { platform: 'Linux x86_64', userAgent: '' },
      )

      expect(renderer.backend).toBe(backend)
      expect(attempts).toEqual(['webgl2', 'webgpu', '2d'])
    },
  )

  it('stops Linux fallback when aborted during the first WebGL attempt', async () => {
    const { canvas, options } = fixture()
    const controller = new AbortController()
    const deviceFactory = vi.fn(requestDevice)
    const getContext = replaceGetContext(canvas, () => {
      controller.abort()
      return null
    })

    await expect(
      select({ ...options, deviceFactory }, controller.signal, {
        platform: 'Linux x86_64',
        userAgent: '',
      }),
    ).rejects.toBe(controller.signal.reason)
    expect(deviceFactory).not.toHaveBeenCalled()
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2'])
  })

  it.each([
    { isFallbackAdapter: true, info: {} },
    { isFallbackAdapter: false, info: { isFallbackAdapter: true } },
    { isFallbackAdapter: false, info: { description: 'Google SwiftShader' } },
    { isFallbackAdapter: false, info: { architecture: 'llvmpipe' } },
  ])('selects WebGL for a software adapter in auto (%j)', async (identity) => {
    const { canvas, options } = fixture()
    const device = await requestDevice()
    const acquire = vi.fn().mockResolvedValue(device)
    vi.spyOn(navigator.gpu, 'requestAdapter').mockResolvedValue({
      ...identity,
      requestDevice: acquire,
    } as unknown as GPUAdapter)
    const getContext = vi.spyOn(canvas, 'getContext')

    const renderer = await select({ ...options, deviceFactory: undefined })

    expect(renderer.backend).toBe('webgl2')
    expect(acquire).not.toHaveBeenCalled()
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2'])
  })

  it('allows a software adapter with explicit WebGPU while auto selects WebGL', async () => {
    const { options } = fixture()
    const device = await requestDevice()
    const acquire = vi.fn().mockResolvedValue(device)
    vi.spyOn(navigator.gpu, 'requestAdapter').mockResolvedValue({
      isFallbackAdapter: true,
      info: { description: 'SwiftShader' },
      requestDevice: acquire,
    } as unknown as GPUAdapter)
    const explicit = await WebGpuTerminalRenderer.create({ ...options, deviceFactory: undefined })
    renderers.add(explicit)
    const automatic = await select({ ...fixture().options, deviceFactory: undefined })

    expect(explicit.backend).toBe('webgpu')
    expect(automatic.backend).toBe('webgl2')
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('keeps a hardware adapter eligible for auto', async () => {
    const { options } = fixture()
    const device = await requestDevice()
    vi.spyOn(navigator.gpu, 'requestAdapter').mockResolvedValue({
      isFallbackAdapter: false,
      info: { vendor: 'apple', architecture: 'metal', description: 'Apple M1' },
      requestDevice: vi.fn().mockResolvedValue(device),
    } as unknown as GPUAdapter)

    const renderer = await select({ ...options, deviceFactory: undefined })

    expect(renderer.backend).toBe('webgpu')
  })

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
      select({
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

    await expect(select({ ...options, columns: 0, deviceFactory })).rejects.toThrow(RangeError)
    expect(deviceFactory).not.toHaveBeenCalled()
    expect(getContext).not.toHaveBeenCalled()
  })

  it('propagates WebGL shader failures without claiming a Canvas2D context', async () => {
    const { canvas, options } = fixture()
    const context = canvas.getContext('webgl2')
    if (!context) throw new Error('The browser test requires a WebGL2 context')
    vi.spyOn(context, 'getShaderParameter').mockReturnValue(false)
    const getContext = vi.spyOn(canvas, 'getContext')

    await expect(select({ ...options, deviceFactory: unavailableDevice })).rejects.toThrow()
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2'])
  })

  it('does not start a renderer when already aborted', async () => {
    const { canvas, options } = fixture()
    const controller = new AbortController()
    controller.abort()
    const deviceFactory = vi.fn(unavailableDevice)
    const getContext = vi.spyOn(canvas, 'getContext')

    await expect(select({ ...options, deviceFactory }, controller.signal)).rejects.toBe(
      controller.signal.reason,
    )
    expect(deviceFactory).not.toHaveBeenCalled()
    expect(getContext).not.toHaveBeenCalled()
  })

  it('stops fallback when aborted while WebGPU initialization fails', async () => {
    const { canvas, options } = fixture()
    const controller = new AbortController()
    const getContext = vi.spyOn(canvas, 'getContext')

    await expect(
      select(
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
      select(
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
        select({ ...options, deviceFactory: unavailableDevice }, controller.signal),
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
      select({ ...options, deviceFactory: unavailableDevice }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(getContext.mock.calls.map(([type]) => type)).toEqual(['webgl2'])
  })
})
