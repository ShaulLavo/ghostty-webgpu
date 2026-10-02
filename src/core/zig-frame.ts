import { assertGhosttyResult, createGhosttyError } from './error.js'
import type { GhosttyRuntime } from './runtime.js'
import type { RgbColor } from './types.js'
import type { AtlasGlyph } from '../render/atlas/types.js'
import type {
  CanonicalRendererTheme,
  CursorState,
  RowInstanceUpdate,
} from '../render/instances/types.js'

const frameBytes = 92
const glyphIndexBytes = 512 * 48

function packedColor(color: RgbColor): number {
  return color.r | (color.g << 8) | (color.b << 16)
}

export interface ZigFrameOptions {
  cellWidth: number
  cellHeight: number
  theme: CanonicalRendererTheme
  cursor?: CursorState
  full: boolean
  overlayRows: ReadonlySet<number>
}

// The bridge owns instance construction; views are recreated after calls that may grow memory.
export class ZigFrameBuilder {
  private readonly allocations: { pointer: number; length: number }[] = []
  private readonly frame: number
  private readonly cellPointer: number
  private readonly glyphPointer: number
  private readonly index: number
  private readonly ranges: number
  private readonly missing: number
  private readonly mask: number
  private readonly entry: number
  private disposed = false

  constructor(
    private readonly runtime: GhosttyRuntime,
    private readonly state: number,
    private readonly iterator: number,
    private readonly cells: number,
    readonly columns: number,
    readonly rows: number,
    private readonly ensureOwnerActive: () => void,
  ) {
    try {
      this.frame = this.allocate(frameBytes)
      this.cellPointer = this.allocate(columns * rows * 64)
      this.glyphPointer = this.allocate(columns * rows * 96)
      this.index = this.allocate(glyphIndexBytes)
      this.ranges = this.allocate(rows * 16)
      this.missing = this.allocate(512 * 4)
      this.mask = this.allocate(rows)
      this.entry = this.allocate(48)
      const values = [
        columns,
        rows,
        this.cellPointer,
        this.glyphPointer,
        this.index,
        this.ranges,
        rows,
        0,
        this.missing,
        512,
        0,
        0,
      ]
      for (const [offset, value] of values.entries()) this.setUint(offset * 4, value)
    } catch (cause) {
      this.dispose()
      throw cause
    }
  }

  get cellData(): Float32Array {
    this.ensureActive()
    return new Float32Array(
      this.runtime.memory.bytes.buffer,
      this.cellPointer,
      this.columns * this.rows * 16,
    )
  }

  get glyphData(): Float32Array {
    this.ensureActive()
    return new Float32Array(
      this.runtime.memory.bytes.buffer,
      this.glyphPointer,
      this.columns * this.rows * 24,
    )
  }

  get missingGlyphs(): readonly number[] {
    this.ensureActive()
    const count = this.runtime.memory.view.getUint32(this.frame + 40, true)
    return Array.from(new Uint32Array(this.runtime.memory.bytes.buffer, this.missing, count))
  }

  build(options: ZigFrameOptions): number {
    this.ensureActive()
    const { memory } = this.runtime
    memory.bytes.fill(0, this.mask, this.mask + this.rows)
    for (const row of options.overlayRows) {
      if (!Number.isInteger(row) || row < 0 || row >= this.rows) continue
      memory.bytes[this.mask + row] = 1
    }
    const view = memory.view
    view.setFloat32(this.frame + 48, options.cellWidth, true)
    view.setFloat32(this.frame + 52, options.cellHeight, true)
    view.setFloat32(this.frame + 56, options.theme.minimumContrast, true)
    const colors = [
      options.theme.foreground,
      options.theme.background,
      options.theme.cursor,
      options.theme.cursorText,
    ]
    for (const [index, color] of colors.entries()) this.setUint(60 + index * 4, packedColor(color))
    const cursor = options.cursor
    this.setUint(76, cursor?.x ?? 0)
    this.setUint(80, cursor?.y ?? 0)
    this.setUint(84, cursor?.visible ? 1 : 0)
    const styles = ['block', 'bar', 'underline', 'outline']
    this.setUint(88, cursor ? styles.indexOf(cursor.style) : 0)
    assertGhosttyResult(
      'bridge_build_frame',
      this.runtime.bridge.buildFrame(
        this.state,
        this.iterator,
        this.cells,
        options.full ? 0 : this.mask,
        this.rows,
        options.full ? 0 : 1,
        this.frame,
      ),
    )
    return this.runtime.memory.view.getUint32(this.frame + 44, true)
  }

  changedRanges(): readonly RowInstanceUpdate[] {
    this.ensureActive()
    const view = this.runtime.memory.view
    const count = view.getUint32(this.frame + 28, true)
    const result: RowInstanceUpdate[] = []
    for (let index = 0; index < count; index += 1) {
      const pointer = this.ranges + index * 16
      const byteOffset = view.getUint32(pointer, true)
      result.push({
        cell: { byteOffset, byteLength: view.getUint32(pointer + 4, true) },
        glyph: {
          byteOffset: view.getUint32(pointer + 8, true),
          byteLength: view.getUint32(pointer + 12, true),
        },
        row: Math.floor(byteOffset / (this.columns * 64)),
        invalidatedRows: [],
      })
    }
    return result
  }

  registerGlyph(key: number, glyph: AtlasGlyph | undefined): void {
    this.ensureActive()
    const data = new Float32Array(this.runtime.memory.bytes.buffer, this.entry, 12)
    data.fill(0)
    if (glyph)
      data.set([
        glyph.offsetX,
        glyph.offsetY,
        glyph.width,
        glyph.height,
        glyph.x / glyph.atlasWidth,
        glyph.y / glyph.atlasHeight,
        (glyph.x + glyph.width) / glyph.atlasWidth,
        (glyph.y + glyph.height) / glyph.atlasHeight,
        glyph.layer,
        glyph.generation,
        glyph.kind === 'color' ? 1 : 0,
        1,
      ])
    if (!glyph) data[11] = 1
    this.runtime.bridge.registerGlyph(this.index, key, this.entry)
  }

  clearGlyphs(): void {
    this.ensureActive()
    this.runtime.bridge.clearGlyphs(this.index)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const allocation of this.allocations)
      this.runtime.memory.free(allocation.pointer, allocation.length)
    this.allocations.length = 0
  }

  private ensureActive(): void {
    this.ensureOwnerActive()
    if (!this.disposed) return
    throw createGhosttyError('frame_builder', 'The frame builder has been disposed')
  }

  private allocate(length: number): number {
    const pointer = this.runtime.memory.allocate(length)
    this.allocations.push({ pointer, length })
    return pointer
  }

  private setUint(offset: number, value: number): void {
    this.runtime.memory.view.setUint32(this.frame + offset, value, true)
  }
}
