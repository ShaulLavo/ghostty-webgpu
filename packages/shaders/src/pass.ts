import { ShaderAddonError, type CompiledShader } from './types.js'
import { FULLSCREEN_VERTEX_GLSL, FULLSCREEN_VERTEX_WGSL } from './vertices.js'
import { SHADER_UNIFORM_BYTE_LENGTH } from './uniforms.js'

type ShaderPassErrorHandler = (cause: unknown) => void

export interface ShaderPass {
  readonly backend: 'webgpu' | 'webgl2'
  resize(size: ShaderOutputSize): void
  capture(source: HTMLCanvasElement): void
  ready(): boolean
  draw(uniforms: ArrayBuffer): boolean
  setShader(shader: CompiledShader, current: () => boolean): Promise<void>
  dispose(): void
}

export interface ShaderOutputSize {
  readonly height: number
  readonly width: number
}

function requireResource<T>(value: T | null, name: string): T {
  if (value === null) throw new ShaderAddonError('gpu', `Could not create ${name}`)
  return value
}

function shaderLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: SHADER_UNIFORM_BYTE_LENGTH },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  })
}

interface GpuTextures {
  raw: GPUTexture
  shader: GPUBindGroup
  width: number
  height: number
}

export class WebGpuShaderPass implements ShaderPass {
  readonly backend = 'webgpu'
  readonly #canvas: HTMLCanvasElement
  readonly #context: GPUCanvasContext
  readonly #device: GPUDevice
  readonly #format: GPUTextureFormat
  readonly #vertex: GPUShaderModule
  readonly #layout: GPUBindGroupLayout
  readonly #uniforms: GPUBuffer
  readonly #sampler: GPUSampler
  readonly #onError: ShaderPassErrorHandler
  #shaderPipeline: GPURenderPipeline | undefined
  #textures: GpuTextures | undefined
  #effectReady = true
  #disposed = false

