import { createGhosttyError } from '../../../core/error.js'
import { calculateTerminalFittedFont } from '../../../dom/fit.js'
import { TerminalSession } from '../../../term/session.js'
import type { RenderSchedulerClock } from '../../scheduler.js'
import { WebGpuTerminalRenderer, type RendererTextFrameSnapshot } from '../../renderer.js'
import { WebGlTerminalRenderer } from '../../webgl/renderer.js'
import type {
  WorkerCleanup,
  WorkerObservation,
  WorkerRenderMessage,
  WorkerRenderRequest,
} from './worker-protocol.js'

const scope = globalThis as unknown as {
  fonts: FontFaceSet
  onmessage: ((event: MessageEvent<WorkerRenderRequest>) => void) | null
  postMessage: (message: WorkerRenderMessage) => void
  requestAnimationFrame: (callback: FrameRequestCallback) => number
  cancelAnimationFrame: (handle: number) => void
  setTimeout: (callback: () => void, delay: number) => number
  clearTimeout: (handle: number) => void
}

function receiveOutput(port: MessagePort): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timeout = scope.setTimeout(() => {
      port.onmessage = null
      reject(createGhosttyError('worker output', 'Producer output timed out'))
    }, 5_000)
    port.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
      scope.clearTimeout(timeout)
      port.onmessage = null
      resolve(data)
    }
    port.start()
    scope.postMessage({ type: 'output-ready' })
  })
}

async function run(request: WorkerRenderRequest): Promise<void> {
  const frames = new Set<number>()
  const timers = new Set<number>()
  let animationFrames = 0
  const clock: RenderSchedulerClock = {
    requestFrame(callback) {
      const handle = scope.requestAnimationFrame(() => {
        frames.delete(handle)
        animationFrames += 1
        callback()
      })
      frames.add(handle)
      return handle
    },
    cancelFrame(handle) {
      scope.cancelAnimationFrame(handle)
      frames.delete(handle)
    },
    setTimer(callback, delay) {
      const handle = scope.setTimeout(() => {
        timers.delete(handle)
        callback()
      }, delay)
      timers.add(handle)
      return handle
    },
    clearTimer(handle) {
      scope.clearTimeout(handle)
      timers.delete(handle)
    },
  }
  let face: FontFace | undefined
  let session: TerminalSession | undefined
  let renderer: WebGpuTerminalRenderer | WebGlTerminalRenderer | undefined
  let device: GPUDevice | undefined
  let failure: unknown
  let frameTimeout: number | undefined
  try {
    face = await new FontFace('WorkerNativeFixture', `url(${request.fontUrl})`).load()
    scope.fonts.add(face)
    await scope.fonts.load('16px WorkerNativeFixture')
    const scratch = new OffscreenCanvas(128, 32)
    const context = scratch.getContext('2d')!
    context.font = '16px WorkerNativeFixture'
    context.fillText('Mg', 0, 20)
    const glyphInk = context
      .getImageData(0, 0, 128, 32)
      .data.some((value, index) => index % 4 === 3 && value > 0)
    const metrics = context.measureText('M')
    const font = calculateTerminalFittedFont(
      {
        family: 'WorkerNativeFixture',
        size: 16,
        weight: 400,
        boldWeight: 700,
        letterSpacing: 0,
        lineHeight: 1,
      },
      {
        advanceWidth: metrics.width,
        fontAscent: metrics.fontBoundingBoxAscent,
        fontDescent: metrics.fontBoundingBoxDescent,
      },
      1,
    )
    session = await TerminalSession.create({
      runtime: {
        kind: 'owned',
        options: { wasm: request.wasmUrl, bridge: request.bridgeUrl },
      },
      appearance: { grid: { columns: 24, rows: 4 }, font: font.settings, cursor: { blink: true } },
    })
    session.write('worker native\r\n\x1b[?2004h')
    session.write(await receiveOutput(request.output))
    const key = session.key({ action: 'press', code: 'KeyA', composing: false, text: 'a' })
    const paste = session.paste('paste')
    const painted = Promise.withResolvers<RendererTextFrameSnapshot>()
    frameTimeout = scope.setTimeout(
      () => painted.reject(createGhosttyError('worker frame', 'Native frame timed out')),
      5_000,
    )
    const options = {
      canvas: request.canvas,
      columns: 24,
      rows: 4,
      font,
      renderState: session.renderState,
      schedulerClock: clock,
      cursorBlink: true,
      onTextFrame: painted.resolve,
      onError: painted.reject,
    }
    if (request.backend === 'webgpu') {
      renderer = await WebGpuTerminalRenderer.create({
        ...options,
        async deviceFactory() {
          const adapter = await navigator.gpu.requestAdapter()
          if (!adapter) throw createGhosttyError('worker device', 'Worker adapter unavailable')
          device = await adapter.requestDevice()
          return device
        },
      })
    } else {
      renderer = await WebGlTerminalRenderer.create(options)
    }
    renderer.setFocused(true)
    renderer.schedule()
    const frame = await painted.promise
    renderer.schedule()
    scope.clearTimeout(frameTimeout)
    frameTimeout = undefined
    const observation: WorkerObservation = {
      globalType: Object.prototype.toString.call(globalThis),
      windowType: typeof window,
      fontLoaded: face.status === 'loaded' && scope.fonts.has(face),
      glyphInk,
      text: frame.rows.map((row) => row.text).join('\n'),
      cursor: session.cursor,
      key: Array.from(key),
      paste: Array.from(paste),
      metrics: { ...renderer.metrics },
      animationFrames,
    }
    scope.postMessage({ type: 'result', observation })
    if (request.failAfterFrame)
      throw createGhosttyError('worker fixture', 'Injected worker failure after native frame')
  } catch (cause) {
    failure = cause
  } finally {
    if (frameTimeout !== undefined) scope.clearTimeout(frameTimeout)
    const metrics = renderer ? { ...renderer.metrics } : undefined
    const framesBeforeDispose = frames.size
    const timersBeforeDispose = timers.size
    renderer?.dispose()
    session?.dispose()
    let sessionDisposed = false
    if (session) {
      try {
        session.readLines(0, 1)
      } catch {
        sessionDisposed = true
      }
    }
    const fontRemoved = face ? scope.fonts.delete(face) && !scope.fonts.has(face) : true
    request.output.close()
    const deviceLoss = device ? await device.lost : undefined
    const cleanup: WorkerCleanup = {
      framesBeforeDispose,
      timersBeforeDispose,
      frames: frames.size,
      timers: timers.size,
      fontRemoved,
      outputClosed: true,
      sessionDisposed,
      backendReleased:
        request.backend === 'webgl'
          ? request.canvas.getContext('webgl2')?.isContextLost() === true
          : deviceLoss?.reason === 'destroyed',
      metrics,
    }
    scope.postMessage({ type: 'disposed', cleanup })
  }
  if (failure !== undefined) {
    scope.setTimeout(() => {
      throw failure
    }, 0)
    return
  }
  scope.postMessage({ type: 'complete' })
}

scope.onmessage = ({ data }) => {
  scope.onmessage = null
  void run(data)
}
