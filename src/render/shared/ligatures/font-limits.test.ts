import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const fontByteLimit = 32 * 1024 * 1024
const fontUrl = 'https://font.invalid/font.ttf'

function streamedFont(chunks: readonly Uint8Array[], contentLength?: string, status = 200) {
  let index = 0
  const cancel = vi.fn()
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = chunks[index++]
    if (chunk === undefined) return controller.close()
    controller.enqueue(chunk)
  })
  const body = new ReadableStream({ cancel, pull }, { highWaterMark: 0 })
  const headers = new Headers()
  if (contentLength !== undefined) headers.set('Content-Length', contentLength)
  const response = new Response(body, { headers, status })
  const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  return { arrayBuffer, body, cancel, pull }
}

function emptyFont(length = 12): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set([0, 1, 0, 0])
  return bytes
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ligature font downloads', () => {
  it('rejects an oversized declared body without reading it', async () => {
    const stream = streamedFont([emptyFont()], String(fontByteLimit + 1))
    await expect(loadGsubLigatureFinder(fontUrl)).rejects.toThrow('size limit')
    expect(stream.pull).not.toHaveBeenCalled()
    expect(stream.arrayBuffer).not.toHaveBeenCalled()
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(stream.body.locked).toBe(false)
  })

  it.each([undefined, '12', 'unknown', '-1', '1e9', '33554433.5'])(
    'stops an oversized stream with Content-Length %s at its first excess byte',
    async (length) => {
      const block = emptyFont(1024 * 1024)
      const chunks = Array.from({ length: 32 }, () => block).concat([
        new Uint8Array(1),
        new Uint8Array(1024),
      ])
      const stream = streamedFont(chunks, length)
      await expect(loadGsubLigatureFinder(fontUrl)).rejects.toThrow('size limit')
      expect(stream.pull).toHaveBeenCalledTimes(33)
      expect(stream.arrayBuffer).not.toHaveBeenCalled()
      expect(stream.cancel).toHaveBeenCalledOnce()
      expect(stream.body.locked).toBe(false)
    },
  )

  it('rejects a single oversized chunk without requesting another', async () => {
    const stream = streamedFont([emptyFont(fontByteLimit + 1), new Uint8Array(1)])
    await expect(loadGsubLigatureFinder(fontUrl)).rejects.toThrow('size limit')
    expect(stream.pull).toHaveBeenCalledOnce()
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(stream.body.locked).toBe(false)
  })

  it('accepts a valid font at exactly 32 MiB', async () => {
    const stream = streamedFont([emptyFont(fontByteLimit)], String(fontByteLimit))
    const finder = await loadGsubLigatureFinder(fontUrl)
    expect(finder.find(points('ab'))).toEqual([])
    expect(stream.arrayBuffer).not.toHaveBeenCalled()
    expect(stream.cancel).not.toHaveBeenCalled()
    expect(stream.body.locked).toBe(false)
  })

  it('reads chunk views, empty chunks and a short final chunk without padding', async () => {
    const bytes = new Uint8Array(30).fill(255)
    bytes.set(emptyFont(), 5)
    const stream = streamedFont([bytes.subarray(5, 10), new Uint8Array(0), bytes.subarray(10, 17)])
    const finder = await loadGsubLigatureFinder(fontUrl)
    expect(finder.find(points('ab'))).toEqual([])
    expect(stream.arrayBuffer).not.toHaveBeenCalled()
    expect(stream.body.locked).toBe(false)
  })

  it.each([false, true])(
    'cancels a non-OK body without reading it when cancellation rejects: %s',
    async (cancelRejects) => {
      const stream = streamedFont([emptyFont()], undefined, 404)
      if (cancelRejects) stream.cancel.mockRejectedValue(new Error('cancel failed'))
      try {
        await expect(loadGsubLigatureFinder(fontUrl)).rejects.toThrow('HTTP 404')
        expect(stream.pull).not.toHaveBeenCalled()
        expect(stream.arrayBuffer).not.toHaveBeenCalled()
        expect(stream.cancel).toHaveBeenCalledOnce()
        expect(stream.body.locked).toBe(false)
      } finally {
        await stream.body.cancel().catch(() => {})
      }
    },
  )

  it('never uses arrayBuffer when there is no readable body', async () => {
    const response = new Response(null)
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(loadGsubLigatureFinder(fontUrl)).rejects.toThrow('body')
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('propagates stream errors and releases the reader', async () => {
    const failure = new Error('font connection failed')
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure)
      },
    })
    const response = new Response(body)
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(loadGsubLigatureFinder(fontUrl)).rejects.toBe(failure)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(body.locked).toBe(false)
  })

  it('preserves the size error if cancellation fails', async () => {
    const stream = streamedFont([emptyFont()], String(fontByteLimit + 1))
    stream.cancel.mockRejectedValue(new Error('cancel failed'))
    await expect(loadGsubLigatureFinder(fontUrl)).rejects.toThrow('size limit')
    expect(stream.body.locked).toBe(false)
  })

  it('preserves caller array-view offsets', async () => {
    const bytes = new Uint8Array(30).fill(255)
    bytes.set(emptyFont(), 5)
    await expect(loadGsubLigatureFinder(bytes.subarray(5, 17))).resolves.toBeDefined()
    await expect(loadGsubLigatureFinder(new DataView(bytes.buffer, 5, 12))).resolves.toBeDefined()
  })
})

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
    streamedFont([emptyFont()], String(fontByteLimit + 1))
    await expect(resolveLigatureFinder(true, font, fontUrl)).resolves.toBeDefined()
    streamedFont([emptyFont()], String(fontByteLimit + 1))
    await expect(resolveLigatureFinder({ font: fontUrl }, font)).rejects.toThrow('size limit')
  })
})
