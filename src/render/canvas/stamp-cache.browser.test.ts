import { describe, expect, it, vi } from 'vitest'
import {
  StampCache,
  type ResidentStamp,
  type StampIdentity,
} from './tests/reference-stamp-cache.js'
import { StampStorageFixture } from './tests/stamp-storage.js'

function identity(overrides: Partial<StampIdentity> = {}): StampIdentity {
  return {
    fontIdentity: 'loaded-font-fixture-epoch-1',
    browserIdentity: navigator.userAgent,
    font: '20px monospace',
    geometry: [64, 32, 10, 20, 1],
    span: 2,
    brush: '#ff0000',
    alpha: 1,
    shape: ['glyph', 'Ag', 1.5, 24],
    ...overrides,
  }
}

function raster(request: StampIdentity) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 32
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: false })!
  context.font = request.font
  context.fillStyle = request.brush
  context.globalAlpha = request.alpha
  context.fillText(String(request.shape[1]), Number(request.shape[2]), Number(request.shape[3]))
  return {
    left: 0,
    top: 0,
    image: context.getImageData(0, 0, 64, 32),
    rgb: [255, 0, 0] as const,
  }
}

function residentBytes(storage: StampStorageFixture, entry: ResidentStamp): Uint8Array {
  return new Uint8Array(storage.memory.buffer, entry.offset, entry.bytes)
}

function rgba(storage: StampStorageFixture, entry: ResidentStamp): number[] {
  const bytes = residentBytes(storage, entry)
  if (entry.encoding === 'rgba') return [...bytes]
  return [...bytes].flatMap((alpha) => (alpha ? [...entry.rgb, alpha] : [0, 0, 0, 0]))
}

describe('Canvas resident stamp cache', () => {
  it('does zero raster/readback/stamp-copy work for a repeated warm request', () => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(64, 32)
    const request = identity()
    const draw = vi.fn(() => raster(request))
    const cold = cache.get(request, draw)
    const before = { ...cache.metrics }
    expect(cache.get(identity(), draw)).toBe(cold)
    expect(draw).toHaveBeenCalledOnce()
    expect(cache.metrics.rasterCalls - before.rasterCalls).toBe(0)
    expect(cache.metrics.readbackBytes - before.readbackBytes).toBe(0)
    expect(cache.metrics.stampCopies - before.stampCopies).toBe(0)
    expect(cache.metrics.hits - before.hits).toBe(1)
    console.info(
      JSON.stringify({ proof: 'warm stamp cache work', cold: before, after: cache.metrics }),
    )
    cache.dispose()
  })

  it('qualifies actual requested-brush A8 bytes and preserves intrinsic RGBA exactly', () => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(64, 32)
    for (const request of [
      identity(),
      identity({ shape: ['glyph', '👩‍💻', 1.5, 24] }),
      identity({ alpha: 0.5 }),
    ]) {
      const source = raster(request)
      const entry = cache.get(request, () => source)
      expect(rgba(storage, entry)).toEqual([...source.image.data])
    }
    expect(cache.metrics.rgbaEntries).toBeGreaterThan(0)
    cache.dispose()
  })

  it('keys brush, alpha, font, span, phase, geometry, browser and font lifetime', () => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(64, 320)
    const source = raster(identity())
    const requests = [
      identity(),
      identity({ brush: '#ffffff' }),
      identity({ alpha: 0.5 }),
      identity({ font: 'italic 20px monospace' }),
      identity({ span: 3 }),
      identity({ shape: ['glyph', 'Ag', 1, 24] }),
      identity({ geometry: [64, 32, 11, 20, 2] }),
      identity({ browserIdentity: 'different-raster-owner' }),
      identity({ fontIdentity: 'loaded-font-fixture-epoch-2' }),
    ]
    const offsets = new Set(requests.map((request) => cache.get(request, () => source).offset))
    expect(offsets.size).toBe(requests.length)
    expect(cache.metrics.misses).toBe(requests.length)
    cache.dispose()
  })

  it('retains only offsets across ordinary memory growth and invalidates on clear/dispose', () => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(64, 32)
    const request = identity()
    const source = raster(request)
    const initial = cache.get(request, () => source)
    const old = residentBytes(storage, initial)
    const before = { ...cache.metrics }
    storage.memory.grow(1)
    expect(old.byteLength).toBe(0)
    expect(cache.get(request, () => source)).toBe(initial)
    expect(rgba(storage, initial)).toEqual([...source.image.data])
    expect(cache.metrics.stampCopies).toBe(before.stampCopies)
    cache.clear()
    const next = cache.get(request, () => source)
    expect(next.generation).toBeGreaterThan(initial.generation)
    cache.dispose()
    expect(cache.metrics.residentBytes).toBe(0)
    expect(cache.metrics.residentEntries).toBe(0)
    expect(storage.released.length).toBeGreaterThan(0)
  })

  it('bounds residency by viewport extent and evicts the least-recently used stamp', () => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(1, 1)
    const draw = () => ({
      left: 0,
      top: 0,
      rgb: [1, 2, 3] as const,
      image: new ImageData(new Uint8ClampedArray([4, 5, 6, 255]), 1, 1),
    })
    cache.get(identity({ shape: ['first'] }), draw)
    cache.get(identity({ shape: ['second'] }), draw)
    expect(cache.metrics.residentBytes).toBe(4)
    expect(cache.metrics.residentEntries).toBe(1)
    expect(cache.metrics.evictions).toBe(1)
    cache.dispose()
  })

  it('does not commit a failed raster or stamp copy and permits a clean retry', () => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(64, 32)
    const request = identity()
    expect(() =>
      cache.get(request, () => {
        throw new TypeError('Injected raster failure')
      }),
    ).toThrow('Injected raster failure')
    const allocate = vi.spyOn(storage, 'allocate')
    allocate.mockReturnValueOnce(storage.memory.buffer.byteLength + 1)
    expect(() => cache.get(request, () => raster(request))).toThrow()
    expect(cache.metrics.residentEntries).toBe(0)
    expect(cache.metrics.stampCopies).toBe(0)
    expect(storage.released).toHaveLength(1)
    allocate.mockRestore()
    storage.released.splice(0)
    const entry = cache.get(request, () => raster(request))
    expect(entry.bytes).toBeGreaterThan(0)
    expect(cache.metrics.residentEntries).toBe(1)
    cache.dispose()
  })
})
