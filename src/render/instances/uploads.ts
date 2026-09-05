import type { InstanceByteRange, RowInstanceUpdate } from './types.js'

export interface InstanceUploadBatch {
  readonly cell: InstanceByteRange
  readonly glyph: InstanceByteRange
}

function copiedRange(range: InstanceByteRange): InstanceByteRange {
  return { byteLength: range.byteLength, byteOffset: range.byteOffset }
}

function copiedBatch(update: RowInstanceUpdate): InstanceUploadBatch {
  return { cell: copiedRange(update.cell), glyph: copiedRange(update.glyph) }
}

function rangesAreAdjacent(left: InstanceByteRange, right: InstanceByteRange): boolean {
  return left.byteOffset + left.byteLength === right.byteOffset
}

function batchesAreAdjacent(batch: InstanceUploadBatch, update: RowInstanceUpdate): boolean {
  return rangesAreAdjacent(batch.cell, update.cell) && rangesAreAdjacent(batch.glyph, update.glyph)
}

function extendBatch(batch: InstanceUploadBatch, update: RowInstanceUpdate): void {
  batch.cell.byteLength += update.cell.byteLength
  batch.glyph.byteLength += update.glyph.byteLength
}

export function coalesceInstanceUpdates(
  updates: readonly RowInstanceUpdate[],
): readonly InstanceUploadBatch[] {
  const batches: InstanceUploadBatch[] = []
  for (const update of updates) {
    const previous = batches.at(-1)
    if (!previous || !batchesAreAdjacent(previous, update)) {
      batches.push(copiedBatch(update))
      continue
    }
    extendBatch(previous, update)
  }
  return batches
}
