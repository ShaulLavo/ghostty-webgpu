import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { TerminalFittedFont } from '../../../term/types.js'
import { loadGsubLigatureFinder, resolveLigatureFinder } from './finder.js'

class Writer {
  private readonly bytes: number[] = []

  get length(): number {
    return this.bytes.length
  }

  u16(...values: number[]): this {
    for (const value of values) this.bytes.push((value >> 8) & 255, value & 255)
    return this
  }

  u32(...values: number[]): this {
    for (const value of values) this.u16((value >>> 16) & 0xffff, value & 0xffff)
    return this
  }

  tag(value: string): this {
    for (const character of value) this.bytes.push(character.charCodeAt(0))
    return this
  }

  append(bytes: Uint8Array): this {
    for (const byte of bytes) this.bytes.push(byte)
    return this
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

// One format 12 group maps a and b to glyphs 1 and 2.
function cmap(): Uint8Array {
  return new Writer()
    .u16(0, 1)
    .u16(3, 10)
    .u32(12)
    .u16(12, 0)
    .u32(28, 0, 1)
    .u32(0x61, 0x62, 1)
    .done()
}

function lookup(type: number, subtables: Uint8Array[]): Uint8Array {
  const writer = new Writer().u16(type, 0, subtables.length)
  let offset = 6 + subtables.length * 2
  for (const subtable of subtables) {
    writer.u16(offset)
    offset += subtable.length
  }
  for (const subtable of subtables) writer.append(subtable)
  return writer.done()
}

// One calt feature in the default script uses every lookup.
function gsub(lookups: Uint8Array[]): Uint8Array {
  const scripts = new Writer().u16(1).tag('DFLT').u16(8).u16(4, 0).u16(0, 0xffff, 1, 0).done()
  const features = new Writer()
    .u16(1)
    .tag('calt')
    .u16(8)
    .u16(0, lookups.length)
    .u16(...lookups.map((_, index) => index))
    .done()
  const list = new Writer().u16(lookups.length)
  let offset = 2 + lookups.length * 2
  for (const table of lookups) {
    list.u16(offset)
    offset += table.length
  }
  for (const table of lookups) list.append(table)
  const header = 10
  return new Writer()
    .u16(1, 0, header, header + scripts.length, header + scripts.length + features.length)
    .append(scripts)
    .append(features)
    .append(list.done())
    .done()
}

function sfnt(tables: Record<string, Uint8Array>): Uint8Array {
  const entries = Object.entries(tables)
  const writer = new Writer().u32(0x00010000).u16(entries.length, 0, 0, 0)
  let offset = 12 + entries.length * 16
  for (const [name, bytes] of entries) {
    writer.tag(name).u32(0, offset, bytes.length)
    offset += bytes.length
  }
  for (const [, bytes] of entries) writer.append(bytes)
  return writer.done()
}

function woff(name: string, compressed: Uint8Array, length: number): Uint8Array {
  return new Writer()
    .tag('wOFF')
    .u32(0x00010000, 64 + compressed.length)
    .u16(1, 0)
    .u32(12 + 16 + length)
    .u16(1, 0)
    .u32(0, 0, 0, 0, 0)
    .tag(name)
    .u32(64, compressed.length, length, 0)
    .append(compressed)
    .done()
}

// Context format 3: at glyph 1, apply the listed lookups at position 0.
function selfContext(records: number): Uint8Array {
  const writer = new Writer().u16(3, 1, records, 6 + 2 + records * 4)
  for (let record = 0; record < records; record += 1) writer.u16(0, 0)
  return writer.u16(1, 1, 1).done()
}

function rangeSingle(first: number, last: number): Uint8Array {
  return new Writer().u16(1, 6, 1).u16(2, 1, first, last, 0).done()
}

const points = (text: string) => Array.from(text, (character) => character.codePointAt(0)!)

describe('ligature font limits', () => {
  it('stops self-recursive contextual lookups', async () => {
    const finder = await loadGsubLigatureFinder(
      sfnt({ cmap: cmap(), GSUB: gsub([lookup(5, [selfContext(1)])]) }),
    )
    expect(finder.find(points('ab'))).toEqual([])
  })

  it('bounds exponential nesting with a per-segment work budget', async () => {
    const finder = await loadGsubLigatureFinder(
      sfnt({ cmap: cmap(), GSUB: gsub([lookup(5, [selfContext(8)])]) }),
    )
    const started = performance.now()
    expect(finder.find(points('aab'))).toEqual([])
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('rejects truncated lookup data while loading', async () => {
    const table = gsub([lookup(1, [rangeSingle(1, 2)])])
    const truncated = table.subarray(0, table.length - 6)
    await expect(loadGsubLigatureFinder(sfnt({ cmap: cmap(), GSUB: truncated }))).rejects.toThrow(
      RangeError,
    )
  })

  it('rejects a coverage range that ends before it starts', async () => {
    await expect(
      loadGsubLigatureFinder(sfnt({ cmap: cmap(), GSUB: gsub([lookup(1, [rangeSingle(5, 1)])]) })),
    ).rejects.toThrow('ends before it starts')
  })

  it('rejects tables that expand past the parsing budget', async () => {
    const lookups = Array.from({ length: 20 }, () => lookup(1, [rangeSingle(0, 0xffff)]))
    await expect(
      loadGsubLigatureFinder(sfnt({ cmap: cmap(), GSUB: gsub(lookups) })),
    ).rejects.toThrow('budget')
  })

  it('stops inflating WOFF data beyond its declared length', async () => {
    const bomb = deflateSync(new Uint8Array(10 * 1024 * 1024))
    await expect(loadGsubLigatureFinder(woff('GSUB', bomb, 20_000))).rejects.toThrow(
      'longer than declared',
    )
  })

  it('rejects oversized font files before parsing', async () => {
    const huge = new Uint8Array(33 * 1024 * 1024)
    huge.set([0, 1, 0, 0])
    await expect(loadGsubLigatureFinder(huge)).rejects.toThrow('size limit')
  })

  it('falls back to the probe for true and rejects an explicit bad font', async () => {
    const bad = sfnt({ cmap: cmap(), GSUB: gsub([lookup(1, [rangeSingle(5, 1)])]) })
    const font: TerminalFittedFont = {
      charLeft: 0,
      charTop: 2,
      cssCellHeight: 24,
      cssCellWidth: 16,
      deviceBaseline: 18,
      deviceCellHeight: 24,
      deviceCellWidth: 16,
      deviceCharHeight: 20,
      deviceCharWidth: 16,
      pixelRatio: 1,
      settings: {
        boldWeight: 700,
        family: 'monospace',
        letterSpacing: 0,
        lineHeight: 1.2,
        size: 20,
        weight: 400,
      },
    }
    await expect(resolveLigatureFinder(true, font, bad)).resolves.toBeDefined()
    await expect(resolveLigatureFinder({ font: bad }, font)).rejects.toThrow(RangeError)
  })
})
