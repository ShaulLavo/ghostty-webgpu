import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGhosttyError } from '../error.js'
import { GhosttyRuntime } from '../runtime.js'
import type { ZigFrameBuilder, ZigFrameOptions } from '../zig-frame.js'
import { GlyphAtlas } from '../../render/atlas/atlas.js'
import type {
  AtlasGlyph,
  GlyphRasterizationInput,
  GlyphRasterizer,
} from '../../render/atlas/types.js'
import { buildZigFrame } from '../../render/atlas/zig-glyphs.js'
import { CellFlag, CellOffset, GlyphFlag, GlyphOffset } from '../../render/instances/layout.js'
import { defaultRendererTheme } from '../../render/instances/types.js'
import {
  expectedGlyphs,
  zigFrameContents,
  zigFrameCursorStyles,
  zigGlyphCollisionFixtures,
  zigUnicodeFixtures,
} from './zig-frame-fixtures.js'

let runtime: GhosttyRuntime | undefined
let builder: ZigFrameBuilder | undefined

afterEach(() => {
  builder?.dispose()
  builder = undefined
  runtime?.dispose()
  runtime = undefined
  vi.restoreAllMocks()
})

const bitmap = {
  width: 5,
  height: 9,
  offsetX: 1,
  offsetY: 2,
  kind: 'grayscale' as const,
  pixels: new Uint8Array(45),
}
const glyph: AtlasGlyph = {
  ...bitmap,
  atlasWidth: 512,
  atlasHeight: 512,
  generation: 1,
  key: 'fixture',
  layer: 0,
  x: 8,
  y: 12,
}
const options: ZigFrameOptions = {
  cellWidth: 8,
  cellHeight: 16,
  theme: { ...defaultRendererTheme, cursorText: defaultRendererTheme.background },
  full: true,
  overlayRows: new Set(),
}

function readyFrame(frameOptions = options): void {
  let status = builder!.build(frameOptions)
  if (status === 2) {
    for (const key of builder!.missingGlyphs) builder!.registerGlyph(key, glyph)
    status = builder!.build(frameOptions)
  }
  expect(status).toBe(0)
}

function expectNativeRecords(frame: ZigFrameBuilder): void {
  expect(frame.cellData).toHaveLength(frame.columns * frame.rows * 16)
  expect(frame.glyphData).toHaveLength(frame.columns * frame.rows * 24)
  expect([...frame.cellData, ...frame.glyphData].every(Number.isFinite)).toBe(true)
  expect(frame.missingGlyphs).toEqual([])
  for (let index = 0; index < frame.columns * frame.rows; index += 1) {
    const cell = frame.cellData.subarray(index * 16, index * 16 + 16)
    const painted = cell[11]! > 0 || cell[12]! !== 0 || cell[13]! > 0
    expect([...cell.subarray(0, 4)]).toEqual(
      painted
        ? [(index % frame.columns) * 8, Math.floor(index / frame.columns) * 16, 8, 16]
        : [0, 0, 0, 0],
    )
  }
}

