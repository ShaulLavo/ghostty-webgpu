import { expect, it, vi } from 'vitest'
import { PackedCells } from '../packed-cells.js'
import type { RenderCell } from '../types.js'

it('materializes independent cells with stable optional fields and grapheme continuations', () => {
  const words = new Uint32Array([
    65,
    0x030201,
    0x060504,
    4 | 8 | 16 | (3 << 12),
    0,
    0,
    0,
    0x090807,
    0x0c0b0a,
    8 | 32,
    0,
    2,
    0,
    0xffffffff,
    0xffffffff,
    2,
    0,
    0,
  ])
  const packed = new PackedCells(words, new Uint32Array([101, 0x301]))
  const cells = packed.materialize()
  expect(cells).toHaveLength(3)
  expect(
    cells.map(({ text, x, continuation, selected }) => ({ text, x, continuation, selected })),
  ).toEqual([
    { text: 'A', x: 0, continuation: false, selected: true },
    { text: 'é', x: 1, continuation: false, selected: false },
    { text: '', x: 2, continuation: true, selected: false },
  ])
  expect(cells[0]!.foreground).toEqual({ r: 1, g: 2, b: 3 })
  expect(cells[1]!.background).toEqual({ r: 10, g: 11, b: 12 })
  expect(cells[0]!.style).toMatchObject({ bold: true, italic: false, underline: 3 })
  expect(cells[1]!.style).toMatchObject({ bold: false, italic: true, underline: 0 })
  expect(cells[2]).toMatchObject({ foreground: undefined, background: undefined, style: undefined })
  for (const cell of cells) {
    expect(Object.keys(cell)).toEqual([
      'continuation',
      'selected',
      'text',
      'x',
      'foreground',
      'background',
      'style',
    ])
  }
  const repeated = packed.materialize()
  expect(repeated).toEqual(cells)
  for (let index = 0; index < cells.length; index += 1)
    expect(repeated[index]).not.toBe(cells[index])
  expect(cells[0]!.foreground).not.toBe(cells[1]!.foreground)
  expect(cells[0]!.style).not.toBe(cells[1]!.style)
  expect(repeated[0]!.foreground).not.toBe(cells[0]!.foreground)
  expect(repeated[0]!.style).not.toBe(cells[0]!.style)
  words.fill(0)
  expect(cells[0]!.text).toBe('A')
  expect(cells[1]!.text).toBe('é')
})

it('materializes an empty packed row as a dense empty array', () => {
  expect(new PackedCells(new Uint32Array(), new Uint32Array()).materialize()).toEqual([])
})

it('reuses private cell buffers without changing independent rows and their serialized keys', () => {
  const first = new PackedCells(
    new Uint32Array([65, 0x030201, 0x060504, 8 | 16, 0, 0, 0, 0xffffffff, 0xffffffff, 2, 0, 0]),
    new Uint32Array(),
  )
  const target: RenderCell[] = []
  const retained = first.materialize()
  const borrowed = first.readInto(target)
  expect(borrowed).toBe(target)
  expect(borrowed).toEqual(retained)
  expect(JSON.stringify(borrowed)).toBe(JSON.stringify(retained))
  const cell = target[0]!
  const foreground = cell.foreground
  const style = cell.style
  const next = new PackedCells(
    new Uint32Array([66, 0x090807, 0x0c0b0a, 8 | 32 | (3 << 12), 0, 0]),
    new Uint32Array(),
  )
  expect(next.readInto(target)).toEqual(next.materialize())
  expect(target).toHaveLength(1)
  expect(target[0]).toBe(cell)
  expect(cell.foreground).toBe(foreground)
  expect(cell.style).toBe(style)
  expect(cell).toMatchObject({
    text: 'B',
    foreground: { r: 7, g: 8, b: 9 },
    style: { bold: false, italic: true, underline: 3 },
  })
  expect(retained[0]).toMatchObject({
    text: 'A',
    foreground: { r: 1, g: 2, b: 3 },
    style: { bold: true, italic: false },
  })
  expect(first.materialize()).toEqual(retained)
  const plain = new PackedCells(
    new Uint32Array([67, 0xffffffff, 0xffffffff, 0, 0, 0]),
    new Uint32Array(),
  )
  plain.readInto(target)
  expect(cell).toMatchObject({
    text: 'C',
    foreground: undefined,
    background: undefined,
    style: undefined,
  })
  expect(JSON.stringify(target)).toBe(JSON.stringify(plain.materialize()))
  first.readInto(target)
  expect(target).toHaveLength(2)
  expect(target[0]).toBe(cell)
  expect(target).toEqual(retained)
  new PackedCells(new Uint32Array(), new Uint32Array()).readInto(target)
  expect(target).toEqual([])
})

