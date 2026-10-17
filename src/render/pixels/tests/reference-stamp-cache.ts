import { createGhosttyError } from '../../../core/error.js'

export interface StampIdentity {
  readonly fontIdentity: string
  readonly browserIdentity: string
  readonly font: string
  readonly geometry: readonly number[]
  readonly span: number
  readonly brush: string
  readonly alpha: number
  readonly shape: readonly (string | number)[]
}

export interface RasterStamp {
  readonly left: number
  readonly top: number
  readonly image: ImageData
  readonly rgb: readonly [number, number, number]
}

export interface ResidentStamp {
  readonly offset: number
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly left: number
  readonly top: number
  readonly rgb: readonly [number, number, number]
  readonly encoding: 'a8' | 'rgba'
  readonly generation: number
}

export interface StampStorage {
  readonly memory: WebAssembly.Memory
  allocate(bytes: number): number
  release(offset: number, bytes: number): void
}

export class StampCache {
  readonly metrics = {
    hits: 0,
    misses: 0,
    rasterCalls: 0,
    readbackBytes: 0,
    scannedPixels: 0,
    stampCopies: 0,
    stampCopiedBytes: 0,
    a8Entries: 0,
    rgbaEntries: 0,
    evictions: 0,
    residentBytes: 0,
    residentEntries: 0,
  }
  private readonly entries = new Map<string, ResidentStamp>()
  private budget = 0
  private generation = 0

  constructor(private readonly storage: StampStorage) {}

  resize(width: number, height: number): void {
    this.clear()
    this.budget = width * height * 4
  }

  get(identity: StampIdentity, rasterize: () => RasterStamp): ResidentStamp {
    const key = JSON.stringify(identity)
    const old = this.entries.get(key)
    if (old) {
      this.entries.delete(key)
      this.entries.set(key, old)
      this.metrics.hits += 1
      return old
    }
    this.metrics.misses += 1
    const raster = rasterize()
    this.metrics.rasterCalls += 1
    this.metrics.readbackBytes += raster.image.data.byteLength
    const payload = this.encode(raster)
    if (payload.data.byteLength > this.budget)
      throw createGhosttyError('canvas.stamp', 'Canvas raster stamp exceeds the viewport extent')
    this.reserve(payload.data.byteLength)
    const offset = this.storage.allocate(payload.data.byteLength)
    try {
      const buffer = this.storage.memory.buffer
      if (!(buffer instanceof ArrayBuffer))
        throw createGhosttyError('canvas.stamp', 'Canvas pixel memory must be ordinary memory')
      new Uint8Array(buffer, offset, payload.data.byteLength).set(payload.data)
    } catch (cause) {
      this.storage.release(offset, payload.data.byteLength)
      throw cause
    }
    this.metrics.stampCopies += 1
    this.metrics.stampCopiedBytes += payload.data.byteLength
    const entry: ResidentStamp = {
      offset,
      bytes: payload.data.byteLength,
      width: raster.image.width,
      height: raster.image.height,
      left: raster.left,
      top: raster.top,
      rgb: raster.rgb,
      encoding: payload.encoding,
      generation: this.generation,
    }
    this.entries.set(key, entry)
    this.metrics.residentBytes += entry.bytes
    this.metrics.residentEntries = this.entries.size
    if (entry.encoding === 'a8') this.metrics.a8Entries += 1
    if (entry.encoding === 'rgba') this.metrics.rgbaEntries += 1
    return entry
  }

  clear(): void {
    for (const entry of this.entries.values()) this.storage.release(entry.offset, entry.bytes)
    this.entries.clear()
    this.generation += 1
    this.metrics.residentBytes = 0
    this.metrics.residentEntries = 0
  }

  dispose(): void {
    this.clear()
    this.budget = 0
  }

  private reserve(bytes: number): void {
    while (this.metrics.residentBytes + bytes > this.budget) {
      const first = this.entries.entries().next().value!
      this.storage.release(first[1].offset, first[1].bytes)
      this.entries.delete(first[0])
      this.metrics.residentBytes -= first[1].bytes
      this.metrics.evictions += 1
    }
    this.metrics.residentEntries = this.entries.size
  }

  private encode(raster: RasterStamp): { encoding: 'a8' | 'rgba'; data: Uint8Array } {
    const rgba = raster.image.data
    let monochrome = true
    for (let index = 0; index < rgba.length; index += 4) {
      this.metrics.scannedPixels += 1
      const alpha = rgba[index + 3]!
      const rgb = alpha === 0 ? [0, 0, 0] : raster.rgb
      if (rgba[index] !== rgb[0] || rgba[index + 1] !== rgb[1] || rgba[index + 2] !== rgb[2])
        monochrome = false
    }
    if (!monochrome)
      return {
        encoding: 'rgba',
        data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      }
    const coverage = new Uint8Array(rgba.length / 4)
    for (let index = 0; index < coverage.length; index++) coverage[index] = rgba[index * 4 + 3]!
    return { encoding: 'a8', data: coverage }
  }
}
