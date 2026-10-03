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
import { InstanceRows } from '../../render/instances/rows.js'
import { defaultRendererTheme } from '../../render/instances/types.js'
import {
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

describe('WASM frame differential parity', () => {
  it.each(zigFrameContents)('matches JS instance bytes for %j', async (content) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 32, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write(content)
    state.update()
    builder = state.createFrameBuilder(32, 3)
    readyFrame()
    const js = new InstanceRows({ columns: 32, rows: 3, cellWidth: 8, cellHeight: 16 })
    const updates = state
      .readRows()
      .map((row) =>
        js.rebuildRow(
          row,
          { beginRow() {}, resolve: () => ({ glyph, invalidatedRows: [] }) },
          { rasterize: () => bitmap },
          options.theme,
        ),
      )
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
    expect(builder.changedRanges()).toEqual(updates)
  })

  it.each(zigFrameCursorStyles)('matches the JS %s cursor', async (style) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('ABC')
    state.update()
    builder = state.createFrameBuilder(8, 2)
    const cursor = { style, visible: true, x: 1, y: 0 }
    readyFrame({ ...options, cursor })
    const js = new InstanceRows({ columns: 8, rows: 2, cellWidth: 8, cellHeight: 16 })
    for (const row of state.readRows())
      js.rebuildRow(
        row,
        { beginRow() {}, resolve: () => ({ glyph, invalidatedRows: [] }) },
        { rasterize: () => bitmap },
        options.theme,
        cursor,
      )
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
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
        invalidatedRows: [],
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
    const js = new InstanceRows({ columns: 12, rows: 3, cellWidth: 8, cellHeight: 16 })
    for (const row of state.readRows())
      js.rebuildRow(
        row,
        { beginRow() {}, resolve: () => ({ glyph, invalidatedRows: [] }) },
        { rasterize: () => bitmap },
        options.theme,
      )
    expect(reconstructedCells).toEqual(js.cellData)
    expect(reconstructedGlyphs).toEqual(js.glyphData)
    expect(builder.glyphData.slice(0, 12 * 24)).toEqual(before.slice(0, 12 * 24))
    state.acknowledge()
    state.update()
    expect(builder.build({ ...options, full: false })).toBe(0)
    expect(builder.changedRanges()).toEqual([])
    readyFrame({ ...options, full: false, overlayRows: new Set([2]) })
    expect(builder.changedRanges()).toEqual([
      {
        row: 2,
        invalidatedRows: [],
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
          invalidatedRows: [],
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
        invalidatedRows: [],
        cell: { byteOffset: row.y * 8 * 64, byteLength: 8 * 64 },
        glyph: { byteOffset: row.y * 8 * 96, byteLength: 8 * 96 },
      })),
    )
    const js = new InstanceRows({ columns: 8, rows: 2, cellWidth: 8, cellHeight: 16 })
    for (const row of state.readRows())
      js.rebuildRow(
        row,
        { beginRow() {}, resolve: () => ({ glyph, invalidatedRows: [] }) },
        { rasterize: () => bitmap },
        options.theme,
      )
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
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

function differentialGlyphs(kind: 'color' | 'grayscale') {
  const glyphs = new Map<string, AtlasGlyph>()
  const observed: string[] = []
  let current = glyph
  const resolveInput = (input: GlyphRasterizationInput): AtlasGlyph => {
    const identity =
      kind === 'color'
        ? inputIdentity(input)
        : JSON.stringify([input.text, input.cellSpan, input.weight, input.italic])
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
    inputs: observed,
    glyphs,
    resolveInput,
    source: {
      rasterize(input: GlyphRasterizationInput) {
        observed.push(inputIdentity(input))
        current = resolveInput(input)
        return { ...bitmap, kind }
      },
    },
    lookup: {
      beginRow() {},
      resolve: () => ({ glyph: current, invalidatedRows: [] }),
    },
  }
}

describe('WASM Unicode descriptors and differential instance bytes', () => {
  it.each(['color', 'grayscale'] as const)(
    'packs cold %s brush variants in viewport order and preserves JS atlas parity',
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
      const jsAtlas = new GlyphAtlas(atlasOptions)
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
      const js = new InstanceRows({ columns: 4, rows: 1, cellWidth: 8, cellHeight: 16 })
      const expectInstances = () => {
        for (const row of state.readRows())
          js.rebuildRow(
            row,
            {
              beginRow: (row) => jsAtlas.beginRow(row),
              resolve: (key, bitmap, row) => jsAtlas.getOrInsert(key, bitmap, row),
            },
            rasterizer,
            frameOptions.theme,
          )
        expect(builder!.cellData).toEqual(js.cellData)
        expect(builder!.glyphData).toEqual(js.glyphData)
        expect(jsAtlas.pageCount).toBe(1)
        expect(jsAtlas.evictionCount).toBe(0)
      }
      expectInstances()
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
        expectInstances()
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
    const differential = differentialGlyphs(kind)
    expect(builder.build(frameOptions)).toBe(2)
    const inputs: GlyphRasterizationInput[] = []
    let status = 2
    for (let attempt = 0; attempt < 3 && status === 2; attempt += 1) {
      const keys = [...builder.missingGlyphs]
      expect(new Set(keys).size).toBe(keys.length)
      for (const key of keys) {
        const input = builder.glyphInput(key)
        inputs.push(input)
        builder.registerGlyph(key, differential.resolveInput(input))
      }
      status = builder.build(frameOptions)
    }
    expect(status).toBe(0)
    const js = new InstanceRows({ columns: 40, rows: 3, cellWidth: 8, cellHeight: 16 })
    for (const row of state.readRows())
      js.rebuildRow(row, differential.lookup, differential.source, frameOptions.theme)
    const identity =
      kind === 'color'
        ? inputIdentity
        : (input: GlyphRasterizationInput) =>
            JSON.stringify([input.text, input.cellSpan, input.weight, input.italic])
    expect(new Set(inputs.map(identity))).toEqual(new Set(differential.glyphs.keys()))
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
    expect(builder.missingGlyphs).toEqual([])
  })

  it.each(zigFrameCursorStyles.flatMap((style) => [0, 1].map((x) => ({ style, x }))))(
    'matches selection and $style cursor on CJK column $x',
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
      const js = new InstanceRows({ columns: 12, rows: 2, cellWidth: 8, cellHeight: 16 })
      for (const row of state.readRows())
        js.rebuildRow(
          row,
          { beginRow() {}, resolve: () => ({ glyph, invalidatedRows: [] }) },
          { rasterize: () => bitmap },
          options.theme,
          cursor,
        )
      expect(builder.cellData).toEqual(js.cellData)
      expect(builder.glyphData).toEqual(js.glyphData)
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
    const js = new InstanceRows({ columns: 4, rows: 2, cellWidth: 8, cellHeight: 16 })
    for (const row of state.readRows())
      js.rebuildRow(
        row,
        { beginRow() {}, resolve: () => ({ glyph, invalidatedRows: [] }) },
        { rasterize: () => bitmap },
        options.theme,
      )
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
  })

  it('bounds brush-sensitive color descriptors and recovers full native bytes after rebuilding the index', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 2, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('\x1b[?25lM\x1b[2;1H_')
    state.update()
    builder = state.createFrameBuilder(2, 2)
    const differential = differentialGlyphs('color')
    for (let index = 0; index < 512; index += 1) {
      terminal.write(`\x1b[1;1H\x1b[38;2;${index & 255};${index >>> 8};91mM`)
      state.update()
      const frameOptions = { ...options, full: index === 0 }
      expect(builder.build(frameOptions)).toBe(2)
      let status = 2
      for (let attempt = 0; attempt < 3 && status === 2; attempt += 1) {
        for (const key of builder.missingGlyphs)
          builder.registerGlyph(key, differential.resolveInput(builder.glyphInput(key)))
        status = builder.build(frameOptions)
      }
      expect(status).toBe(0)
      const js = new InstanceRows({ columns: 2, rows: 2, cellWidth: 8, cellHeight: 16 })
      for (const row of state.readRows())
        js.rebuildRow(row, differential.lookup, differential.source, options.theme)
      expect(builder.cellData).toEqual(js.cellData)
      expect(builder.glyphData).toEqual(js.glyphData)
      expect(builder.glyphCount).toBeLessThanOrEqual(2 * 2 * 8)
      state.acknowledge()
    }
    expect(builder.glyphIndexRebuilds).toBeGreaterThan(0)
    const js = new InstanceRows({ columns: 2, rows: 2, cellWidth: 8, cellHeight: 16 })
    for (const row of state.readRows())
      js.rebuildRow(row, differential.lookup, differential.source, options.theme)
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
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
    const differential = differentialGlyphs('grayscale')
    for (const key of keys.slice(0, 90))
      builder.registerGlyph(key, differential.resolveInput(builder.glyphInput(key)))
    runtime.exports.memory.grow(1)
    for (const key of keys.slice(90))
      builder.registerGlyph(key, differential.resolveInput(builder.glyphInput(key)))
    expect(builder.build(options)).toBe(0)
    const js = new InstanceRows({ columns: 40, rows: 10, cellWidth: 8, cellHeight: 16 })
    for (const row of state.readRows())
      js.rebuildRow(row, differential.lookup, differential.source, options.theme)
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
    state.acknowledge()
    terminal.write('\x1b[1;1H\x1b[?2027hé👩‍💻')
    state.update()
    expect(builder.build({ ...options, full: false })).toBe(2)
    expect(builder.missingGlyphs.map((key) => builder!.glyphInput(key).text)).toEqual(
      expect.arrayContaining(['é', '👩‍💻']),
    )
    for (const key of builder.missingGlyphs)
      builder.registerGlyph(key, differential.resolveInput(builder.glyphInput(key)))
    expect(builder.build({ ...options, full: false })).toBe(0)
    for (const row of state.readRows())
      js.rebuildRow(row, differential.lookup, differential.source, options.theme)
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
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
    const js = new InstanceRows({ columns: 12, rows: 3, cellWidth: 8, cellHeight: 16 })
    for (const row of state.readRows())
      js.rebuildRow(
        row,
        { beginRow() {}, resolve: () => ({ glyph, invalidatedRows: [] }) },
        { rasterize: () => bitmap },
        options.theme,
      )
    expect(builder.cellData).toEqual(js.cellData)
    expect(builder.glyphData).toEqual(js.glyphData)
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
