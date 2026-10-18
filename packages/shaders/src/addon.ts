import type { ExtensionScope, TerminalApi } from 'ghostty-webgpu'
import { FrameSchedule, type ShaderFrame } from './frame-schedule.js'
import { WebGlShaderPass, WebGpuShaderPass, type ShaderPass } from './pass.js'
import { packShaderUniforms, SHADER_UNIFORM_BYTE_LENGTH } from './uniforms.js'
import { frameUniforms, UniformState } from './terminal-uniforms.js'
import {
  ShaderAddonError,
  validateShader,
  type CompiledShader,
  type ShaderAddon,
  type ShaderAddonApi,
  type ShaderAddonOptions,
} from './types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Lifecycle promises can reject before a consumer starts awaiting them.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

async function acquireDevice(gpu: GPU | undefined): Promise<GPUDevice | undefined> {
  if (!gpu) return undefined
  try {
    const adapter = await gpu.requestAdapter()
    return await adapter?.requestDevice()
  } catch {
    return undefined
  }
}

function createGlPass(canvas: HTMLCanvasElement): ShaderPass {
  try {
    return new WebGlShaderPass(canvas)
  } catch (cause) {
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
    throw cause
  }
}

async function createPass(
  canvas: HTMLCanvasElement,
  shader: CompiledShader,
  options: ShaderAddonOptions,
  terminalBackend: TerminalApi['diagnostics']['rendererBackend'],
  onError: (cause: unknown) => void,
): Promise<ShaderPass> {
  const preferGl = !shader.wgsl || (terminalBackend === 'webgl2' && Boolean(shader.glsl))
  const backend = options.backend ?? (preferGl ? 'webgl2' : 'webgpu')
  if (backend === 'webgl2') {
    if (!shader.glsl) throw new ShaderAddonError('backend', 'WebGL2 requires compiled GLSL output.')
    return createGlPass(canvas)
  }
  if (!shader.wgsl) throw new ShaderAddonError('backend', 'WebGPU requires compiled WGSL output.')
  const device = await acquireDevice(canvas.ownerDocument.defaultView?.navigator.gpu)
  if (!device && !options.backend && shader.glsl) return createGlPass(canvas)
  if (!device)
    throw new ShaderAddonError(
      'backend',
      'A WebGPU adapter and device are unavailable. Supply GLSL to enable WebGL2 output.',
    )
  try {
    const pass = new WebGpuShaderPass(device, canvas, onError)
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') onError(info)
    })
    device.addEventListener('uncapturederror', (event) => onError(event.error))
    return pass
  } catch (cause) {
    canvas.getContext('webgpu')?.unconfigure()
    device.destroy()
    throw cause
  }
}

class Controller implements ShaderAddonApi {
  readonly #installed = deferred<void>()
  readonly #available = deferred<ShaderPass>()
  readonly ready = this.#installed.promise
  readonly #frames = new FrameSchedule()
  readonly #uniforms = new ArrayBuffer(SHADER_UNIFORM_BYTE_LENGTH)
  readonly #state = new UniformState()
  readonly #terminal: TerminalApi
  #pass: ShaderPass | undefined
  #output: HTMLCanvasElement | undefined
  #capture: HTMLCanvasElement | undefined
  #source: HTMLCanvasElement | undefined
  #view: Window | undefined
  #observer: ResizeObserver | undefined
  #disposed = false
  #started = false
  #revision = 0
  #raf = 0
  #resizeRaf = 0
  #paused: boolean
  #captured = false
  #upload = false
  #shaderReady = false
  #compiles: Promise<unknown> = Promise.resolve()
  #cleanup: (() => void)[] = []

