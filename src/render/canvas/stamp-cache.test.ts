import { describe, expect, it, vi } from 'vitest'
import { StampCache } from './stamp-cache.js'
import { StampStorageFixture } from './tests/stamp-storage.js'
import type { GlyphBitmap } from '../atlas/types.js'

function bitmap(kind: 'color' | 'grayscale' = 'grayscale'): GlyphBitmap {
  return {
    width: 2,
    height: 2,
    kind,
    offsetX: -1,
    offsetY: 3,
    pixels: Uint8Array.from(
      kind === 'grayscale'
        ? [0, 64, 128, 255]
        : [255, 3, 21, 128, 11, 39, 220, 255, 91, 0, 30, 1, 0, 0, 0, 0],
    ),
  }
}

describe('resident GPU-model stamps', () => {
  it.each(['color', 'grayscale'] as const)(
    'retains model-classified %s bytes verbatim, and warm hits do zero source work',
    (kind) => {
      const storage = new StampStorageFixture()
      const cache = new StampCache(storage)
      cache.resize(10, 10)
      const source = bitmap(kind)
      const raster = vi.fn(() => source)
      const stamp = cache.get('owner', raster)!
      expect(new Uint8Array(storage.memory.buffer, stamp.offset, stamp.bytes)).toEqual(
        source.pixels,
      )
      expect(stamp.encoding).toBe(kind === 'color' ? 'rgba' : 'a8')
      const before = { ...cache.metrics }
      const next = cache.get('owner', raster)
      expect(next).toBe(stamp)
      expect(raster).toHaveBeenCalledTimes(1)
      expect(cache.metrics).toEqual({ ...before, hits: before.hits + 1 })
      cache.dispose()
    },
  )

  it('retains offsets across growth and bounds payload and empty-entry residency', () => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(2, 2)
    const first = cache.get('first', () => bitmap())!
    storage.memory.grow(1)
    expect(cache.get('first', () => bitmap())).toBe(first)
    expect([...new Uint8Array(storage.memory.buffer, first.offset, first.bytes)]).toEqual([
      0, 64, 128, 255,
    ])
    for (let i = 0; i < 50; i++) cache.get(`${i}`, () => undefined)
    expect(cache.metrics.residentEntries).toBe(1)
    expect(cache.metrics.residentBytes).toBe(0)
    cache.clear()
    expect(cache.metrics.residentEntries).toBe(0)
  })

  it('keeps failed misses retryable and rejects malformed model bytes', () => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(8, 8)
    expect(() => cache.get('bad', () => ({ ...bitmap(), pixels: new Uint8Array(3) }))).toThrow()
    expect(cache.metrics.residentEntries).toBe(0)
    expect(cache.get('bad', () => bitmap())).toBeDefined()
    const failure = new TypeError('external raster failure')
    expect(() =>
      cache.get('failed', () => {
        throw failure
      }),
    ).toThrow(failure)
    expect(cache.get('failed', () => bitmap())).toBeDefined()
    cache.dispose()
  })
})

it.each(['color', 'grayscale'] as const)(
  'crops oversized %s residency by visibility while preserving original bearings and cache identity',
  (kind) => {
    const storage = new StampStorageFixture()
    const cache = new StampCache(storage)
    cache.resize(2, 2)
    const channels = kind === 'color' ? 4 : 1
    const width = kind === 'color' ? 5 : 20
    const source: GlyphBitmap = {
      width,
      height: 3,
      offsetX: -2,
      offsetY: -1,
      kind,
      pixels: Uint8Array.from({ length: width * 3 * channels }, (_, i) => (i * 29) % 256),
    }
    const raster = vi.fn(() => source)
    const cropped = cache.get('glyph', raster, [-1, 0, 2, 2])!
    expect([cropped.left, cropped.top, cropped.width, cropped.height]).toEqual([-1, 0, 2, 2])
    const expected = new Uint8Array(4 * channels)
    expected.set(source.pixels.subarray((width + 1) * channels, (width + 3) * channels))
    expected.set(
      source.pixels.subarray((2 * width + 1) * channels, (2 * width + 3) * channels),
      2 * channels,
    )
    expect(new Uint8Array(storage.memory.buffer, cropped.offset, cropped.bytes)).toEqual(expected)
    expect(cache.metrics.residentBytes).toBeLessThanOrEqual(16)
    expect(cache.get('glyph', raster, [-1, 0, 2, 2])).toBe(cropped)
    expect(raster).toHaveBeenCalledTimes(1)
    const moved = cache.get('glyph', raster, [0, -1, 2, 2])!
    expect([moved.left, moved.top, moved.width, moved.height]).toEqual([0, -1, 2, 2])
    expect(new Uint8Array(storage.memory.buffer, moved.offset, 2 * channels)).toEqual(
      source.pixels.subarray(2 * channels, 4 * channels),
    )
    expect(raster).toHaveBeenCalledTimes(2)
    expect(cache.metrics.residentBytes).toBeLessThanOrEqual(16)
    cache.resize(20, 20)
    const restored = cache.get('glyph', raster, [-1, 0, 2, 2])!
    expect([restored.left, restored.top, restored.width, restored.height]).toEqual([
      -2,
      -1,
      width,
      3,
    ])
    expect(new Uint8Array(storage.memory.buffer, restored.offset, restored.bytes)).toEqual(
      source.pixels,
    )
    cache.dispose()
    expect(cache.metrics.residentBytes).toBe(0)
  },
)

it('keeps allocation and malformed-source guards separate from empty viewport visibility', () => {
  const cache = new StampCache(new StampStorageFixture())
  cache.resize(1, 1)
  const source = { ...bitmap('color'), width: 3, pixels: new Uint8Array(24) }
  expect(() => cache.get('unbounded', () => source)).toThrow('viewport extent')
  expect(() =>
    cache.get('malformed', () => ({ ...source, pixels: new Uint8Array(25) }), [0, 0, 1, 1]),
  ).toThrow('invalid dimensions')
  expect(() => cache.get('oversized clip', () => source, [-1, 3, 3, 2])).toThrow('viewport extent')
  const raster = vi.fn(() => source)
  expect(cache.get('outside', raster, [20, 20, 1, 1])).toBeUndefined()
  expect(cache.get('outside', raster, [20, 20, 1, 1])).toBeUndefined()
  expect(raster).toHaveBeenCalledTimes(1)
  expect(cache.metrics.residentBytes).toBe(0)
  cache.dispose()
})