describe('WASM frame records', () => {
  it.each(zigFrameContents)('builds native records for %j', async (content) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 32, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write(content)
    state.update()
    builder = state.createFrameBuilder(32, 3)
    readyFrame()
    expectNativeRecords(builder)
    expect(builder.changedRanges().map((range) => range.row)).toEqual([0, 1, 2])
  })

  it('encodes literal truecolor brushes, decoration bits, atlas coordinates and wide ownership', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 6, rows: 1 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[?25l\x1b[38;2;255;0;0m\x1b[48;2;0;255;0m\x1b[4:2;9;53mA\x1b[0m界')
    state.update()
    builder = state.createFrameBuilder(6, 1)
    readyFrame()
    expect([...builder.cellData.subarray(0, 16)]).toEqual([
      0,
      0,
      8,
      16,
      1,
      0,
      0,
      1,
      0,
      1,
      0,
      1,
      CellFlag.Overline | CellFlag.Strikethrough,
      2,
      0,
      1,
    ])
    expect([...builder.glyphData.subarray(0, 12)]).toEqual([
      1,
      2,
      5,
      9,
      1,
      0,
      0,
      1,
      8 / 512,
      12 / 512,
      13 / 512,
      21 / 512,
    ])
    expect([...builder.glyphData.subarray(20, 23)]).toEqual([0, 1, 0])
    expect(builder.glyphData[24 + GlyphOffset.Meta]).toBe(GlyphFlag.Glyph)
    expect([...builder.glyphData.subarray(48, 72)]).toEqual(Array.from({ length: 24 }, () => 0))
    expect([...builder.cellData.subarray(32, 36)]).toEqual([0, 0, 0, 0])
  })

  it.each(zigFrameCursorStyles)('encodes a %s cursor', async (style) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('ABC')
    state.update()
    builder = state.createFrameBuilder(8, 2)
    const cursor = { style, visible: true, x: 1, y: 0 }
    readyFrame({ ...options, cursor })
    expect(builder.cellData[16 + CellOffset.Meta]! & CellFlag.Cursor).toBe(CellFlag.Cursor)
    expect(builder.cellData[16 + CellOffset.Meta + 2]).toBe(zigFrameCursorStyles.indexOf(style))
    expectNativeRecords(builder)
  })

  it('retains clean rows, reports changed ranges, and refreshes memory views after growth', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('firstX\r\nsecond')
    state.update()
    builder = state.createFrameBuilder(12, 3)
    readyFrame()
    state.acknowledge()
    const before = builder.glyphData.slice()
    const reconstructedCells = builder.cellData.slice()
    const reconstructedGlyphs = builder.glyphData.slice()
    runtime.exports.memory.grow(1)
    terminal.write('\x1b[2;6H\x1b[31mX')
    state.update()
    readyFrame({ ...options, full: false })
    expect(builder.changedRanges()).toEqual([
      {
        row: 1,
        cell: { byteOffset: (12 + 5) * 64, byteLength: 64 },
        glyph: { byteOffset: (12 + 5) * 96, byteLength: 96 },
      },
    ])
    for (const update of builder.changedRanges()) {
      const cellStart = update.cell.byteOffset / 4
      const glyphStart = update.glyph.byteOffset / 4
      reconstructedCells.set(
        builder.cellData.subarray(cellStart, cellStart + update.cell.byteLength / 4),
        cellStart,
      )
      reconstructedGlyphs.set(
        builder.glyphData.subarray(glyphStart, glyphStart + update.glyph.byteLength / 4),
        glyphStart,
      )
    }
    expect(reconstructedCells).toEqual(builder.cellData)
    expect(reconstructedGlyphs).toEqual(builder.glyphData)
    expect(builder.glyphData.slice(0, 12 * 24)).toEqual(before.slice(0, 12 * 24))
    state.acknowledge()
    state.update()
    expect(builder.build({ ...options, full: false })).toBe(0)
    expect(builder.changedRanges()).toEqual([])
    readyFrame({ ...options, full: false, overlayRows: new Set([2]) })
    expect(builder.changedRanges()).toEqual([
      {
        row: 2,
        cell: { byteOffset: 2 * 12 * 64, byteLength: 0 },
        glyph: { byteOffset: 2 * 12 * 96, byteLength: 0 },
      },
    ])
  })

  it.each([0, 1])(
    'reports concealed text changes in logical row %s without GPU uploads',
    async (row) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
      const state = runtime.createRenderState(terminal)
      const position = `\x1b[${row + 1};1H`
      terminal.write(`\x1b[?25l${position}\x1b[8mA${position}`)
      state.update()
      builder = state.createFrameBuilder(8, 2)
      readyFrame()
      expect(state.readTextRows({ rows: new Set([row]) })[0]!.cells[0]).toBe('A')
      const previousCells = builder.cellData.slice()
      const previousGlyphs = builder.glyphData.slice()
      state.acknowledge()

      terminal.write(`B${position}`)
      state.update()
      expect(state.readRows({ dirtyOnly: true }).map((value) => value.y)).toEqual([row])
      expect(state.readTextRows({ rows: new Set([row]) })[0]!.cells[0]).toBe('B')
      readyFrame({ ...options, full: false })
      expect(builder.cellData).toEqual(previousCells)
      expect(builder.glyphData).toEqual(previousGlyphs)
      expect(builder.changedRanges()).toEqual([
        {
          row,
          cell: { byteOffset: row * 8 * 64, byteLength: 0 },
          glyph: { byteOffset: row * 8 * 96, byteLength: 0 },
        },
      ])
    },
  )

  it('preserves changed cell bytes through a new-glyph retry', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('old')
    state.update()
    builder = state.createFrameBuilder(8, 2)
    readyFrame()
    state.acknowledge()
    terminal.write('\x1b[2;1H\x1b[31mX')
    state.update()
    const dirtyRows = state.readRows({ dirtyOnly: true })
    expect(builder.build({ ...options, full: false })).toBe(2)
    expect(builder.missingGlyphs.map((key) => builder!.glyphInput(key).text)).toContain('X')
    for (const key of builder.missingGlyphs) builder.registerGlyph(key, glyph)
    expect(builder.build({ ...options, full: false })).toBe(0)
    expect(builder.changedRanges()).toEqual(
      dirtyRows.map((row) => ({
        row: row.y,
        cell: { byteOffset: row.y * 8 * 64, byteLength: 8 * 64 },
        glyph: { byteOffset: row.y * 8 * 96, byteLength: 8 * 96 },
      })),
    )
    expectNativeRecords(builder)
  })

  it('retains clean wide Unicode while another row changes', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('界')
    state.update()
    builder = state.createFrameBuilder(12, 3)
    readyFrame()
    const firstRow = builder.glyphData.slice(0, 12 * 24)
    state.acknowledge()
    terminal.write('\x1b[2;1HAScii')
    state.update()
    readyFrame({ ...options, full: false })
    expect(builder.glyphData.slice(0, 12 * 24)).toEqual(firstRow)
    expect(
      builder
        .changedRanges()
        .filter((range) => range.cell.byteLength || range.glyph.byteLength)
        .map((range) => range.row),
    ).toEqual([0, 1])
    expect(
      builder
        .changedRanges()
        .reduce((bytes, range) => bytes + range.cell.byteLength + range.glyph.byteLength, 0),
    ).toBe(2 * 12 * (64 + 96))
  })
})

