import { createGhosttyError } from '../../core/error.js'
import type { Canvas2dContext } from './painter.js'

export interface FrameOutput {
  readonly offset: number
  readonly width: number
  readonly height: number
  readonly generation: number
}

interface FrameView extends FrameOutput {
  readonly buffer: ArrayBuffer
  readonly image: ImageData
}

export class PixelFrame {
  readonly metrics = {
    handoffGets: 0,
    handoffReuses: 0,
    imageAllocations: 0,
    bufferChanges: 0,
    offsetChanges: 0,
    shapeChanges: 0,
    generationChanges: 0,
    uploadedRegions: 0,
    uploadedPixelBytes: 0,
    copiedFrameBytes: 0,
  }
  private readonly dirty = new Set<number>()
  private view?: FrameView
  private rowHeight = 0
  private output?: FrameOutput

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly context: Canvas2dContext,
  ) {}

  bind(output: FrameOutput, rowHeight: number): void {
    this.validate(output)
    if (!Number.isSafeInteger(rowHeight) || rowHeight <= 0 || output.height % rowHeight !== 0)
      throw createGhosttyError('canvas.frame', 'Canvas pixel rows require integer device geometry')
    const old = this.output
    const oldRowHeight = this.rowHeight
    this.output = { ...output }
    this.rowHeight = rowHeight
    if (old && this.sameOutput(old, output) && oldRowHeight === rowHeight) return
    this.dirty.clear()
    for (let y = 0; y < output.height / rowHeight; y++) this.dirty.add(y)
  }

  markRow(y: number): void {
    const output = this.requireOutput()
    if (!Number.isSafeInteger(y) || y < 0 || y >= output.height / this.rowHeight)
      throw createGhosttyError('canvas.frame', 'Canvas dirty row exceeds the framebuffer')
    this.dirty.add(y)
  }

  markTransportedRows(offset: number): void {
    const output = this.requireOutput()
    if (!Number.isSafeInteger(offset))
      throw createGhosttyError('canvas.frame', 'Canvas row transport requires an integer offset')
    const first = Math.max(0, offset)
    const last = output.height / this.rowHeight + Math.min(0, offset)
    for (let y = first; y < last; y++) this.dirty.add(y)
  }

  present(): void {
    if (this.dirty.size === 0) return
    const image = this.getImage()
    const rows = [...this.dirty].sort((left, right) => left - right)
    let first = rows[0]!
    let last = first
    for (const row of rows.slice(1)) {
      if (row === last + 1) {
        last = row
        continue
      }
      this.presentRows(image, first, last)
      first = row
      last = row
    }
    this.presentRows(image, first, last)
    this.dirty.clear()
  }

  invalidate(): void {
    this.view = undefined
    const output = this.output
    if (!output) return
    for (let y = 0; y < output.height / this.rowHeight; y++) this.dirty.add(y)
  }

  dispose(): void {
    this.dirty.clear()
    this.output = undefined
    this.view = undefined
  }

  getImage(): ImageData {
    const output = this.requireOutput()
    const buffer = this.validate(output)
    this.metrics.handoffGets += 1
    const old = this.view
    if (old && old.buffer === buffer && this.sameOutput(old, output)) {
      this.metrics.handoffReuses += 1
      return old.image
    }
    if (old) {
      this.metrics.bufferChanges += Number(old.buffer !== buffer)
      this.metrics.offsetChanges += Number(old.offset !== output.offset)
      this.metrics.shapeChanges += Number(
        old.width !== output.width || old.height !== output.height,
      )
      this.metrics.generationChanges += Number(old.generation !== output.generation)
    }
    const image = new ImageData(
      new Uint8ClampedArray(buffer, output.offset, output.width * output.height * 4),
      output.width,
      output.height,
    )
    this.metrics.imageAllocations += 1
    this.view = { ...output, buffer, image }
    return image
  }

  private presentRows(image: ImageData, first: number, last: number): void {
    if (image.data.buffer !== this.memory.buffer)
      throw createGhosttyError('canvas.frame', 'Canvas pixel memory changed during presentation')
    const top = first * this.rowHeight
    const height = (last - first + 1) * this.rowHeight
    this.context.putImageData(image, 0, 0, 0, top, image.width, height)
    this.metrics.uploadedRegions += 1
    this.metrics.uploadedPixelBytes += image.width * height * 4
  }

  private sameOutput(left: FrameOutput, right: FrameOutput): boolean {
    return (
      left.offset === right.offset &&
      left.width === right.width &&
      left.height === right.height &&
      left.generation === right.generation
    )
  }

  private validate(output: FrameOutput): ArrayBuffer {
    const buffer = this.memory.buffer
    const length = output.width * output.height * 4
    if (!(buffer instanceof ArrayBuffer))
      throw createGhosttyError('canvas.frame', 'Canvas pixels require ordinary WASM memory')
    if (!Number.isSafeInteger(output.offset) || output.offset < 0)
      throw createGhosttyError(
        'canvas.frame',
        'Canvas framebuffer requires a nonnegative integer offset',
      )
    if (
      !Number.isSafeInteger(output.width) ||
      !Number.isSafeInteger(output.height) ||
      output.width <= 0 ||
      output.height <= 0
    )
      throw createGhosttyError(
        'canvas.frame',
        'Canvas framebuffer requires positive integer dimensions',
      )
    if (!Number.isSafeInteger(output.generation) || output.generation < 0)
      throw createGhosttyError(
        'canvas.frame',
        'Canvas framebuffer requires a valid memory generation',
      )
    if (!Number.isSafeInteger(length) || output.offset > buffer.byteLength - length)
      throw createGhosttyError('canvas.frame', 'Canvas framebuffer exceeds current memory')
    return buffer
  }

  private requireOutput(): FrameOutput {
    if (this.output) return this.output
    throw createGhosttyError('canvas.frame', 'Canvas framebuffer is unavailable')
  }
}
