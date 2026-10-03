import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGhosttyError } from '../error.js'
import { GhosttyRuntime } from '../runtime.js'
import type { ZigFrameBuilder, ZigFrameOptions } from '../zig-frame.js'
import type { AtlasGlyph } from '../../render/atlas/types.js'
import { InstanceRows } from '../../render/instances/rows.js'
import { defaultRendererTheme } from '../../render/instances/types.js'
import { zigFrameContents, zigFrameCursorStyles } from './zig-frame-fixtures.js'

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
    terminal.write('first\r\nsecond')
    state.update()
    builder = state.createFrameBuilder(12, 3)
    readyFrame()
    state.acknowledge()
    const before = builder.glyphData.slice()
    const reconstructedCells = builder.cellData.slice()
    const reconstructedGlyphs = builder.glyphData.slice()
    builder.registerGlyph('X'.charCodeAt(0), glyph)
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
    expect(builder.missingGlyphs).toContain(88)
    builder.registerGlyph(88, glyph)
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

  it('rejects an entire frame with unsupported unchanged Unicode', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('界')
    state.update()
    builder = state.createFrameBuilder(12, 3)
    expect(builder.build(options)).toBe(1)
    state.acknowledge()
    terminal.write('\x1b[2;1HAScii')
    state.update()
    expect(builder.build({ ...options, full: false })).toBe(1)
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
      if (allocations !== 7) return allocate(length)
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
      builder = state.createFrameBuilder(8, 2)
      const expectedFrees = allocate.mock.calls.map(([length], index) => [
        allocate.mock.results[index]!.value as number,
        length,
      ])
      expect(expectedFrees).toHaveLength(8)
      const free = vi.spyOn(runtime.memory, 'free')
      if (owner === 'builder') builder.dispose()
      if (owner === 'state') state.dispose()
      if (owner === 'runtime') runtime.dispose()
      if (owner !== 'builder') free.mockClear()
      const operations = [
        () => builder!.cellData,
        () => builder!.glyphData,
        () => builder!.missingGlyphs,
        () => builder!.changedRanges(),
        () => builder!.build(options),
        () => builder!.registerGlyph(65, glyph),
        () => builder!.clearGlyphs(),
      ]
      for (const operation of operations) expect(operation).toThrow(/disposed/)
      builder.dispose()
      expect(free.mock.calls).toEqual(expectedFrees)
      free.mockClear()
      builder.dispose()
      expect(free).not.toHaveBeenCalled()
    },
  )

  it.each([2, 3, 4, 5, 6, 7, 8])(
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
      expect(() => state.createFrameBuilder(8, 2)).toThrow(injected)
      expect(free.mock.calls).toEqual(allocations.map(({ pointer, length }) => [pointer, length]))
      spy.mockRestore()
      builder = state.createFrameBuilder(8, 2)
      state.update()
      readyFrame()
    },
  )
})