it('keys grapheme text independently of its storage offset and scalar encoding', () => {
  const direct = new PackedCells(
    new Uint32Array([65, 0x030201, 0xffffffff, 1, 0, 0]),
    new Uint32Array(),
  )
  const shifted = new PackedCells(
    new Uint32Array([0, 0x030201, 0xffffffff, 1, 2, 1]),
    new Uint32Array([90, 91, 65]),
  )
  expect(direct.identity()).toBe(shifted.identity())
  const first = new PackedCells(
    new Uint32Array([0, 0x030201, 0xffffffff, 1, 0, 2]),
    new Uint32Array([101, 0x301]),
  )
  const second = new PackedCells(
    new Uint32Array([0, 0x030201, 0xffffffff, 1, 1, 2]),
    new Uint32Array([90, 101, 0x301]),
  )
  expect(first.identity()).toBe(second.identity())
})

it('keys colors, selection, continuation and every packed style bit', () => {
  const words = new Uint32Array([65, 0x030201, 0x060504, 1, 0, 0])
  const original = new PackedCells(words, new Uint32Array()).identity()
  for (const [offset, value] of [
    [0, 66],
    [1, 0x090807],
    [2, 0xffffffff],
    [3, 2],
    [3, 4],
  ]) {
    const changed = words.slice()
    changed[offset!] = value!
    expect(new PackedCells(changed, new Uint32Array()).identity()).not.toBe(original)
  }
  for (let bit = 3; bit < 16; bit += 1) {
    const changed = words.slice()
    changed[3] = 1 | 8 | (1 << bit)
    expect(new PackedCells(changed, new Uint32Array()).identity()).not.toBe(original)
  }
})

it('keeps text boundaries and row lengths distinct without decoding cells', () => {
  const split = new PackedCells(
    new Uint32Array([65, 0xffffffff, 0xffffffff, 1, 0, 0, 66, 0xffffffff, 0xffffffff, 1, 0, 0]),
    new Uint32Array(),
  )
  const joined = new PackedCells(
    new Uint32Array([0, 0xffffffff, 0xffffffff, 1, 0, 2, 0, 0xffffffff, 0xffffffff, 1, 0, 0]),
    new Uint32Array([65, 66]),
  )
  const read = vi.spyOn(split, 'read')
  const materialize = vi.spyOn(split, 'materialize')
  const borrow = vi.spyOn(split, 'readInto')
  const identity = split.identity()
  expect(identity).not.toBe(joined.identity())
  expect(identity).not.toBe(new PackedCells(new Uint32Array(), new Uint32Array()).identity())
  expect(read).not.toHaveBeenCalled()
  expect(materialize).not.toHaveBeenCalled()
  expect(borrow).not.toHaveBeenCalled()
  const delimiter = new PackedCells(
    new Uint32Array([0, 0xffffffff, 0xffffffff, 1, 0, 7]),
    new Uint32Array([49, 58, 65, 58, 45, 58, 49]),
  )
  expect(delimiter.identity()).not.toBe(identity)
  split.readInto([])
  expect(split.identity()).toBe(identity)
})
