import type { AtlasKind, AtlasPageUpload, AtlasTextureLayout } from '../atlas/types.js'
import { CELL_INSTANCE_BYTES, GLYPH_INSTANCE_BYTES } from '../instances/layout.js'
import type { InstanceRows } from '../instances/rows.js'
import type { InstanceByteRange, RowInstanceUpdate } from '../instances/types.js'
import { coalesceInstanceUpdates } from '../instances/uploads.js'
import {
  cellFragmentShader,
  cellVertexShader,
  glyphFragmentShader,
  glyphVertexShader,
} from './shaders.js'

export interface WebGlTextPassOptions {
  readonly atlasLayout: AtlasTextureLayout
  readonly context: WebGL2RenderingContext
  readonly height: number
  readonly instanceCount: number
  readonly width: number
}

interface Pipeline {
  readonly buffer: WebGLBuffer
  readonly program: WebGLProgram
  readonly vertexArray: WebGLVertexArrayObject
}

function positiveInteger(name: string, value: number): void {
  if (Number.isSafeInteger(value) && value > 0) return
  throw new RangeError(`${name} must be a positive safe integer`)
}

function maximumInteger(context: WebGL2RenderingContext, parameter: number): number {
  const value: unknown = context.getParameter(parameter)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw new Error('WebGL did not provide a valid resource limit')
}

function validateOptions(options: WebGlTextPassOptions): void {
  positiveInteger('width', options.width)
  positiveInteger('height', options.height)
  positiveInteger('instanceCount', options.instanceCount)
  positiveInteger('atlas layerCount', options.atlasLayout.layerCount)
  positiveInteger('atlas pageWidth', options.atlasLayout.pageWidth)
  positiveInteger('atlas pageHeight', options.atlasLayout.pageHeight)
  const context = options.context
  const textureLimit = maximumInteger(context, context.MAX_TEXTURE_SIZE)
  const layerLimit = maximumInteger(context, context.MAX_ARRAY_TEXTURE_LAYERS)
  if (options.atlasLayout.layerCount > layerLimit)
    throw new RangeError('Atlas exceeds WebGL layers')
  if (Math.max(options.atlasLayout.pageWidth, options.atlasLayout.pageHeight) > textureLimit) {
    throw new RangeError('Atlas exceeds WebGL texture dimensions')
  }
}

function pixelBytes(kind: AtlasKind): number {
  return kind === 'grayscale' ? 1 : 4
}

export class WebGlTextPass {
  private readonly cleanup: (() => void)[] = []
  private readonly context: WebGL2RenderingContext
  private width: number
  private height: number
  private instanceCount: number
  private readonly atlasLayout: AtlasTextureLayout
  private readonly cells: Pipeline
  private readonly glyphs: Pipeline
  private readonly textures: Readonly<Record<AtlasKind, WebGLTexture>>
  private atlasUploadedBytesValue = 0
  private atlasUploadOperationsValue = 0
  private disposed = false

  constructor(options: WebGlTextPassOptions) {
    validateOptions(options)
    this.context = options.context
    this.width = options.width
    this.height = options.height
    this.instanceCount = options.instanceCount
    this.atlasLayout = { ...options.atlasLayout }
    try {
      this.cells = this.createPipeline(cellVertexShader, cellFragmentShader, CELL_INSTANCE_BYTES)
      this.glyphs = this.createPipeline(
        glyphVertexShader,
        glyphFragmentShader,
        GLYPH_INSTANCE_BYTES,
      )
      this.textures = {
        grayscale: this.createAtlasTexture('grayscale'),
        color: this.createAtlasTexture('color'),
      }
      this.configureSamplers()
      this.assertNoError('WebGL text pass initialization')
    } catch (cause) {
      this.destroy()
      throw cause
    }
  }

  get atlasUploadedBytes(): number {
    return this.atlasUploadedBytesValue
  }

  get atlasUploadOperations(): number {
    return this.atlasUploadOperationsValue
  }

  syncAtlas(uploads: readonly AtlasPageUpload[]): void {
    this.ensureActive()
    const gl = this.context
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    try {
      for (const upload of uploads) this.uploadAtlasPage(upload)
    } finally {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    }
  }

  upload(instances: InstanceRows, updates: readonly RowInstanceUpdate[]): number {
    this.ensureActive()
    let operations = 0
    for (const batch of coalesceInstanceUpdates(updates)) {
      this.writeRange(this.cells.buffer, instances.cellData, batch.cell)
      this.writeRange(this.glyphs.buffer, instances.glyphData, batch.glyph)
      operations += 2
    }
    return operations
  }

  resize(options: { width: number; height: number; instanceCount: number }): void {
    this.ensureActive()
    positiveInteger('width', options.width)
    positiveInteger('height', options.height)
    positiveInteger('instanceCount', options.instanceCount)
    this.width = options.width
    this.height = options.height
    this.instanceCount = options.instanceCount
    this.resizePipeline(this.cells, CELL_INSTANCE_BYTES)
    this.resizePipeline(this.glyphs, GLYPH_INSTANCE_BYTES)
  }

