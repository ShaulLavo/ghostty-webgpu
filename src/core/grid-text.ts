import { PointTag, RowData } from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import { requireLayout } from './memory.js'
import { readSelectionText } from './native-text.js'
import type { GhosttyTerminal } from './terminal.js'
import type { ReadLinesOptions, TerminalLine } from './types.js'

// Bound synchronous row-metadata lookups and decoded text allocations.
export const TERMINAL_READ_LINES_MAX_ROWS = 1024

class RowRange {
  private readonly runtime
  private readonly pointLayout
  private readonly coordinateLayout
  private readonly refLayout
  private readonly selectionLayout
  private readonly storage: number
  private readonly storageSize: number
  private readonly point: number
  private readonly ref: number
  private readonly scalar: number
  private readonly coordinate: number
  readonly selection: number

  constructor(private readonly terminal: GhosttyTerminal) {
    this.runtime = terminal.runtime
    this.pointLayout = requireLayout(this.runtime.layouts, 'GhosttyPoint')
    this.coordinateLayout = requireLayout(this.runtime.layouts, 'GhosttyPointCoordinate')
    this.refLayout = requireLayout(this.runtime.layouts, 'GhosttyGridRef')
    this.selectionLayout = requireLayout(this.runtime.layouts, 'GhosttySelection')
    const union = requireLayout(this.runtime.layouts, 'GhosttyPointValue')
    const refOffset = Math.ceil(this.pointLayout.size / 8) * 8
    const selectionOffset = Math.ceil((refOffset + this.refLayout.size) / 8) * 8
    const scalarOffset = Math.ceil((selectionOffset + this.selectionLayout.size) / 8) * 8
    this.storageSize = scalarOffset + 8
    this.storage = this.runtime.memory.allocate(this.storageSize)
    this.point = this.storage
    this.ref = this.storage + refOffset
    this.selection = this.storage + selectionOffset
    this.scalar = this.storage + scalarOffset
    this.coordinate =
      this.point + this.pointLayout.fields.value!.offset + union.fields.coordinate!.offset
    this.runtime.memory.view.setInt32(
      this.point + this.pointLayout.fields.tag!.offset,
      PointTag.Screen,
      true,
    )
    this.runtime.memory.view.setUint32(
      this.selection + this.selectionLayout.fields.size!.offset,
      this.selectionLayout.size,
      true,
    )
  }

  dispose(): void {
    this.runtime.memory.free(this.storage, this.storageSize)
  }

  set(start: number, end: number): void {
    this.resolve(start, 0, this.selection + this.selectionLayout.fields.start!.offset)
    this.resolve(
      end - 1,
      this.terminal.size.columns - 1,
      this.selection + this.selectionLayout.fields.end!.offset,
    )
  }

  wrapped(row: number): boolean {
    this.resolve(row, 0, this.ref)
    assertGhosttyResult(
      'ghostty_grid_ref_row',
      this.runtime.exports.ghostty_grid_ref_row(this.ref, this.scalar),
    )
    const raw = this.runtime.memory.view.getBigUint64(this.scalar, true)
    assertGhosttyResult(
      'ghostty_row_get(WRAP)',
      this.runtime.exports.ghostty_row_get(raw, RowData.Wrap, this.scalar),
    )
    return this.runtime.memory.view.getUint8(this.scalar) !== 0
  }

  private resolve(row: number, column: number, ref: number): void {
    this.runtime.memory.view.setUint16(
      this.coordinate + this.coordinateLayout.fields.x!.offset,
      column,
      true,
    )
    this.runtime.memory.view.setUint32(
      this.coordinate + this.coordinateLayout.fields.y!.offset,
      row,
      true,
    )
    this.runtime.memory.view.setUint32(
      ref + this.refLayout.fields.size!.offset,
      this.refLayout.size,
      true,
    )
    assertGhosttyResult(
      'ghostty_terminal_grid_ref(SCREEN)',
      this.runtime.exports.ghostty_terminal_grid_ref(this.terminal.handle, this.point, ref),
    )
  }
}

function clampIndex(value: number, count: number): number {
  if (typeof value !== 'number' || Number.isNaN(value))
    throw createGhosttyError('terminal.readLines', 'Row index must be a number')
  return Math.max(0, Math.min(count, Math.trunc(value)))
}

export function readTerminalLines(
  terminal: GhosttyTerminal,
  start: number,
  end: number,
  options: ReadLinesOptions,
): readonly TerminalLine[] {
  const count = terminal.totalRows
  const first = clampIndex(start, count)
  const last = Math.min(clampIndex(end, count), first + TERMINAL_READ_LINES_MAX_ROWS)
  if (last <= first) return []
  const range = new RowRange(terminal)
  try {
    range.set(first, last)
    // Native trim:false preserves written space-plus-combining graphemes; trim U+0020 per row.
    const rows = (
      readSelectionText(terminal, { unwrap: false, trim: false }, range.selection) ?? ''
    ).split('\n')
    const lines: TerminalLine[] = []
    for (let index = first; index < last; index += 1) {
      const text = rows[index - first] ?? ''
      lines.push({
        text: (options.trimRight ?? true) ? text.replace(/ +$/, '') : text,
        wrapped: range.wrapped(index),
      })
    }
    return lines
  } finally {
    range.dispose()
  }
}
