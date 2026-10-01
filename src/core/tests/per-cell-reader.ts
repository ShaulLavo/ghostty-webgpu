import {
  CellData,
  CellWide,
  GhosttyResult,
  RenderStateCellData,
  RenderStateData,
  RenderStateRowData,
} from '../abi.js'
import { assertGhosttyResult, createGhosttyError } from '../error.js'
import { requireLayout } from '../memory.js'
import type { GhosttyRuntime } from '../runtime.js'
import type { CellStyle, RenderCell, RenderRow, RgbColor } from '../types.js'

function alignOffset(offset: number, alignment: number): number {
  return Math.ceil(offset / alignment) * alignment
}

class CellReader {
  private readonly boolPointer: number
  private readonly bufferLayout
  private readonly bufferPointer: number
  private readonly colorPointer: number
  private readonly rawCellPointer: number
  private readonly runtime: GhosttyRuntime
  private readonly storagePointer: number
  private readonly storageSize: number
  private readonly styleLayout
  private readonly stylePointer: number
  private readonly textCapacity = 64
  private readonly textPointer: number
  private readonly widePointer: number

  constructor(runtime: GhosttyRuntime) {
    this.runtime = runtime
    this.bufferLayout = requireLayout(runtime.layouts, 'GhosttyBuffer')
    this.styleLayout = requireLayout(runtime.layouts, 'GhosttyStyle')
    const boolOffset = 0
    const rawCellOffset = alignOffset(boolOffset + 1, 8)
    const wideOffset = rawCellOffset + 8
    const bufferOffset = alignOffset(wideOffset + 4, this.bufferLayout.align)
    const colorOffset = bufferOffset + this.bufferLayout.size
    const styleOffset = alignOffset(colorOffset + 3, this.styleLayout.align)
    const textOffset = styleOffset + this.styleLayout.size
    this.storageSize = textOffset + this.textCapacity
    this.storagePointer = runtime.memory.allocate(this.storageSize)
    this.boolPointer = this.storagePointer + boolOffset
    this.rawCellPointer = this.storagePointer + rawCellOffset
    this.widePointer = this.storagePointer + wideOffset
    this.bufferPointer = this.storagePointer + bufferOffset
    this.colorPointer = this.storagePointer + colorOffset
    this.stylePointer = this.storagePointer + styleOffset
    this.textPointer = this.storagePointer + textOffset
  }

  read(cells: number, x: number): RenderCell {
    const hasStyling = this.readBoolean(cells, RenderStateCellData.HasStyling)
    return {
      background: this.readColor(cells, RenderStateCellData.BackgroundColor),
      continuation: this.readWide(cells) === CellWide.SpacerTail,
      foreground: this.readColor(cells, RenderStateCellData.ForegroundColor),
      selected: this.readBoolean(cells, RenderStateCellData.Selected),
      style: hasStyling ? this.readStyle(cells) : undefined,
      text: this.readText(cells),
      x,
    }
  }

  dispose(): void {
    this.runtime.memory.free(this.storagePointer, this.storageSize)
  }

  private get exports() {
    return this.runtime.exports
  }

  private readBoolean(cells: number, data: RenderStateCellData): boolean {
    assertGhosttyResult(
      `ghostty_render_state_row_cells_get(${data})`,
      this.exports.ghostty_render_state_row_cells_get(cells, data, this.boolPointer),
    )
    return this.runtime.memory.view.getUint8(this.boolPointer) !== 0
  }

  private readWide(cells: number): CellWide {
    assertGhosttyResult(
      'ghostty_render_state_row_cells_get(RAW)',
      this.exports.ghostty_render_state_row_cells_get(
        cells,
        RenderStateCellData.Raw,
        this.rawCellPointer,
      ),
    )
    const cell = this.runtime.memory.view.getBigUint64(this.rawCellPointer, true)
    assertGhosttyResult(
      'ghostty_cell_get(WIDE)',
      this.exports.ghostty_cell_get(cell, CellData.Wide, this.widePointer),
    )
    return this.runtime.memory.view.getInt32(this.widePointer, true) as CellWide
  }

  private readColor(cells: number, data: RenderStateCellData): RgbColor | undefined {
    const result = this.exports.ghostty_render_state_row_cells_get(cells, data, this.colorPointer)
    if (result === GhosttyResult.InvalidValue) return undefined
    assertGhosttyResult(`ghostty_render_state_row_cells_get(${data})`, result)
    return {
      b: this.runtime.memory.view.getUint8(this.colorPointer + 2),
      g: this.runtime.memory.view.getUint8(this.colorPointer + 1),
      r: this.runtime.memory.view.getUint8(this.colorPointer),
    }
  }