  submit(): void {
    this.ensureActive()
    const gl = this.context
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.DITHER)
    gl.colorMask(true, true, true, true)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.bindAtlas()
    this.draw(this.cells)
    this.draw(this.glyphs)
    gl.bindVertexArray(null)
  }

  capturePixels(): Uint8Array {
    // The browser can clear the default framebuffer after compositing; redraw only for capture.
    this.submit()
    const gl = this.context
    const pixels = new Uint8Array(this.width * this.height * 4)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4)
    const rowBytes = this.width * 4
    const flipped = new Uint8Array(pixels.length)
    for (let row = 0; row < this.height; row += 1) {
      const source = (this.height - row - 1) * rowBytes
      flipped.set(pixels.subarray(source, source + rowBytes), row * rowBytes)
    }
    return flipped
  }

  destroy(): void {
    if (this.disposed) return
    this.disposed = true
    this.context.useProgram(null)
    this.context.bindVertexArray(null)
    for (const release of this.cleanup.reverse()) release()
    this.cleanup.length = 0
  }

  private ensureActive(): void {
    if (!this.disposed) return
    throw new Error('WebGL text pass is disposed')
  }

  private own<T>(resource: T | null, release: (resource: T) => void): T {
    if (!resource) throw new Error('WebGL resource allocation failed')
    this.cleanup.push(() => release(resource))
    return resource
  }

  private createShader(type: number, source: string): WebGLShader {
    const gl = this.context
    const shader = this.own(gl.createShader(type), (resource) => gl.deleteShader(resource))
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    throw new Error(`WebGL shader compilation failed: ${gl.getShaderInfoLog(shader) ?? ''}`)
  }

  private createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.context
    const program = this.own(gl.createProgram(), (resource) => gl.deleteProgram(resource))
    gl.attachShader(program, this.createShader(gl.VERTEX_SHADER, vertexSource))
    gl.attachShader(program, this.createShader(gl.FRAGMENT_SHADER, fragmentSource))
    gl.linkProgram(program)
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program
    throw new Error(`WebGL program linking failed: ${gl.getProgramInfoLog(program) ?? ''}`)
  }

  private createPipeline(vertex: string, fragment: string, stride: number): Pipeline {
    const gl = this.context
    const program = this.createProgram(vertex, fragment)
    const buffer = this.own(gl.createBuffer(), (resource) => gl.deleteBuffer(resource))
    const vertexArray = this.own(gl.createVertexArray(), (resource) =>
      gl.deleteVertexArray(resource),
    )
    gl.bindVertexArray(vertexArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceCount * stride, gl.DYNAMIC_DRAW)
    for (let attribute = 0; attribute < stride / 16; attribute += 1) {
      gl.enableVertexAttribArray(attribute)
      gl.vertexAttribPointer(attribute, 4, gl.FLOAT, false, stride, attribute * 16)
      gl.vertexAttribDivisor(attribute, 1)
    }
    gl.bindVertexArray(null)
    gl.useProgram(program)
    gl.uniform2f(this.uniform(program, 'viewport'), this.width, this.height)
    return { buffer, program, vertexArray }
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation {
    const uniform = this.context.getUniformLocation(program, name)
    if (uniform) return uniform
    throw new Error(`WebGL uniform is missing: ${name}`)
  }

  private resizePipeline(pipeline: Pipeline, stride: number): void {
    const gl = this.context
    gl.bindBuffer(gl.ARRAY_BUFFER, pipeline.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceCount * stride, gl.DYNAMIC_DRAW)
    gl.useProgram(pipeline.program)
    gl.uniform2f(this.uniform(pipeline.program, 'viewport'), this.width, this.height)
  }

  private createAtlasTexture(kind: AtlasKind): WebGLTexture {
    const gl = this.context
    const texture = this.own(gl.createTexture(), (resource) => gl.deleteTexture(resource))
    const target = gl.TEXTURE_2D_ARRAY
    gl.bindTexture(target, texture)
    gl.texStorage3D(
      target,
      1,
      kind === 'grayscale' ? gl.R8 : gl.RGBA8,
      this.atlasLayout.pageWidth,
      this.atlasLayout.pageHeight,
      this.atlasLayout.layerCount,
    )
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }

  private configureSamplers(): void {
    const gl = this.context
    gl.useProgram(this.glyphs.program)
    gl.uniform1i(this.uniform(this.glyphs.program, 'grayscaleAtlas'), 0)
    gl.uniform1i(this.uniform(this.glyphs.program, 'colorAtlas'), 1)
  }

  private bindAtlas(): void {
    const gl = this.context
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures.grayscale)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures.color)
  }

  private uploadAtlasPage(upload: AtlasPageUpload): void {
    this.validateUpload(upload)
    const gl = this.context
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures[upload.kind])
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, upload.bytesPerRow / pixelBytes(upload.kind))
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      upload.origin.x,
      upload.origin.y,
      upload.layer,
      upload.extent.width,
      upload.extent.height,
      1,
      upload.kind === 'grayscale' ? gl.RED : gl.RGBA,
      gl.UNSIGNED_BYTE,
      upload.pixels,
      upload.dataOffset,
    )
    this.atlasUploadedBytesValue +=
      upload.extent.width * upload.extent.height * pixelBytes(upload.kind)
    this.atlasUploadOperationsValue += 1
  }

  private validateUpload(upload: AtlasPageUpload): void {
    if (upload.layer < 0 || upload.layer >= this.atlasLayout.layerCount) {
      throw new RangeError('Atlas upload layer is outside texture-array capacity')
    }
    const right = upload.origin.x + upload.extent.width
    const bottom = upload.origin.y + upload.extent.height
    if (right <= this.atlasLayout.pageWidth && bottom <= this.atlasLayout.pageHeight) return
    throw new RangeError('Atlas upload extent is outside the target layer')
  }

  private writeRange(buffer: WebGLBuffer, data: Float32Array, range: InstanceByteRange): void {
    const gl = this.context
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      range.byteOffset,
      data,
      range.byteOffset / 4,
      range.byteLength / 4,
    )
  }

  private draw(pipeline: Pipeline): void {
    const gl = this.context
    gl.useProgram(pipeline.program)
    gl.bindVertexArray(pipeline.vertexArray)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount)
  }

  private assertNoError(operation: string): void {
    const code = this.context.getError()
    if (code === this.context.NO_ERROR) return
    throw new Error(`${operation} failed with WebGL error ${code}`)
  }
}
