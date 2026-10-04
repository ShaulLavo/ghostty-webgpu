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
