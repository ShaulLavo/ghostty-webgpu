import type { InstanceByteRange } from './types.js'

export interface UploadPlan {
  readonly cell: readonly InstanceByteRange[]
  readonly glyph: readonly InstanceByteRange[]
}

type InstanceUpdate = {
  readonly cell: InstanceByteRange
  readonly glyph: InstanceByteRange
}

function boundingRange(updates: readonly InstanceUpdate[], kind: 'cell' | 'glyph') {
  let start = Infinity
  let end = 0
  for (const update of updates) {
    const range = update[kind]
    if (range.byteLength === 0) continue
    start = Math.min(start, range.byteOffset)
    end = Math.max(end, range.byteOffset + range.byteLength)
  }
  if (start === Infinity) return []
  return [{ byteOffset: start, byteLength: end - start }]
}

export function planUploadRanges(updates: readonly InstanceUpdate[]): UploadPlan {
  return { cell: boundingRange(updates, 'cell'), glyph: boundingRange(updates, 'glyph') }
}

function mergedRanges(updates: readonly InstanceUpdate[], kind: 'cell' | 'glyph') {
  const ranges = updates.map((update) => update[kind]).filter((range) => range.byteLength > 0)
  ranges.sort((left, right) => left.byteOffset - right.byteOffset)
  const result: InstanceByteRange[] = []
  for (const range of ranges) {
    const previous = result.at(-1)
    const end = range.byteOffset + range.byteLength
    if (!previous || range.byteOffset > previous.byteOffset + previous.byteLength) {
      result.push(range)
      continue
    }
    result[result.length - 1] = {
      byteOffset: previous.byteOffset,
      byteLength: Math.max(end, previous.byteOffset + previous.byteLength) - previous.byteOffset,
    }
  }
  return result
}

export function planSparseUploadRanges(updates: readonly InstanceUpdate[]): UploadPlan {
  return { cell: mergedRanges(updates, 'cell'), glyph: mergedRanges(updates, 'glyph') }
}

function wrappedBounds(
  updates: readonly (InstanceUpdate & { readonly row: number })[],
  kind: 'cell' | 'glyph',
  wrapRow: number,
): readonly InstanceByteRange[] {
  const bounds = [
    { start: Infinity, end: 0 },
    { start: Infinity, end: 0 },
  ]
  for (const update of updates) {
    const range = update[kind]
    if (range.byteLength === 0) continue
    const bound = bounds[Number(update.row >= wrapRow)]!
    bound.start = Math.min(bound.start, range.byteOffset)
    bound.end = Math.max(bound.end, range.byteOffset + range.byteLength)
  }
  const [high, low] = bounds
  if (high!.start === Infinity || low!.start === Infinity || low!.end >= high!.start)
    return boundingRange(updates, kind)
  return bounds.map(({ start, end }) => ({ byteOffset: start, byteLength: end - start }))
}

export function planWrappedUploadRanges(
  updates: readonly (InstanceUpdate & { readonly row: number })[],
  wrapRow: number,
): UploadPlan {
  if (wrapRow === Infinity || updates.length < 2) return planUploadRanges(updates)
  const firstSide = updates[0]!.row >= wrapRow
  for (let index = 1; index < updates.length; index += 1) {
    if (updates[index]!.row >= wrapRow === firstSide) continue
    return {
      cell: wrappedBounds(updates, 'cell', wrapRow),
      glyph: wrappedBounds(updates, 'glyph', wrapRow),
    }
  }
  return planUploadRanges(updates)
}