  constructor(
    readonly scope: ExtensionScope,
    readonly shader: CompiledShader,
    readonly options: ShaderAddonOptions,
  ) {
    this.#terminal = scope.terminal
    this.#paused = options.paused ?? false
    scope.own(() => this.dispose())
    this.#cleanup.push(this.#terminal.on('open', () => this.start()).dispose)
    this.#cleanup.push(this.#terminal.on('frame', () => this.capture()).dispose)
    this.#cleanup.push(this.#terminal.on('appearance', () => this.invalidate()).dispose)
    if (this.#terminal.lifecycle === 'open') this.start()
    void this.setShader(shader).catch(() => {})
  }

  start(): void {
    if (this.#disposed || this.#started) return
    this.#started = true
    void this.initialize().catch((cause) => this.fail(cause))
  }

  async initialize(): Promise<void> {
    const terminal = this.#terminal
    const root = terminal.element
    const source = terminal.canvas
    if (!root || !source)
      throw new ShaderAddonError('capture', 'Open the terminal with a canvas renderer.')
    const snapshot = terminal.frameSnapshot()
    if (snapshot && 'then' in snapshot) {
      void snapshot.catch(() => {})
      throw new ShaderAddonError(
        'worker',
        'Shader capture requires a main-thread terminal. Worker frames arrive after the source drawing buffer is presented.',
      )
    }
    if (terminal.diagnostics.rendererBackend === 'dom')
      throw new ShaderAddonError(
        'backend',
        'Shader capture requires a WebGPU, WebGL2, or Canvas2D terminal renderer.',
      )
    const view = root.ownerDocument.defaultView
    if (!view) throw new ShaderAddonError('capture', 'The terminal must belong to a window.')
    this.#view = view
    const output = root.ownerDocument.createElement('canvas')
    output.dataset['ghosttyShader'] = ''
    output.setAttribute('aria-hidden', 'true')
    output.style.cssText = 'position:absolute;pointer-events:none;display:none;'
    this.#output = output
    this.#capture = root.ownerDocument.createElement('canvas')
    source.after(output)
    this.listen(root.ownerDocument, 'visibilitychange', this.synchronize)
    this.listen(view, 'resize', this.resized)
    this.listen(root, 'focusin', this.focused)
    this.listen(root, 'focusout', this.focused)
    this.listen(root, 'pointermove', this.pointer)
    this.listen(root, 'pointerdown', this.pointer)
    this.listen(view, 'pointerup', this.pointer)
    this.listen(output, 'webglcontextlost', this.contextLost)
    this.#observer = new ResizeObserver(this.resized)
    this.#observer.observe(source)
    const pass = await createPass(
      output,
      this.shader,
      this.options,
      terminal.diagnostics.rendererBackend,
      (cause) => this.fail(cause),
    )
    if (this.#disposed) {
      pass.dispose()
      return
    }
    this.#pass = pass
    output.dataset['backend'] = pass.backend
    this.#available.resolve(pass)
    this.synchronize()
    // A row refresh can submit no draw; rebuild once to capture an already-presented WebGL canvas.
    terminal.clearTextureAtlas()
  }

  setShader(shader: CompiledShader): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false)
    const revision = ++this.#revision
    const operation = this.#compiles
      .catch(() => {})
      .then(async () => {
        if (!this.current(revision)) return false
        validateShader(shader)
        const pass = await this.#available.promise
        if (!this.current(revision)) return false
        if (pass.backend === 'webgpu' && !shader.wgsl)
          throw new ShaderAddonError('backend', 'WebGPU requires compiled WGSL output.')
        if (pass.backend === 'webgl2' && !shader.glsl)
          throw new ShaderAddonError('backend', 'WebGL2 requires compiled GLSL output.')
        await pass.setShader(shader, () => this.current(revision))
        if (!this.current(revision)) return false
        this.#shaderReady = true
        this.#installed.resolve()
        this.invalidate()
        return true
      })
      .catch((cause: unknown) => {
        if (!this.current(revision)) return false
        if (!this.#shaderReady) this.fail(cause)
        throw cause
      })
    this.#compiles = operation
    return operation
  }

  current(revision: number): boolean {
    return !this.#disposed && revision === this.#revision
  }

  setPaused(paused: boolean): void {
    this.#paused = paused
    this.synchronize()
  }

  readonly synchronize = (): void => {
    if (!this.#view || this.#disposed) return
    this.#frames.setActive(
      !this.#paused && !this.#view.document.hidden,
      this.#view.performance.now(),
    )
    this.#view.cancelAnimationFrame(this.#raf)
    this.#raf = 0
    this.invalidate()
  }

  readonly focused = (): void => {
    this.#state.focusChanged(this.#frames.timeAt(this.#view?.performance.now() ?? 0))
    this.invalidate()
  }

  readonly pointer = (event: Event): void => {
    if (!('clientX' in event) || typeof event.clientX !== 'number') return
    if (!('clientY' in event) || typeof event.clientY !== 'number') return
    const canvas = this.#output
    if (!canvas || !canvas.width || !canvas.height) return
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    this.#state.pointer(
      event.type,
      ((event.clientX - rect.left) * canvas.width) / rect.width,
      ((rect.bottom - event.clientY) * canvas.height) / rect.height,
    )
    this.invalidate()
  }

  readonly contextLost = (event: Event): void => {
    event.preventDefault()
    this.fail(new ShaderAddonError('gpu', 'The shader output WebGL2 context was lost.'))
  }

