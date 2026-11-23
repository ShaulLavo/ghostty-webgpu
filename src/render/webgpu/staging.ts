import type { InstanceByteRange } from '../shared/instances/types.js'

/** Frames whose planned instance bytes reach this size upload through mapped staging buffers. */
export const STAGING_MIN_BYTES = 128 * 1024
const POOL_LIMIT = 2

interface StagedCopy {
  readonly destination: GPUBuffer
  readonly sourceOffset: number
  readonly destinationOffset: number
  readonly size: number
}

interface StagedFrame {
  readonly buffer: GPUBuffer
  readonly copies: readonly StagedCopy[]
}

export interface StagingTarget {
  readonly buffer: GPUBuffer
  readonly data: Float32Array
  readonly ranges: readonly InstanceByteRange[]
  /** Byte offset of this target's mirror inside a staging buffer. */
  readonly mirrorOffset: number
}

/**
 * Chrome's `queue.writeBuffer` moves large payloads through the command stream at several
 * times the CPU cost of a mapped buffer, so dense frames write into a small pool of
 * MAP_WRITE buffers and copy from them at the start of the frame's own command buffer.
 */
export class StagingUploads {
  private readonly ready: GPUBuffer[] = []
  private readonly owned = new Set<GPUBuffer>()
  private pending: StagedFrame[] = []
  private encoded: GPUBuffer[] = []

  constructor(
    private readonly device: GPUDevice,
    private readonly size: number,
  ) {}

  /**
   * Call before planning a frame's uploads. The owner flushes its coordinated frame first, so
   * every encoded copy has been submitted or abandoned and its buffer can map again.
   */
  beginFrame(): void {
    if (this.pending.length !== 0) {
      // A copy that missed its frame must still land before a later writeBuffer to those bytes.
      const encoder = this.device.createCommandEncoder()
      this.record(encoder)
      this.device.queue.submit([encoder.finish()])
      this.settleRecorded()
    }
    for (const buffer of this.encoded) this.remap(buffer)
    this.encoded = []
  }

  /** Writes the ranges into a mapped buffer; returns false when no buffer is ready. */
  stage(targets: readonly StagingTarget[]): boolean {
    const buffer = this.acquire()
    if (!buffer) return false
    const mapped = buffer.getMappedRange()
    const copies: StagedCopy[] = []
    for (const target of targets) {
      for (const range of target.ranges) {
        if (range.byteLength === 0) continue
        const sourceOffset = target.mirrorOffset + range.byteOffset
        const length = range.byteLength / 4
        const source = new Float32Array(
          target.data.buffer,
          target.data.byteOffset + range.byteOffset,
          length,
        )
        new Float32Array(mapped, sourceOffset, length).set(source)
        copies.push({
          destination: target.buffer,
          destinationOffset: range.byteOffset,
          size: range.byteLength,
          sourceOffset,
        })
      }
    }
    buffer.unmap()
    this.pending.push({ buffer, copies })
    return true
  }

  /** Records staged copies ahead of the frame's draws. */
  record(encoder: GPUCommandEncoder): void {
    for (const frame of this.pending) {
      for (const copy of frame.copies) {
        encoder.copyBufferToBuffer(
          frame.buffer,
          copy.sourceOffset,
          copy.destination,
          copy.destinationOffset,
          copy.size,
        )
      }
    }
  }

  /** The encoder that recorded the pending copies finished without error. */
  settleRecorded(): void {
    for (const frame of this.pending) this.encoded.push(frame.buffer)
    this.pending = []
  }

  destroy(): void {
    for (const buffer of this.owned) buffer.destroy()
    this.owned.clear()
    this.ready.length = 0
    this.pending = []
    this.encoded = []
  }

  private acquire(): GPUBuffer | undefined {
    const ready = this.ready.pop()
    if (ready) return ready
    if (this.owned.size >= POOL_LIMIT) return undefined
    const buffer = this.device.createBuffer({
      mappedAtCreation: true,
      size: this.size,
      usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
    })
    this.owned.add(buffer)
    return buffer
  }

  private remap(buffer: GPUBuffer): void {
    buffer.mapAsync(GPUMapMode.WRITE).then(
      () => {
        if (this.owned.has(buffer)) this.ready.push(buffer)
      },
      () => {
        // Destroyed or lost; the pool creates a replacement when it needs one.
        if (this.owned.delete(buffer)) buffer.destroy()
      },
    )
  }
}
