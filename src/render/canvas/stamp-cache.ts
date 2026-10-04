import { createGhosttyError } from '../../core/error.js'
import type { GlyphBitmap } from '../atlas/types.js'

export interface StampStorage {
  readonly memory: WebAssembly.Memory
  allocate(bytes: number): number
  release(offset: number, bytes: number): void
}

export interface ResidentStamp {
  readonly offset: number
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly left: number
  readonly top: number
  readonly encoding: 'a8' | 'rgba'
  readonly generation: number
}

export class StampCache {
  readonly metrics = {
    hits: 0,
    misses: 0,
    rasterCalls: 0,
    rasterPayloadBytes: 0,
    stampCopies: 0,
    stampCopiedBytes: 0,
    evictions: 0,
    residentBytes: 0,
    residentEntries: 0,
  }
  private readonly entries = new Map<string, ResidentStamp | undefined>()
  private budget = 0
  private entryBudget = 0
  private generation = 0

  constructor(private readonly storage: StampStorage) {}

  resize(width: number, height: number): void {
    this.clear()
    this.budget = width * height * 4
    this.entryBudget = Math.max(1, Math.floor(this.budget / 64))
  }

  get(
    key: string,
    rasterize: () => GlyphBitmap | undefined,
    clip?: readonly [number, number, number, number],
  ): ResidentStamp | undefined {
    let entryKey = `full:${key}`
    if (this.entries.has(entryKey)) return this.hit(entryKey)
    const clippedKey = clip ? `clip:${JSON.stringify([key, clip])}` : undefined
    if (clippedKey && this.entries.has(clippedKey)) return this.hit(clippedKey)
    this.metrics.misses += 1
    this.metrics.rasterCalls += 1
    let bitmap = rasterize()
    const rawBytes = bitmap?.pixels.byteLength ?? 0
    this.metrics.rasterPayloadBytes += rawBytes
    if (bitmap) this.validate(bitmap)
    if (rawBytes > this.budget) {
      if (!clip)
        throw createGhosttyError('canvas.stamp', 'Canvas raster stamp exceeds the viewport extent')
      bitmap = this.crop(bitmap!, clip)
      entryKey = clippedKey!
    }
    const bytes = bitmap?.pixels.byteLength ?? 0
    this.reserve(bytes)
    const entry = bitmap ? this.store(bitmap) : undefined
    this.entries.set(entryKey, entry)
    this.metrics.residentBytes += bytes
    this.metrics.residentEntries = this.entries.size
    return entry
  }

  private hit(key: string): ResidentStamp | undefined {
    const entry = this.entries.get(key)
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.metrics.hits += 1
    return entry
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry) this.storage.release(entry.offset, entry.bytes)
    }
    this.entries.clear()
    this.generation += 1
    this.metrics.residentBytes = 0
    this.metrics.residentEntries = 0
  }

  dispose(): void {
    this.clear()
    this.budget = 0
    this.entryBudget = 0
  }

  private validate(bitmap: GlyphBitmap): void {
    const channels = bitmap.kind === 'grayscale' ? 1 : 4
    if (
      !Number.isSafeInteger(bitmap.width) ||
      !Number.isSafeInteger(bitmap.height) ||
      !Number.isSafeInteger(bitmap.offsetX) ||
      !Number.isSafeInteger(bitmap.offsetY) ||
      !Number.isSafeInteger(bitmap.offsetX + bitmap.width) ||
      !Number.isSafeInteger(bitmap.offsetY + bitmap.height) ||
      bitmap.width <= 0 ||
      bitmap.height <= 0 ||
      bitmap.pixels.byteLength !== bitmap.width * bitmap.height * channels
    )
      throw createGhosttyError('canvas.stamp', 'Canvas raster stamp has invalid dimensions')
  }

  private crop(
    bitmap: GlyphBitmap,
    clip: readonly [number, number, number, number],
  ): GlyphBitmap | undefined {
    if (
      !clip.every(Number.isSafeInteger) ||
      clip[2] < 0 ||
      clip[3] < 0 ||
      !Number.isSafeInteger(clip[0] + clip[2]) ||
      !Number.isSafeInteger(clip[1] + clip[3])
    )
      throw createGhosttyError('canvas.stamp', 'Canvas raster clip has invalid dimensions')
    const left = Math.max(bitmap.offsetX, clip[0])
    const top = Math.max(bitmap.offsetY, clip[1])
    const width = Math.min(bitmap.offsetX + bitmap.width, clip[0] + clip[2]) - left
    const height = Math.min(bitmap.offsetY + bitmap.height, clip[1] + clip[3]) - top
    if (width <= 0 || height <= 0) return undefined
    const channels = bitmap.kind === 'grayscale' ? 1 : 4
    const bytes = width * height * channels
    if (bytes > this.budget)
      throw createGhosttyError('canvas.stamp', 'Canvas raster stamp exceeds the viewport extent')
    const pixels = new Uint8Array(bytes)
    const stride = width * channels
    for (let row = 0; row < height; row += 1) {
      const start = ((top - bitmap.offsetY + row) * bitmap.width + left - bitmap.offsetX) * channels
      pixels.set(bitmap.pixels.subarray(start, start + stride), row * stride)
    }
    return { ...bitmap, offsetX: left, offsetY: top, width, height, pixels }
  }

  private store(bitmap: GlyphBitmap): ResidentStamp {
    const bytes = bitmap.pixels.byteLength
    const channels = bitmap.kind === 'grayscale' ? 1 : 4
    const offset = this.storage.allocate(bytes)
    try {
      const buffer = this.storage.memory.buffer
      if (!(buffer instanceof ArrayBuffer))
        throw createGhosttyError('canvas.stamp', 'Canvas pixels require ordinary WASM memory')
      new Uint8Array(buffer, offset, bytes).set(bitmap.pixels)
    } catch (cause) {
      this.storage.release(offset, bytes)
      throw cause
    }
    this.metrics.stampCopies += 1
    this.metrics.stampCopiedBytes += bytes
    return {
      offset,
      bytes,
      width: bitmap.width,
      height: bitmap.height,
      left: bitmap.offsetX,
      top: bitmap.offsetY,
      encoding: channels === 1 ? 'a8' : 'rgba',
      generation: this.generation,
    }
  }

  private reserve(bytes: number): void {
    while (
      this.entries.size &&
      (this.metrics.residentBytes + bytes > this.budget || this.entries.size >= this.entryBudget)
    ) {
      const [key, entry] = this.entries.entries().next().value!
      if (entry) this.storage.release(entry.offset, entry.bytes)
      this.entries.delete(key)
      this.metrics.residentBytes -= entry?.bytes ?? 0
      this.metrics.evictions += 1
    }
    this.metrics.residentEntries = this.entries.size
  }
}
