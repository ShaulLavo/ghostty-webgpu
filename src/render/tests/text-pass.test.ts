import { expect, it } from 'vitest'
import type { RowInstanceUpdate } from '../instances/types.js'
import { coalesceInstanceUpdates } from '../text-pass.js'

function update(row: number): RowInstanceUpdate {
  return {
    cell: { byteLength: 128, byteOffset: row * 128 },
    glyph: { byteLength: 192, byteOffset: row * 192 },
    invalidatedRows: [],
    row,
  }
}

it('coalesces adjacent row uploads without spanning clean gaps', () => {
  expect(coalesceInstanceUpdates([update(0), update(1), update(2), update(4)])).toEqual([
    {
      cell: { byteLength: 384, byteOffset: 0 },
      glyph: { byteLength: 576, byteOffset: 0 },
    },
    {
      cell: { byteLength: 128, byteOffset: 512 },
      glyph: { byteLength: 192, byteOffset: 768 },
    },
  ])
})

it('does not mutate row update ranges while coalescing', () => {
  const updates = [update(0), update(1)]
  coalesceInstanceUpdates(updates)

  expect(updates).toEqual([update(0), update(1)])
})