function inputIdentity(input: GlyphRasterizationInput): string {
  return JSON.stringify([
    input.text,
    input.cellSpan,
    input.weight,
    input.italic,
    input.foreground.r,
    input.foreground.g,
    input.foreground.b,
  ])
}

function expectGlyphDescriptors(
  frame: ZigFrameBuilder,
  inputs: readonly GlyphRasterizationInput[],
) {
  const descriptors = frame.missingGlyphs.map((key) => inputIdentity(frame.glyphInput(key)))
  expect([...new Set(descriptors)]).toEqual([...new Set(inputs.map(inputIdentity))])
}

function fixtureGlyphs(kind: 'color' | 'grayscale') {
  const glyphs = new Map<string, AtlasGlyph>()
  const identityOf = (input: GlyphRasterizationInput) =>
    kind === 'color'
      ? inputIdentity(input)
      : JSON.stringify([input.text, input.cellSpan, input.weight, input.italic])
  const resolveInput = (input: GlyphRasterizationInput): AtlasGlyph => {
    const identity = identityOf(input)
    const existing = glyphs.get(identity)
    if (existing) return existing
    const index = glyphs.size + 1
    const value: AtlasGlyph = {
      ...glyph,
      kind,
      key: identity,
      x: index * 7,
      y: index * 11,
      width: 3 + index,
      height: 5 + index,
    }
    glyphs.set(identity, value)
    return value
  }
  return {
    glyphs,
    identityOf,
    resolveInput,
  }
}