  constructor(device: GPUDevice, canvas: HTMLCanvasElement, onError: ShaderPassErrorHandler) {
    this.#device = device
    this.#canvas = canvas
    this.#onError = onError
    this.#context = requireResource(canvas.getContext('webgpu'), 'WebGPU output context')
    this.#format = navigator.gpu.getPreferredCanvasFormat()
    this.#context.configure({ device, format: this.#format, alphaMode: 'opaque' })
    this.#layout = shaderLayout(device)
    this.#vertex = device.createShaderModule({ code: FULLSCREEN_VERTEX_WGSL })
    this.#uniforms = device.createBuffer({
      size: SHADER_UNIFORM_BYTE_LENGTH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    })
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  }

  async setShader(shader: CompiledShader, current: () => boolean): Promise<void> {
    if (this.#disposed) return
    const device = this.#device
    device.pushErrorScope('validation')
    let pipeline: GPURenderPipeline | undefined
    let failure: unknown
    try {
      const module = device.createShaderModule({ code: shader.wgsl ?? '' })
      const info = await module.getCompilationInfo()
      const messages = info.messages.filter((message) => message.type === 'error')
      if (messages.length > 0) {
        throw new ShaderAddonError('gpu', messages.map((message) => message.message).join('\n'))
      }
      if (!this.#disposed)
        pipeline = await device.createRenderPipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
          vertex: { module: this.#vertex, entryPoint: 'main' },
          fragment: {
            module,
            entryPoint: shader.entryPoint ?? 'main',
            targets: [{ format: this.#format }],
          },
          primitive: { topology: 'triangle-list' },
        })
    } catch (cause) {
      failure = cause
    }
    const validation = await device.popErrorScope()
    if (this.#disposed) return
    if (failure !== undefined) throw failure
    if (validation) throw new ShaderAddonError('gpu', validation.message)
    if (current()) this.#shaderPipeline = pipeline
  }

  resize(size: ShaderOutputSize): void {
    if (this.#disposed) return
    if (this.#canvas.width === size.width && this.#canvas.height === size.height) return
    this.#canvas.width = size.width
    this.#canvas.height = size.height
  }

  capture(source: HTMLCanvasElement): void {
    if (
      this.#disposed ||
      source.width === 0 ||
      source.height === 0 ||
      this.#canvas.width === 0 ||
      this.#canvas.height === 0
    )
      return
    const textures = this.#texturesFor(source.width, source.height)
    this.#device.queue.copyExternalImageToTexture(
      { source, flipY: true },
      { texture: textures.raw },
      [source.width, source.height],
    )
  }

  ready(): boolean {
    return !this.#disposed && this.#effectReady
  }

  draw(uniforms: ArrayBuffer): boolean {
    if (this.#disposed || !this.#textures || !this.#effectReady) return false
    const pipeline = this.#shaderPipeline
    if (!pipeline) return false
    this.#device.queue.writeBuffer(this.#uniforms, 0, uniforms)
    const encoder = this.#device.createCommandEncoder()
    this.#render(
      encoder,
      this.#context.getCurrentTexture().createView(),
      pipeline,
      this.#textures.shader,
    )
    this.#device.queue.submit([encoder.finish()])
    this.#trackEffectCompletion()
    return true
  }

  #trackEffectCompletion(): void {
    this.#effectReady = false
    const completion = this.#device.queue.onSubmittedWorkDone()
    void completion.then(this.#effectCompleted, this.#effectFailed)
  }

  readonly #effectCompleted = (): void => {
    if (this.#disposed) return
    this.#effectReady = true
  }

  readonly #effectFailed = (cause: unknown): void => {
    if (this.#disposed) return
    this.#onError(cause)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#textures?.raw.destroy()
    this.#uniforms.destroy()
    this.#context.unconfigure()
    this.#device.destroy()
  }

  #texturesFor(width: number, height: number): GpuTextures {
    if (this.#textures?.width === width && this.#textures.height === height) return this.#textures
    this.#textures?.raw.destroy()
    const raw = this.#device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.#textures = {
      raw,
      width,
      height,
      shader: this.#device.createBindGroup({
        layout: this.#layout,
        entries: [
          { binding: 0, resource: { buffer: this.#uniforms } },
          { binding: 1, resource: raw.createView() },
          { binding: 2, resource: this.#sampler },
        ],
      }),
    }
    return this.#textures
  }

  #render(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    pipeline: GPURenderPipeline,
    bindings: GPUBindGroup,
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindings)
    pass.draw(3)
    pass.end()
  }
}

function compileGlShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = requireResource(gl.createShader(type), 'WebGL shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  const message = gl.getShaderInfoLog(shader)
  gl.deleteShader(shader)
  throw new ShaderAddonError('gpu', `WebGL shader compilation failed: ${message}`)
}

export class WebGlShaderPass implements ShaderPass {
  readonly backend = 'webgl2'
  readonly #canvas: HTMLCanvasElement
  readonly #gl: WebGL2RenderingContext
  readonly #vertex: WebGLShader
  readonly #texture: WebGLTexture
  readonly #uniforms: WebGLBuffer
  readonly #vao: WebGLVertexArrayObject
  #shader: { program: WebGLProgram; hasUniforms: boolean } | undefined
  #hasSource = false
  #effectFence: WebGLSync | undefined
  #disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas
    this.#gl = requireResource(
      canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false }),
      'WebGL2 output context',
    )
    const gl = this.#gl
    this.#vertex = compileGlShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_GLSL)
    this.#texture = requireResource(gl.createTexture(), 'WebGL input texture')
    this.#uniforms = requireResource(gl.createBuffer(), 'WebGL uniform buffer')
    this.#vao = requireResource(gl.createVertexArray(), 'WebGL vertex array')
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.disable(gl.DITHER)
    gl.disable(gl.BLEND)
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.#uniforms)
    gl.bufferData(gl.UNIFORM_BUFFER, SHADER_UNIFORM_BYTE_LENGTH, gl.DYNAMIC_DRAW)
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.#uniforms)
    gl.bindBuffer(gl.UNIFORM_BUFFER, null)
  }

  async setShader(shader: CompiledShader, current: () => boolean): Promise<void> {
    if (this.#disposed) return
    const program = this.#program(shader.glsl ?? '')
    try {
      this.#configureSampler(program, shader.webgl?.channel0 ?? (shader.webgl ? null : 'iChannel0'))
      const block = shader.webgl?.uniformBlock ?? (shader.webgl ? null : 'GhosttyUniforms')
      if (block) this.#configureUniformBlock(program, block)
      if (!current()) return this.#gl.deleteProgram(program)
      this.#gl.deleteProgram(this.#shader?.program ?? null)
      this.#shader = { program, hasUniforms: block !== null }
    } catch (cause) {
      this.#gl.deleteProgram(program)
      throw cause
    }
  }

  resize(size: ShaderOutputSize): void {
    if (this.#disposed) return
    if (this.#canvas.width === size.width && this.#canvas.height === size.height) return
    this.#canvas.width = size.width
    this.#canvas.height = size.height
  }

  capture(source: HTMLCanvasElement): void {
    if (
      this.#disposed ||
      source.width === 0 ||
      source.height === 0 ||
      this.#canvas.width === 0 ||
      this.#canvas.height === 0
    )
      return
    const gl = this.#gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    this.#hasSource = true
  }

  draw(uniforms: ArrayBuffer): boolean {
    if (this.#disposed || !this.#hasSource) return false
    const gl = this.#gl
    const shader = this.#shader
    if (!shader) return false
    if (!this.#effectReady()) return false
    const program = shader.program
    gl.useProgram(program)
    gl.bindVertexArray(this.#vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    if (shader?.hasUniforms) this.#bindUniforms(uniforms)
    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    this.#effectFence = requireResource(
      gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0),
      'WebGL effect fence',
    )
    gl.flush()
    return true
  }

  ready(): boolean {
    if (this.#disposed) return false
    return this.#effectReady()
  }

  #effectReady(): boolean {
    const fence = this.#effectFence
    if (!fence) return true
    const status = this.#gl.clientWaitSync(fence, 0, 0)
    if (status === this.#gl.WAIT_FAILED)
      throw new ShaderAddonError('gpu', 'WebGL2 effect fence wait failed')
    if (status === this.#gl.TIMEOUT_EXPIRED) return false
    if (status !== this.#gl.ALREADY_SIGNALED && status !== this.#gl.CONDITION_SATISFIED)
      throw new ShaderAddonError('gpu', `Unexpected WebGL2 effect fence status: ${status}`)
    this.#gl.deleteSync(fence)
    this.#effectFence = undefined
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const gl = this.#gl
    if (this.#effectFence) {
      gl.deleteSync(this.#effectFence)
      this.#effectFence = undefined
    }
    gl.deleteProgram(this.#shader?.program ?? null)
    gl.deleteShader(this.#vertex)
    gl.deleteTexture(this.#texture)
    gl.deleteBuffer(this.#uniforms)
    gl.deleteVertexArray(this.#vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  #bindUniforms(uniforms: ArrayBuffer): void {
    const gl = this.#gl
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.#uniforms)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, uniforms)
  }

  #configureSampler(program: WebGLProgram, name: string | null): void {
    if (name === null) return
    const location = this.#gl.getUniformLocation(program, name)
    this.#gl.useProgram(program)
    this.#gl.uniform1i(location, 0)
  }

  #configureUniformBlock(program: WebGLProgram, name: string): void {
    const gl = this.#gl
    const block = gl.getUniformBlockIndex(program, name)
    if (block === gl.INVALID_INDEX)
      throw new ShaderAddonError('gpu', `WebGL uniform block ${name} was not linked`)
    gl.uniformBlockBinding(program, block, 0)
  }

  #program(source: string): WebGLProgram {
    const gl = this.#gl
    const fragment = compileGlShader(gl, gl.FRAGMENT_SHADER, source)
    const program = gl.createProgram()
    if (!program) {
      gl.deleteShader(fragment)
      throw new ShaderAddonError('gpu', 'Could not create WebGL program')
    }
    gl.attachShader(program, this.#vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(fragment)
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program
    const message = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new ShaderAddonError('gpu', `WebGL program linking failed: ${message}`)
  }
}