  private readText(cells: number): string {
    this.initializeTextBuffer(this.textPointer, this.textCapacity)
    const result = this.exports.ghostty_render_state_row_cells_get(
      cells,
      RenderStateCellData.GraphemesUtf8,
      this.bufferPointer,
    )
    const length = this.readBufferLength()
    if (result === GhosttyResult.Success)
      return this.runtime.memory.decode(this.textPointer, length)
    if (result === GhosttyResult.OutOfSpace) return this.readLargeText(cells, length)
    assertGhosttyResult('ghostty_render_state_row_cells_get(GRAPHEMES_UTF8)', result)
    return ''
  }

  private readLargeText(cells: number, capacity: number): string {
    const pointer = this.runtime.memory.allocate(capacity)
    try {
      this.initializeTextBuffer(pointer, capacity)
      assertGhosttyResult(
        'ghostty_render_state_row_cells_get(GRAPHEMES_UTF8)',
        this.exports.ghostty_render_state_row_cells_get(
          cells,
          RenderStateCellData.GraphemesUtf8,
          this.bufferPointer,
        ),
      )
      return this.runtime.memory.decode(pointer, this.readBufferLength())
    } finally {
      this.runtime.memory.free(pointer, capacity)
    }
  }

  private initializeTextBuffer(pointer: number, capacity: number): void {
    const fields = this.bufferLayout.fields
    this.runtime.memory.view.setUint32(this.bufferPointer + fields.ptr!.offset, pointer, true)
    this.runtime.memory.view.setUint32(this.bufferPointer + fields.cap!.offset, capacity, true)
    this.runtime.memory.view.setUint32(this.bufferPointer + fields.len!.offset, 0, true)
  }

  private readBufferLength(): number {
    return this.runtime.memory.view.getUint32(
      this.bufferPointer + this.bufferLayout.fields.len!.offset,
      true,
    )
  }

  private readStyle(cells: number): CellStyle {
    const fields = this.styleLayout.fields
    this.runtime.memory.bytes.fill(0, this.stylePointer, this.stylePointer + this.styleLayout.size)
    this.runtime.memory.view.setUint32(
      this.stylePointer + fields.size!.offset,
      this.styleLayout.size,
      true,
    )
    assertGhosttyResult(
      'ghostty_render_state_row_cells_get(STYLE)',
      this.exports.ghostty_render_state_row_cells_get(
        cells,
        RenderStateCellData.Style,
        this.stylePointer,
      ),
    )
    return {
      blink: this.readStyleBoolean('blink'),
      bold: this.readStyleBoolean('bold'),
      faint: this.readStyleBoolean('faint'),
      invisible: this.readStyleBoolean('invisible'),
      inverse: this.readStyleBoolean('inverse'),
      italic: this.readStyleBoolean('italic'),
      overline: this.readStyleBoolean('overline'),
      strikethrough: this.readStyleBoolean('strikethrough'),
      underline: this.runtime.memory.view.getInt32(
        this.stylePointer + fields.underline!.offset,
        true,
      ),
    }
  }

  private readStyleBoolean(name: string): boolean {
    const field = this.styleLayout.fields[name]
    if (!field) {
      throw createGhosttyError('ghostty_type_json', `GhosttyStyle.${name} is missing`)
    }
    return this.runtime.memory.view.getUint8(this.stylePointer + field.offset) !== 0
  }
}

export function readPerCellRows(
  runtime: GhosttyRuntime,
  state: number,
  iterator: number,
  cells: number,
): readonly RenderRow[] {
  const out = runtime.memory.allocate(12)
  const reader = new CellReader(runtime)
  const exports = runtime.exports
  try {
    runtime.memory.view.setUint32(out + 4, iterator, true)
    runtime.memory.view.setUint32(out + 8, cells, true)
    assertGhosttyResult(
      'state.iterator',
      exports.ghostty_render_state_get(state, RenderStateData.RowIterator, out + 4),
    )
    const rows: RenderRow[] = []
    let y = 0
    while (exports.ghostty_render_state_row_iterator_next(iterator)) {
      assertGhosttyResult(
        'row.cells',
        exports.ghostty_render_state_row_get(iterator, RenderStateRowData.Cells, out + 8),
      )
      const row: RenderCell[] = []
      while (exports.ghostty_render_state_row_cells_next(cells))
        row.push(reader.read(cells, row.length))
      rows.push({ cells: row, y: y++, dirty: true })
    }
    return rows
  } finally {
    reader.dispose()
    runtime.memory.free(out, 12)
  }
}
