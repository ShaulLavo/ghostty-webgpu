import { describe, expect, it } from 'vitest'
import { bidiProjection, writeBidiProjection } from './row.js'
import type { RenderRow } from '../core/types.js'
import { RowBidiMapper } from './row.js'

function row(y: number, text: string, selected = false): RenderRow {
  return {
    y,
    dirty: true,
    cells: Array.from(text, (character, x) => ({
      x,
      text: character,
      continuation: false,
      selected,
    })),
  }
}

describe('writeBidiProjection', () => {
  it('writes a partial row into the exact full-grid layout', () => {
    const projection = new Uint32Array(3 * 4 * 3)
    writeBidiProjection([row(2, 'אב')], new RowBidiMapper(), projection, 3)

    expect(projection.slice(0, 3 * 2 * 3)).toEqual(new Uint32Array(3 * 2 * 3))
    expect(projection.slice(2 * 3 * 3, 2 * 3 * 3 + 2 * 3)).toEqual(
      new Uint32Array([1, 0, 0, 0, 0, 0]),
    )
  })

  it('preserves the full projection when selection or row movement changes', () => {
    const mapper = new RowBidiMapper()
    const rows = [row(0, 'ab'), row(1, 'אב', true)]
    const expected = bidiProjection(rows, mapper)
    const projection = new Uint32Array(expected.length)
    writeBidiProjection(rows, mapper, projection, 2)
    expect(projection).toEqual(expected)

    projection.fill(0)
    writeBidiProjection([row(1, 'אב', true)], mapper, projection, 2)
    expect(projection.slice(0, 6)).toEqual(new Uint32Array(6))
    expect(projection.slice(6)).toEqual(expected.slice(6))

    const resized = new Uint32Array(3 * 3 * 3)
    writeBidiProjection([row(2, 'אב', true)], mapper, resized, 3)
    expect(resized.slice(2 * 3 * 3, 2 * 3 * 3 + 6)).toEqual(expected.slice(6))
  })
})