  readonly resized = (): void => {
    if (this.#disposed || !this.#view || this.#resizeRaf) return
    this.#resizeRaf = this.#view.requestAnimationFrame(this.refresh)
  }

  readonly refresh = (): void => {
    this.#resizeRaf = 0
    if (this.#disposed) return
    this.layout()
    if (this.#terminal.lifecycle === 'open')
      this.#terminal.refresh(0, this.#terminal.appearance.grid.rows - 1)
  }

  layout(): void {
    const source = this.#terminal.canvas
    const output = this.#output
    if (!source || !output || !this.#view) return
    if (this.#source !== source) {
      this.#observer?.disconnect()
      this.#observer?.observe(source)
      this.#source = source
      source.after(output)
    }
    const css = this.#view.getComputedStyle(source)
    const left = parseFloat(css.paddingLeft) || 0
    const top = parseFloat(css.paddingTop) || 0
    output.style.left = `${source.offsetLeft + source.clientLeft + left}px`
    output.style.top = `${source.offsetTop + source.clientTop + top}px`
    output.style.width = `${source.clientWidth - left - (parseFloat(css.paddingRight) || 0)}px`
    output.style.height = `${source.clientHeight - top - (parseFloat(css.paddingBottom) || 0)}px`
    this.#pass?.resize({ width: source.width, height: source.height })
  }

  capture(): void {
    if (this.#disposed || !this.#capture || !this.#pass) return
    const source = this.#terminal.canvas
    if (!source || !source.width || !source.height) return
    try {
      this.layout()
      const copy = this.#capture
      if (copy.width !== source.width) copy.width = source.width
      if (copy.height !== source.height) copy.height = source.height
      const context = copy.getContext('2d')
      if (!context)
        throw new ShaderAddonError('capture', 'A Canvas2D snapshot context is unavailable.')
      // WebGL's non-preserved drawing buffer must be copied inside the frame callback.
      // A no-draw WebGL notification exposes transparent pixels; retain the last opaque snapshot.
      context.drawImage(source, 0, 0)
      this.#captured = true
      this.#upload = true
      this.invalidate()
    } catch (cause) {
      this.fail(cause)
    }
  }

  invalidate(): void {
    this.#frames.invalidate()
    this.schedule()
  }

  schedule(): void {
    if (this.#disposed || !this.#view || this.#view.document.hidden || this.#raf) return
    if (!this.#captured || !this.#shaderReady || !this.#frames.pending) return
    this.#raf = this.#view.requestAnimationFrame(this.animate)
  }

  readonly animate = (timestamp: number): void => {
    this.#raf = 0
    try {
      this.#frames.draw(timestamp, this.draw)
    } catch (cause) {
      this.fail(cause)
    }
    this.schedule()
  }

  readonly draw = (frame: ShaderFrame): boolean => {
    const pass = this.#pass
    const copy = this.#capture
    if (this.#disposed || !pass || !copy || !pass.ready()) return false
    if (this.#upload) {
      pass.capture(copy)
      this.#upload = false
    }
    const uniforms = frameUniforms(this.#terminal, this.#state, frame, copy)
    const drawn = pass.draw(packShaderUniforms(uniforms, this.#uniforms))
    if (drawn && this.#output) this.#output.style.display = 'block'
    return drawn
  }

  listen(target: EventTarget, type: string, callback: EventListener): void {
    target.addEventListener(type, callback)
    this.#cleanup.push(() => target.removeEventListener(type, callback))
  }

  fail(cause: unknown): void {
    if (this.#disposed) return
    const error =
      cause instanceof ShaderAddonError
        ? cause
        : new ShaderAddonError('gpu', 'The shader output could not render.', { cause })
    this.#installed.reject(error)
    this.#available.reject(error)
    this.dispose()
    this.options.onError?.(error)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#revision += 1
    const error = new ShaderAddonError('disposed', 'The shader extension was disposed.')
    this.#installed.reject(error)
    this.#available.reject(error)
    this.#view?.cancelAnimationFrame(this.#raf)
    this.#view?.cancelAnimationFrame(this.#resizeRaf)
    this.#raf = 0
    this.#resizeRaf = 0
    this.#observer?.disconnect()
    for (const cleanup of this.#cleanup) cleanup()
    this.#cleanup = []
    this.#pass?.dispose()
    this.#output?.remove()
    if (this.#capture) {
      this.#capture.width = 0
      this.#capture.height = 0
    }
  }
}

export function createShaderAddon(
  shader: CompiledShader,
  options: ShaderAddonOptions = {},
): ShaderAddon {
  validateShader(shader)
  return {
    name: 'ghostty-webgpu-shaders',
    setup: (scope) => ({ api: new Controller(scope, shader, options) }),
  }
}
