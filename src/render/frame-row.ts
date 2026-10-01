import type { RenderRow } from '../core/types.js'
import type { RendererFrameRow } from './renderer.js'

export function copiedFrameRow(row: RenderRow): RendererFrameRow {
  const packed = row.packed
  const length = packed?.length ?? row.cells.length
  const cells: string[] = []
  const continuations: boolean[] = []
  let text = ''
  for (let index = 0; index < length; index += 1) {
    const cell = packed ? packed.text(index) : row.cells[index]!.text
    const continuation = packed ? packed.continuation(index) : row.cells[index]!.continuation
    cells.push(cell)
    continuations.push(continuation)
    text += continuation ? '' : cell || ' '
  }
  return Object.freeze({
    cells: Object.freeze(cells),
    continuations: Object.freeze(continuations),
    text,
    y: row.y,
  })
}
