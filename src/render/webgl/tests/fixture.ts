import { RenderStateDirty } from '../../../core/abi.js'
import type {
  CellStyle,
  ReadRowsOptions,
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
  RgbColor,
} from '../../../core/types.js'
import type { TerminalFittedFont } from '../../../term/types.js'
import type { RenderStateSource } from '../../renderer.js'
import type { RenderSchedulerClock } from '../../scheduler.js'

export class TestClock implements RenderSchedulerClock {
  private nextHandle = 1
  readonly frames = new Map<number, () => void>()
  readonly timers = new Map<number, () => void>()

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }

  requestFrame(callback: () => void): number {
    const handle = this.nextHandle++
    this.frames.set(handle, callback)
    return handle
  }

  setTimer(callback: () => void): number {
    const handle = this.nextHandle++
    this.timers.set(handle, callback)
    return handle
  }

  flushFrame(): void {
    const entry = this.frames.entries().next().value
    if (!entry) throw new Error('No pending frame')
    this.frames.delete(entry[0])
    entry[1]()
  }
}

export class TestRenderState implements RenderStateSource {
  acknowledgements = 0
  cursor: RenderCursorSnapshot = {
    blinking: false,
    passwordInput: false,
    style: 'block',
    visible: false,
  }
  private damage = RenderStateDirty.Full

  constructor(readonly rows: RenderRow[]) {}

  acknowledge(): number {
    const count = this.rows.filter((row) => row.dirty).length
    for (const row of this.rows) row.dirty = false
    this.damage = RenderStateDirty.False
    this.acknowledgements += 1
    return count
  }

  readCursor(): RenderCursorSnapshot {
    return this.cursor
  }

  readRows(options: ReadRowsOptions = {}): readonly RenderRow[] {
    return this.rows.filter(
      (row) => (!options.dirtyOnly || row.dirty) && (!options.rows || options.rows.has(row.y)),
    )
  }

  update(): RenderStateDirty {
    return this.damage
  }

  replaceRow(y: number, cells: readonly RenderCell[]): void {
    this.rows[y] = row(y, cells)
    this.damage = RenderStateDirty.Partial
  }
}

export function fittedFont(width = 16, height = 24, size = 20): TerminalFittedFont {
  const charHeight = Math.min(height, size)
  const charTop = Math.round((height - charHeight) / 2)
  return {
    charLeft: 0,
    charTop,
    cssCellHeight: height,
    cssCellWidth: width,
    deviceBaseline: charTop + Math.ceil(charHeight * 0.8),
    deviceCellHeight: height,
    deviceCellWidth: width,
    deviceCharHeight: charHeight,
    deviceCharWidth: width,
    pixelRatio: 1,
    settings: {
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: height / charHeight,
      size,
      weight: 400,
    },
  }
}

export function cell(x: number, overrides: Partial<RenderCell> = {}): RenderCell {
  return { continuation: false, selected: false, text: '', x, ...overrides }
}

export function row(y: number, cells: readonly RenderCell[]): RenderRow {
  return { cells, dirty: true, y }
}

export function rgb(r: number, g: number, b: number): RgbColor {
  return { b, g, r }
}

export function style(overrides: Partial<CellStyle>): CellStyle {
  return {
    blink: false,
    bold: false,
    faint: false,
    invisible: false,
    inverse: false,
    italic: false,
    overline: false,
    strikethrough: false,
    underline: 0,
    ...overrides,
  }
}

export interface PixelRegion {
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

export function pixel(pixels: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4
  return [...pixels.subarray(offset, offset + 4)]
}

export function regionPixels(
  pixels: Uint8Array,
  width: number,
  region: PixelRegion,
): readonly number[][] {
  const result: number[][] = []
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      result.push(pixel(pixels, width, x, y))
    }
  }
  return result
}

export function cellRegion(column: number, rowIndex = 0): PixelRegion {
  return { height: 24, width: 16, x: column * 16, y: rowIndex * 24 }
}

export function maximumAlpha(pixels: readonly number[][]): number {
  return Math.max(...pixels.map((value) => value[3] ?? 0))
}
