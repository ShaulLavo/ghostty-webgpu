import { describe, expect, it } from 'vitest'
import type { InstanceByteRange } from './types.js'
import {
  planSparseUploadRanges,
  planUploadRanges,
  planWrappedUploadRanges,
} from './upload-ranges.js'

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

describe('wrapped WebGPU upload ranges', () => {
  it('bounds each physical side independently with immutable unordered dirty rows', () => {
    const input = Object.freeze([
      Object.freeze({ row: 11, ...update(range(0, 64), range(0, 96)) }),
      Object.freeze({ row: 10, ...update(range(28160, 64), range(42240, 96)) }),
      Object.freeze({ row: 9, ...update(range(25600, 64), range(38400, 96)) }),
    ])
    expect(planWrappedUploadRanges(input, 11)).toEqual({
      cell: [range(25600, 2624), range(0, 64)],
      glyph: [range(38400, 3936), range(0, 96)],
    })
    expect(input[0]!.cell).toEqual(range(0, 64))
  })

  it('retains independent glyph-only erasures and empty cells on either side', () => {
    expect(
      planWrappedUploadRanges(
        [
          { row: 10, ...update(empty, range(42240, 4)) },
          { row: 11, ...update(empty, range(0, 4)) },
        ],
        11,
      ),
    ).toEqual({ cell: [], glyph: [range(42240, 4), range(0, 4)] })
    expect(
      planWrappedUploadRanges(
        [
          { row: 10, ...update(range(28160, 64)) },
          { row: 11, ...update(empty, range(0, 96)) },
        ],
        11,
      ),
    ).toEqual({ cell: [range(28160, 64)], glyph: [range(0, 96)] })
  })

  it('keeps touching full-frame sides as the original bounding upload', () => {
    const input = [
      { row: 0, ...update(range(2560, 28160), range(3840, 42240)) },
      { row: 11, ...update(range(0, 2560), range(0, 3840)) },
    ]
    expect(planWrappedUploadRanges(input, 11)).toEqual(planUploadRanges(input))
  })

  it('keeps every nonwrapped plan byte-identical across all ring offsets', () => {
    for (let offset = 0; offset < 12; offset += 1) {
      const wrapRow = offset === 0 ? Infinity : 12 - offset
      for (let mask = 0; mask < 256; mask += 1) {
        const input = Array.from({ length: 12 }, (_, row) => ({
          row,
          ...update(range(((row + offset) % 12) * 2560 + 4, 4)),
        })).filter(({ row }) => (mask & (1 << (row % 8))) !== 0)
        const sides = new Set(input.map(({ row }) => row >= wrapRow))
        if (sides.size > 1) continue
        expect(planWrappedUploadRanges(input, wrapRow)).toEqual(planUploadRanges(input))
      }
    }
  })
})

describe('sparse WebGPU upload ranges', () => {
  it('merges touching and overlapping records while preserving resident gaps', () => {
    const input = Object.freeze([
      Object.freeze(update(Object.freeze(range(320, 64)), Object.freeze(range(384, 96)))),
      Object.freeze(update(Object.freeze(range(64, 128)), Object.freeze(range(192, 96)))),
      Object.freeze(update(Object.freeze(range(0, 128)))),
      Object.freeze(update(Object.freeze(range(192, 64)))),
      Object.freeze(update(empty, range(4096, 0))),
    ])
    expect(planSparseUploadRanges(input)).toEqual({
      cell: [range(0, 256), range(320, 64)],
      glyph: [range(192, 96), range(384, 96)],
    })
    expect(planUploadRanges(input)).toEqual({ cell: [range(0, 384)], glyph: [range(192, 288)] })
    expect(input[0]!.cell).toEqual(range(320, 64))
  })

  it('preserves empty moves, four-byte erasures and independent plans', () => {
    expect(planSparseUploadRanges([update()])).toEqual({ cell: [], glyph: [] })
    const first = planSparseUploadRanges([
      update(range(4, 4), range(12, 4)),
      update(range(20, 4), range(16, 4)),
    ])
    planSparseUploadRanges([update(range(0, 256), range(0, 384))])
    expect(first).toEqual({ cell: [range(4, 4), range(20, 4)], glyph: [range(12, 8)] })
  })
})