describe('WASM Unicode descriptors and native records', () => {
  it.each(['color', 'grayscale'] as const)(
    'packs cold %s brush variants in viewport order',
    async (kind) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write(
        '\x1b[?25l\x1b[38;2;255;0;0mA\x1b[38;2;0;255;0mA\x1b[38;2;255;0;0mB\x1b[38;2;0;255;0mB',
      )
      state.update()
      builder = state.createFrameBuilder(4, 1)
      const frameOptions = { ...options, theme: { ...options.theme, minimumContrast: 1 } }
      const rasterizer: GlyphRasterizer = {
        rasterize(input) {
          const height = input.text === 'A' ? 3 : 1
          const channels = kind === 'color' ? 4 : 1
          const pixels = new Uint8Array(2 * height * channels).fill(255)
          if (kind === 'color') {
            for (let offset = 0; offset < pixels.length; offset += 4)
              pixels.set([input.foreground.r, input.foreground.g, input.foreground.b, 255], offset)
          }
          return { width: 2, height, offsetX: 0, offsetY: 0, pixels, kind }
        },
      }
      const atlasOptions = { pageWidth: 4, pageHeight: 4, padding: 0, maxLayersPerKind: 1 }
      const nativeAtlas = new GlyphAtlas(atlasOptions)
      expect(builder.build(frameOptions)).toBe(2)
      expect(
        builder.missingGlyphs.map((key) => {
          const input = builder!.glyphInput(key)
          return [input.text, input.foreground]
        }),
      ).toEqual([
        ['A', { r: 255, g: 0, b: 0 }],
        ['A', { r: 0, g: 255, b: 0 }],
        ['B', { r: 255, g: 0, b: 0 }],
        ['B', { r: 0, g: 255, b: 0 }],
      ])
      const builds = vi.spyOn(builder, 'build')
      expect(buildZigFrame(builder, nativeAtlas, rasterizer, frameOptions)).toBe(0)
      expect(builds.mock.results.map((result) => result.value)).toEqual([2, 0])
      expect(builder.missingGlyphs).toEqual([])
      expect(nativeAtlas.pageCount).toBe(1)
      expect(nativeAtlas.evictionCount).toBe(0)
      expect(nativeAtlas.cacheMissCount).toBe(kind === 'color' ? 4 : 2)
      expectNativeRecords(builder)
      state.acknowledge()
      if (kind === 'color') return
      const descriptors = builder.glyphCount
      for (let index = 0; index < 64; index += 1) {
        terminal.write(`\x1b[1;1H\x1b[38;2;${index};91;173mAABB`)
        state.update()
        expect(
          buildZigFrame(builder, nativeAtlas, rasterizer, { ...frameOptions, full: false }),
        ).toBe(0)
        expect(builder.missingGlyphs).toEqual([])
        expect(builder.glyphCount).toBe(descriptors)
        expect(builder.glyphIndexRebuilds).toBe(0)
        expect(nativeAtlas.cacheMissCount).toBe(2)
        expect(nativeAtlas.evictionCount).toBe(0)
        expectNativeRecords(builder)
        state.acknowledge()
      }
    },
  )

  it.each(
    [...zigUnicodeFixtures, ...zigGlyphCollisionFixtures].flatMap((fixture) =>
      (['grayscale', 'color'] as const).map((kind) => ({ ...fixture, kind })),
    ),
  )('matches distinct $kind atlas records for $name', async ({ content, kind }) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write(`\x1b[?25l\x1b[?2027h${content}`)
    state.update()
    builder = state.createFrameBuilder(40, 3)
    const frameOptions = { ...options, theme: { ...options.theme, minimumContrast: 4.5 } }
    const registered = fixtureGlyphs(kind)
    const expected = expectedGlyphs(state.readRows(), frameOptions.theme)
    expect(expected.length).toBeGreaterThan(0)
    expect(builder.build(frameOptions)).toBe(2)
    expectGlyphDescriptors(
      builder,
      expected.map(({ input }) => input),
    )
    let status = 2
    for (let attempt = 0; attempt < 3 && status === 2; attempt += 1) {
      const keys = [...builder.missingGlyphs]
      expect(new Set(keys).size).toBe(keys.length)
      for (const key of keys) {
        const input = builder.glyphInput(key)
        builder.registerGlyph(key, registered.resolveInput(input))
      }
      status = builder.build(frameOptions)
    }
    expect(status).toBe(0)
    expectNativeRecords(builder)
    expect(builder.missingGlyphs).toEqual([])
    expect(registered.glyphs.size).toBe(
      new Set(expected.map(({ input }) => registered.identityOf(input))).size,
    )
    for (const { x, y, input } of expected) {
      const atlasGlyph = registered.glyphs.get(registered.identityOf(input))
      expect(atlasGlyph, inputIdentity(input)).toBeDefined()
      const offset = (y * 40 + x) * 24
      const record = builder.glyphData.subarray(offset, offset + 24)
      expect(record.slice(0, 4)).toEqual(
        new Float32Array([
          x * 8 + atlasGlyph!.offsetX,
          y * 16 + atlasGlyph!.offsetY,
          atlasGlyph!.width,
          atlasGlyph!.height,
        ]),
      )
      expect(record.slice(8, 12)).toEqual(
        new Float32Array([
          atlasGlyph!.x / atlasGlyph!.atlasWidth,
          atlasGlyph!.y / atlasGlyph!.atlasHeight,
          (atlasGlyph!.x + atlasGlyph!.width) / atlasGlyph!.atlasWidth,
          (atlasGlyph!.y + atlasGlyph!.height) / atlasGlyph!.atlasHeight,
        ]),
      )
      expect(record[GlyphOffset.Meta]).toBe(GlyphFlag.Glyph)
      expect(record.slice(20, 23)).toEqual(
        new Float32Array([atlasGlyph!.layer, atlasGlyph!.generation, kind === 'color' ? 1 : 0]),
      )
      if (input.cellSpan === 2)
        expect(builder.glyphData.slice(offset + 24, offset + 48)).toEqual(new Float32Array(24))
    }
  })

  it.each(['AÁŁ', 'e é è ȩ́'])(
    'rejects aliased descriptors for %s using the independent styled reader',
    async (content) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 12, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write(`\x1b[?25l${content}`)
      state.update()
      builder = state.createFrameBuilder(12, 1)
      expect(builder.build(options)).toBe(2)
      const expected = expectedGlyphs(state.readRows(), options.theme).map(({ input }) => input)
      expectGlyphDescriptors(builder, expected)
      const glyphInput = builder.glyphInput.bind(builder)
      vi.spyOn(builder, 'glyphInput').mockImplementation((key) => {
        const input = glyphInput(key)
        return { ...input, text: String.fromCodePoint(input.text.codePointAt(0)! & 0x7f) }
      })
      expect(() => expectGlyphDescriptors(builder!, expected)).toThrow()
    },
  )

  it.each(zigFrameCursorStyles.flatMap((style) => [0, 1].map((x) => ({ style, x }))))(
    'encodes selection and $style cursor on CJK column $x',
    async ({ style, x }) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 12, rows: 2 })
      const state = runtime.createRenderState(terminal)
      terminal.write('界é👩‍💻')
      expect(terminal.selectAll()).toBe(true)
      state.update()
      expect(state.readRows()[0]!.cells.some((cell) => cell.selected)).toBe(true)
      builder = state.createFrameBuilder(12, 2)
      const cursor = { style, visible: true, x, y: 0 }
      readyFrame({ ...options, cursor })
      expect(builder.cellData[x * 16 + CellOffset.Meta]! & CellFlag.Cursor).toBe(CellFlag.Cursor)
      expect(builder.cellData[x * 16 + CellOffset.Meta + 2]).toBe(
        zigFrameCursorStyles.indexOf(style),
      )
      expect(builder.cellData[CellOffset.Background + 3]).toBe(1)
      expect(builder.glyphData[24 + GlyphOffset.Meta]! & GlyphFlag.Glyph).toBe(0)
      expectNativeRecords(builder)
    },
  )

  it('keeps grayscale descriptor count and WASM memory flat while rotating truecolor brushes', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[?25lA')
    state.update()
    builder = state.createFrameBuilder(4, 2)
    readyFrame()
    state.acknowledge()
    let warmedBytes = 0
    for (let index = 0; index < 2048; index += 1) {
      const red = index & 255
      const green = (index >>> 8) & 255
      const blue = (index * 17) & 255
      terminal.write(`\x1b[1;1H\x1b[38;2;${red};${green};${blue}mA`)
      state.update()
      expect(builder.build({ ...options, full: false })).toBe(0)
      expect(builder.missingGlyphs).toEqual([])
      expect(builder.glyphCount).toBe(1)
      expect(builder.glyphIndexRebuilds).toBe(0)
      state.acknowledge()
      if (index === 1023) warmedBytes = runtime.memory.bytes.byteLength
    }
    expect(runtime.memory.bytes.byteLength).toBe(warmedBytes)
    expectNativeRecords(builder)
  })

  it('bounds brush-sensitive color descriptors and recovers full native bytes after rebuilding the index', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 2, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[?25lM\x1b[2;1H_')
    state.update()
    builder = state.createFrameBuilder(2, 2)
    const registered = fixtureGlyphs('color')
    for (let index = 0; index < 512; index += 1) {
      terminal.write(`\x1b[1;1H\x1b[38;2;${index & 255};${index >>> 8};91mM`)
      state.update()
      const frameOptions = { ...options, full: index === 0 }
      expect(builder.build(frameOptions)).toBe(2)
      let status = 2
      for (let attempt = 0; attempt < 3 && status === 2; attempt += 1) {
        for (const key of builder.missingGlyphs)
          builder.registerGlyph(key, registered.resolveInput(builder.glyphInput(key)))
        status = builder.build(frameOptions)
      }
      expect(status).toBe(0)
      expectNativeRecords(builder)
      expect(builder.glyphCount).toBeLessThanOrEqual(2 * 2 * 8)
      state.acknowledge()
    }
    expect(builder.glyphIndexRebuilds).toBeGreaterThan(0)
    expectNativeRecords(builder)
  })

  it('deduplicates repeated misses while growing beyond 128 Unicode keys and refreshing memory views', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 40, rows: 10 })
    const state = runtime.createRenderState(terminal)
    const texts = Array.from({ length: 180 }, (_, index) => String.fromCodePoint(0x4e00 + index))
    terminal.write(`\x1b[?25l${[...texts, ...texts].join('')}`)
    state.update()
    builder = state.createFrameBuilder(40, 10)
    expect(builder.build(options)).toBe(2)
    const keys = [...builder.missingGlyphs]
    expect(keys).toHaveLength(180)
    expect(new Set(keys).size).toBe(180)
    expect(keys.map((key) => builder!.glyphInput(key).text).sort()).toEqual([...texts].sort())
    const registered = fixtureGlyphs('grayscale')
    for (const key of keys.slice(0, 90))
      builder.registerGlyph(key, registered.resolveInput(builder.glyphInput(key)))
    runtime.exports.memory.grow(1)
    for (const key of keys.slice(90))
      builder.registerGlyph(key, registered.resolveInput(builder.glyphInput(key)))
    expect(builder.build(options)).toBe(0)
    expectNativeRecords(builder)
    state.acknowledge()
    terminal.write('\x1b[1;1H\x1b[?2027hé👩‍💻')
    state.update()
    expect(builder.build({ ...options, full: false })).toBe(2)
    expect(builder.missingGlyphs.map((key) => builder!.glyphInput(key).text)).toEqual(
      expect.arrayContaining(['é', '👩‍💻']),
    )
    for (const key of builder.missingGlyphs)
      builder.registerGlyph(key, registered.resolveInput(builder.glyphInput(key)))
    expect(builder.build({ ...options, full: false })).toBe(0)
    expectNativeRecords(builder)
  })

  it('preserves wide and grapheme row damage through multiple missing-glyph retries', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('old\r\nuntouched\r\nlast')
    state.update()
    builder = state.createFrameBuilder(12, 3)
    readyFrame()
    state.acknowledge()
    const before = builder.glyphData.slice()
    terminal.write('\x1b[?2027h\x1b[1;1H\x1b[31;44m界é👩‍💻')
    state.update()
    const frameOptions = { ...options, full: false }
    expect(builder.build(frameOptions)).toBe(2)
    const keys = [...builder.missingGlyphs]
    const inputs = keys.map((key) => builder!.glyphInput(key))
    expect(inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: '界', cellSpan: 2 }),
        expect.objectContaining({ text: 'é', cellSpan: 1 }),
        expect.objectContaining({ text: '👩‍💻', cellSpan: 2 }),
      ]),
    )
    builder.registerGlyph(keys[0]!, glyph)
    expect(builder.build(frameOptions)).toBe(2)
    expect(builder.missingGlyphs).not.toContain(keys[0])
    for (const key of builder.missingGlyphs) builder.registerGlyph(key, glyph)
    expect(builder.build(frameOptions)).toBe(0)
    expect(
      builder
        .changedRanges()
        .filter((range) => range.cell.byteLength || range.glyph.byteLength)
        .map((range) => range.row),
    ).toEqual([0, 2])
    expect(
      builder
        .changedRanges()
        .reduce((bytes, range) => bytes + range.cell.byteLength + range.glyph.byteLength, 0),
    ).toBe(2 * 12 * (64 + 96))
    expect(builder.glyphData.slice(12 * 24)).toEqual(before.slice(12 * 24))
    expectNativeRecords(builder)
  })
})

