import type { TerminalFittedFont } from '../../../term/types.js'
import { copyFittedFont } from '../config.js'
import { fontResources, resourceIdentity } from '../font-identity.js'
import { CanvasGlyphRasterizer } from './canvas-rasterizer.js'

interface SharedEntry<T> {
  readonly value: T
  owners: number
}

/** Reference-counted values keyed by string, dropped when their last owner releases them. */
export class SharedPool<T extends object> {
  private readonly entries = new Map<string, SharedEntry<T>>()
  private readonly keys = new WeakMap<T, string>()

  get size(): number {
    return this.entries.size
  }

  acquire(key: string, create: () => T): T {
    const existing = this.entries.get(key)
    if (existing) {
      existing.owners += 1
      return existing.value
    }
    const value = create()
    this.entries.set(key, { value, owners: 1 })
    this.keys.set(value, key)
    return value
  }

  release(value: T): void {
    const key = this.keys.get(value)
    if (key === undefined) return
    const entry = this.entries.get(key)
    if (!entry || entry.value !== value) return
    entry.owners -= 1
    if (entry.owners > 0) return
    this.entries.delete(key)
    this.keys.delete(value)
  }
}

// WebGL contexts cannot share textures, but terminals in one realm can share rasterized bitmaps.
const rasterizers = new SharedPool<CanvasGlyphRasterizer>()

/** Shares bitmaps only between terminals that draw the same fitted font with the same loaded faces. */
export function acquireGlyphRasterizer(
  font: TerminalFittedFont,
  canvas: HTMLCanvasElement | OffscreenCanvas,
): CanvasGlyphRasterizer {
  const copy = copyFittedFont(font)
  const resources = fontResources(canvas)
  const faces = resources ? resourceIdentity(resources) : ''
  const key = JSON.stringify(copy) + '\u0000' + faces
  return rasterizers.acquire(key, () => new CanvasGlyphRasterizer({ font: copy }))
}

export function releaseGlyphRasterizer(rasterizer: CanvasGlyphRasterizer): void {
  rasterizers.release(rasterizer)
}
