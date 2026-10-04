import { describe, expect, it } from 'vitest'
import type { InstanceByteRange } from './types.js'
import { planUploadRanges } from './upload-ranges.js'

const empty = { byteOffset: 0, byteLength: 0 }

function update(cell: InstanceByteRange = empty, glyph: InstanceByteRange = empty) {
  return { cell, glyph }
}

function range(byteOffset: number, byteLength: number): InstanceByteRange {
  return { byteOffset, byteLength }
}

describe('bounding upload ranges', () => {
  it('uses one independent min-to-max span per nonempty buffer with unordered input', () => {
    expect(
      planUploadRanges([
        update(range(640, 64), range(192, 96)),
        update(range(64, 64), range(960, 96)),
      ]),
    ).toEqual({ cell: [range(64, 640)], glyph: [range(192, 864)] })
  })

  it('bounds touching, overlapping and separated intervals', () => {
    expect(
      planUploadRanges([
        update(range(64, 128)),
        update(range(0, 128)),
        update(range(192, 64)),
        update(range(320, 64)),
      ]),
    ).toEqual({ cell: [range(0, 384)], glyph: [] })
  })

  it('ignores empty intervals even when their offsets lie outside the bound', () => {
    const input = Object.freeze([
      Object.freeze(update(Object.freeze(range(0, 0)), Object.freeze(range(4096, 0)))),
      Object.freeze(update(Object.freeze(range(64, 64)))),
    ])
    expect(planUploadRanges(input)).toEqual({ cell: [range(64, 64)], glyph: [] })
    expect(input[1]!.cell).toEqual(range(64, 64))
  })

  it('preserves glyph-only erasure ranges and full forced extents', () => {
    expect(
      planUploadRanges([
        update(range(0, 128), range(0, 192)),
        update(range(128, 128), range(192, 192)),
      ]),
    ).toEqual({ cell: [range(0, 256)], glyph: [range(0, 384)] })
    expect(planUploadRanges([update(empty, range(384, 96))])).toEqual({
      cell: [],
      glyph: [range(384, 96)],
    })
  })

  it('handles duplicates and contained intervals without duplicate uploads', () => {
    expect(
      planUploadRanges([update(range(0, 256)), update(range(64, 64)), update(range(0, 256))]),
    ).toEqual({ cell: [range(0, 256)], glyph: [] })
  })

  it('never uploads an empty buffer or a prefix before the first changed byte', () => {
    expect(planUploadRanges([update(empty, range(960, 96))])).toEqual({
      cell: [],
      glyph: [range(960, 96)],
    })
    expect(planUploadRanges([])).toEqual({ cell: [], glyph: [] })
    expect(planUploadRanges([update()])).toEqual({ cell: [], glyph: [] })
  })

  it('preserves four-byte granularity without wider alignment', () => {
    expect(
      planUploadRanges([update(range(4, 4), range(12, 4)), update(range(20, 4), range(16, 4))]),
    ).toEqual({ cell: [range(4, 20)], glyph: [range(12, 8)] })
  })

  it('does not mutate earlier plans or inputs while planning another frame', () => {
    const input = [update(range(0, 64)), update(range(64, 64))]
    const first = planUploadRanges(input)
    planUploadRanges([update(range(0, 256))])
    expect(first).toEqual({ cell: [range(0, 128)], glyph: [] })
    expect(input).toEqual([update(range(0, 64)), update(range(64, 64))])
  })
})