describe('WASM frame ownership and row bounds', () => {
  it.each([true, false])('ignores overlay rows outside the mask (full=%s)', async (full) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
    const state = runtime.createRenderState(terminal)
    state.update()
    const memory = runtime.memory
    const allocate = memory.allocate.bind(memory)
    const free = memory.free.bind(memory)
    let maskBase = 0
    let allocations = 0
    vi.spyOn(memory, 'allocate').mockImplementation((length) => {
      allocations += 1
      if (allocations !== 6) return allocate(length)
      // Keep both mask-boundary canaries inside a test-owned allocation.
      maskBase = allocate(length + 2)
      return maskBase + 1
    })
    vi.spyOn(memory, 'free').mockImplementation((pointer, length) => {
      if (pointer === maskBase + 1) return free(maskBase, length + 2)
      free(pointer, length)
    })
    builder = state.createFrameBuilder(8, 2)
    const mask = maskBase + 1
    const canary = memory.allocate(1024)
    try {
      memory.bytes[mask - 1] = 173
      memory.bytes[mask + 2] = 173
      memory.bytes.fill(173, canary, canary + 1024)
      readyFrame({ ...options, full, overlayRows: new Set([-1, 0, 2, canary - mask + 999]) })
      expect(memory.bytes[mask - 1]).toBe(173)
      expect(memory.bytes[mask + 2]).toBe(173)
      expect(runtime.memory.bytes.slice(canary, canary + 1024)).toEqual(
        new Uint8Array(1024).fill(173),
      )
      expect(runtime.memory.bytes[mask]).toBe(1)
    } finally {
      runtime.memory.free(canary, 1024)
    }
  })

  it.each(['builder', 'state', 'runtime'] as const)(
    'rejects every operation after %s disposal',
    async (owner) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
      const state = runtime.createRenderState(terminal)
      state.update()
      const allocate = vi.spyOn(runtime.memory, 'allocate')
      const createIndex = vi.spyOn(runtime.bridge, 'createGlyphIndex')
      const freeIndex = vi.spyOn(runtime.bridge, 'destroyGlyphIndex')
      builder = state.createFrameBuilder(8, 2)
      const expectedFrees = allocate.mock.calls.map(([length], index) => [
        allocate.mock.results[index]!.value as number,
        length,
      ])
      expect(expectedFrees).toHaveLength(7)
      const free = vi.spyOn(runtime.memory, 'free')
      if (owner === 'builder') builder.dispose()
      if (owner === 'state') state.dispose()
      if (owner === 'runtime') runtime.dispose()
      if (owner !== 'builder') free.mockClear()
      const operations = [
        () => builder!.cellData,
        () => builder!.glyphData,
        () => builder!.missingGlyphs,
        () => builder!.glyphCount,
        () => builder!.glyphIndexRebuilds,
        () => builder!.glyphInput(0),
        () => builder!.changedRanges(),
        () => builder!.build(options),
        () => builder!.registerGlyph(65, glyph),
        () => builder!.clearGlyphs(),
      ]
      for (const operation of operations) expect(operation).toThrow(/disposed/)
      builder.dispose()
      expect(free.mock.calls).toEqual(expectedFrees)
      expect(freeIndex.mock.calls).toEqual([[createIndex.mock.results[0]!.value]])
      free.mockClear()
      freeIndex.mockClear()
      builder.dispose()
      expect(free).not.toHaveBeenCalled()
      expect(freeIndex).not.toHaveBeenCalled()
    },
  )

  it.each([2, 3, 4, 5, 6, 7])(
    'frees partial allocations when allocation %s fails',
    async (failure) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
      const state = runtime.createRenderState(terminal)
      const memory = runtime.memory
      const allocations: { pointer: number; length: number }[] = []
      const allocate = memory.allocate.bind(memory)
      const injected = createGhosttyError('ghostty_wasm_alloc', 'Injected allocation failure')
      const spy = vi.spyOn(memory, 'allocate').mockImplementation((length) => {
        if (allocations.length === failure - 1) throw injected
        const pointer = allocate(length)
        allocations.push({ pointer, length })
        return pointer
      })
      const free = vi.spyOn(memory, 'free')
      const createIndex = vi.spyOn(runtime.bridge, 'createGlyphIndex')
      const freeIndex = vi.spyOn(runtime.bridge, 'destroyGlyphIndex')
      expect(() => state.createFrameBuilder(8, 2)).toThrow(injected)
      expect(free.mock.calls).toEqual(allocations.map(({ pointer, length }) => [pointer, length]))
      expect(freeIndex.mock.calls).toEqual(createIndex.mock.results.map(({ value }) => [value]))
      spy.mockRestore()
      builder = state.createFrameBuilder(8, 2)
      state.update()
      readyFrame()
    },
  )
})
