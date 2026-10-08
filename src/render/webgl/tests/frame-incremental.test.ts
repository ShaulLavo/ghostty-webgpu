import { afterEach, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../../core/runtime.js'
import type { ZigFrameBuilder, ZigFrameOptions } from '../../../core/zig-frame.js'
import { fixtureGlyphs } from '../../../core/tests/zig-frame-fixtures.js'
import { defaultRendererTheme } from '../../instances/types.js'

let runtime: GhosttyRuntime | undefined
let builder: ZigFrameBuilder | undefined
let registered = fixtureGlyphs('grayscale')

afterEach(() => {
  builder?.dispose()
  runtime?.dispose()
  builder = undefined
  runtime = undefined
  registered = fixtureGlyphs('grayscale')
})

const options: ZigFrameOptions = {
  cellWidth: 7.3,
  cellHeight: 15.7,
  theme: { ...defaultRendererTheme, cursorText: defaultRendererTheme.background },
  full: true,
  overlayRows: new Set(),
}

function descriptorFor(key: number) {
  return registered.resolveInput(builder!.glyphInput(key))
}

function ready(current: ZigFrameOptions): void {
  let status = builder!.build(current)
  if (status === 2) {
    for (const key of builder!.missingGlyphs) builder!.registerGlyph(key, descriptorFor(key))
    status = builder!.build(current)
  }
  expect(status).toBe(0)
}

function snapshot() {
  return { cells: builder!.cellData.slice(), glyphs: builder!.glyphData.slice() }
}

function verifyUpdate(current: ZigFrameOptions, replay: ReturnType<typeof snapshot>) {
  ready({ ...current, full: false })
  const ranges = builder!.changedRanges()
  for (const update of ranges) {
    const cellOffset = update.cell.byteOffset / 4
    const glyphOffset = update.glyph.byteOffset / 4
    replay.cells.set(
      builder!.cellData.subarray(cellOffset, cellOffset + update.cell.byteLength / 4),
      cellOffset,
    )
    replay.glyphs.set(
      builder!.glyphData.subarray(glyphOffset, glyphOffset + update.glyph.byteLength / 4),
      glyphOffset,
    )
  }
  expect(replay.cells).toEqual(builder!.cellData)
  expect(replay.glyphs).toEqual(builder!.glyphData)
  ready({ ...current, full: true })
  expect(builder!.cellData).toEqual(replay.cells)
  expect(builder!.glyphData).toEqual(replay.glyphs)
  return ranges
}

it.each([
  ['scalar scroll', ['\r\nrow0004 plain']],
  ['wide owner replacement', ['\x1b[1;1H界', '\x1b[1;1Hab']],
  ['wide tail replacement', ['\x1b[1;1H界', '\x1b[1;2Hx']],
  ['combining owner', ['\x1b[1;1Há', '\x1b[1;1Hà']],
  ['styles', ['\x1b[1;1H\x1b[1;3;4;7;9mrow0000\x1b[0m']],
  ['palette', ['\x1b[1;1H\x1b[31mrow0000\x1b[0m', '\x1b]4;1;rgb:00/ff/00\x1b\\']],
  ['scroll region', ['\x1b[2;4r\x1b[4;1H\nrow0004']],
  ['insert line', ['\x1b[2;1H\x1b[L']],
  ['delete line', ['\x1b[2;1H\x1b[M']],
  ['reverse index', ['\x1b[H\x1bMrow0004']],
  ['alternate screen', ['\x1b[?1049hrow0004', '\x1b[?1049l']],
] as const)('keeps dirty buffers and upload ranges exact after %s', async (_name, steps) => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
  const state = runtime.createRenderState(terminal)
  terminal.write('row0000 plain\r\nrow0001 plain\r\nrow0002 plain\r\nrow0003 plain')
  state.update()
  builder = state.createFrameBuilder(24, 4)
  ready(options)
  const replay = snapshot()
  for (const input of steps) {
    state.acknowledge()
    terminal.write(input)
    state.update()
    verifyUpdate(options, replay)
  }
})

it('distinguishes scalar, grapheme, span and style descriptors in native records', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
  const state = runtime.createRenderState(terminal)
  terminal.write('ABéè\x1b[1mA\x1b[0;3mA\x1b[0m界')
  state.update()
  builder = state.createFrameBuilder(24, 4)
  ready(options)
  const descriptors = Array.from({ length: 7 }, (_, x) =>
    JSON.stringify(Array.from(builder!.glyphData.subarray(x * 24 + 2, x * 24 + 8))),
  )
  expect(new Set(descriptors).size).toBe(7)
})

it.each(['stationary', 'forward moved', 'backward moved'] as const)(
  'refreshes re-registered glyph bytes and upload ranges in %s rows',
  async (movement) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
    const state = runtime.createRenderState(terminal)
    const content = {
      stationary: 'AB\r\nBB',
      'forward moved': 'BB\r\nAB',
      'backward moved': 'BB\r\nAB\r\nBB',
    }
    terminal.write(content[movement])
    state.update()
    builder = state.createFrameBuilder(4, 2)
    expect(builder.build(options)).toBe(2)
    const key = builder.missingGlyphs.find((value) => builder!.glyphInput(value).text === 'A')
    expect(key).toBeDefined()
    ready(options)
    const replay = snapshot()
    state.acknowledge()
    const glyph = descriptorFor(key!)
    builder.registerGlyph(key!, {
      ...glyph,
      x: glyph.x + 5,
      y: glyph.y + 7,
      width: glyph.width + 1,
      height: glyph.height + 1,
      offsetX: glyph.offsetX + 1,
      offsetY: glyph.offsetY + 1,
      generation: glyph.generation + 1,
      layer: glyph.layer + 1,
    })
    if (movement === 'forward moved') terminal.write('\r\nBB')
    if (movement === 'backward moved') terminal.scrollBy(-1)
    state.update()
    const ranges = verifyUpdate({ ...options, overlayRows: new Set([0, 1]) }, replay)
    if (movement !== 'stationary') return
    expect(ranges.reduce((bytes, range) => bytes + range.glyph.byteLength, 0)).toBe(96)
    expect(ranges.reduce((bytes, range) => bytes + range.cell.byteLength, 0)).toBe(0)
  },
)

it.each(['block', 'bar', 'underline', 'outline'] as const)(
  'keeps %s cursor, selection and geometry changes exact in dirty scalar rows',
  async (style) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
    const state = runtime.createRenderState(terminal)
    terminal.write(
      'row0000 plain\r\nrow0001 plain\r\nrow0002 plain\r\nrow0003 plain\r\nrow0004 plain',
    )
    state.update()
    builder = state.createFrameBuilder(24, 4)
    ready({ ...options, cursor: { style, visible: true, x: 2, y: 2 } })
    const replay = snapshot()
    for (const step of ['cursor', 'select', 'history', 'clear', 'geometry'] as const) {
      state.acknowledge()
      if (step === 'select') terminal.selectAll()
      if (step === 'history') terminal.scrollBy(-1)
      if (step === 'clear') terminal.clearSelection()
      terminal.write('\x1b[1;1Hrow0000 plain')
      state.update()
      const current = {
        ...options,
        cellHeight: step === 'geometry' ? 31.4 : 15.7,
        cursor: { style, visible: step !== 'clear', x: 3, y: 1 },
        overlayRows: new Set([0, 1, 2, 3]),
      }
      verifyUpdate(current, replay)
    }
  },
)
