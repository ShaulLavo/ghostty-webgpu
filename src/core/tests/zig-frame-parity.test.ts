import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { bidiProjection, RowBidiMapper } from '../../bidi/row.js'
import { GlyphAtlas } from '../../render/shared/atlas/atlas.js'
import type { GlyphRasterizer } from '../../render/shared/atlas/types.js'
import { buildZigFrame } from '../../render/shared/atlas/zig-glyphs.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../../render/shared/config.js'
import { GLYPH_INSTANCE_FLOATS, GlyphOffset } from '../../render/shared/instances/layout.js'
import { defaultRendererTheme } from '../../render/shared/instances/types.js'
import { GhosttyRuntime } from '../runtime.js'
import { GhosttySelectionGesture } from '../selection.js'
import type { ZigFrameOptions } from '../zig-frame.js'
import { fixtureGlyphs } from './zig-frame-fixtures.js'

// The bridge from main before the plain-cell cache (sha256 42c56087…). Delete this suite and
// the fixture when the bridge ABI changes; until then every frame must match it byte for byte.
const previousBridge = new URL('./fixtures/bridge-before-plain-cells.wasm', import.meta.url)
const wasm = new URL('../../../ghostty-vt.wasm', import.meta.url)

const runtimes: GhosttyRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

async function runtimeFor(bridge: 'previous' | 'current'): Promise<GhosttyRuntime> {
  const runtime = await GhosttyRuntime.create({
    wasm: await readFile(wasm),
    ...(bridge === 'previous' ? { bridge: await readFile(previousBridge) } : {}),
  })
  runtimes.push(runtime)
  return runtime
}

const theme = canonicalRendererTheme(mergeRendererTheme(undefined))
const adjustedTheme = {
  ...theme,
  foreground: { r: 57, g: 69, b: 81 },
  background: { r: 62, g: 70, b: 80 },
  minimumContrast: 4.5,
}

type Mode = 'unstable' | 'stable' | 'ligatures' | 'bidi'
type Kind = 'grayscale' | 'color'

function bytes(view: Float32Array): number[] {
  return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
}

async function recordFrames(bridge: 'previous' | 'current', mode: Mode, kind: Kind) {
  const runtime = await runtimeFor(bridge)
  const terminal = runtime.createTerminal({ columns: 32, rows: 4 })
  const state = runtime.createRenderState(terminal)
  const builder = state.createFrameBuilder(32, 4)
  // Every text, style and brush gets its own atlas coordinates, so a wrong glyph shows up in bytes.
  const glyphs = fixtureGlyphs(kind)
  try {
    if (mode === 'ligatures')
      builder.setLigatures({
        find(points) {
          const start = points.indexOf(0x3d)
          return start >= 0 && points[start + 1] === 0x3e ? [[start, start + 2]] : []
        },
      })
    if (mode === 'bidi') {
      const mapper = new RowBidiMapper()
      builder.setBidiProjection(({ target }) =>
        target().set(bidiProjection(state.readRows(), mapper)),
      )
    }
    const options: ZigFrameOptions = {
      cellWidth: 8,
      cellHeight: 16,
      theme,
      full: true,
      overlayRows: new Set(),
      stableRows: mode === 'stable',
    }
    const frame = (patch: Partial<ZigFrameOptions> = {}) => {
      state.update()
      const settings = { ...options, ...patch }
      let status = builder.build(settings)
      if (status === 2) {
        for (const key of builder.missingGlyphs)
          builder.registerGlyph(key, glyphs.resolveInput(builder.glyphInput(key)))
        status = builder.build(settings)
      }
      expect(status).toBe(0)
      state.acknowledge()
      options.full = false
      return {
        cells: bytes(builder.cellData),
        glyphs: bytes(builder.glyphData),
        ranges: builder.changedRanges(),
      }
    }
    const frames = []
    terminal.write(
      '\x1b[?25lab => 界 á\r\n\x1b[4;9mstyled\x1b[0m \x1b[7mrev\x1b[0m אב(ג)\r\n' +
        '\x1b]8;;https://example.com\x1b\\linked\x1b]8;;\x1b\\ plain 🧪',
    )
    frames.push(frame())
    terminal.write('\x1b[1;1Hbc => 界 b́')
    frames.push(
      frame({ cursor: { x: 1, y: 0, visible: true, style: 'block' }, overlayRows: new Set([0]) }),
    )
    terminal.write('\x1b[1;5Hab')
    frames.push(
      frame({ cursor: { x: 6, y: 0, visible: true, style: 'bar' }, overlayRows: new Set([0]) }),
    )
    terminal.selectAll()
    frames.push(frame({ full: true }))
    terminal.clearSelection()
    options.theme = adjustedTheme
    frames.push(frame({ full: true }))
    terminal.write('\x1b[4;1Habc def\r\nrewritten 123 =>')
    frames.push(frame())
    terminal.write('\x1b[1;1Hcab ba \x1b[1mab\x1b[0m')
    frames.push(frame())
    terminal.write('\r\nbca abc 界a')
    frames.push(frame())
    return frames
  } finally {
    builder.dispose()
    state.dispose()
    terminal.dispose()
  }
}

describe('native frame records match the previous builder', () => {
  it.each(
    (['unstable', 'stable', 'ligatures', 'bidi'] as const).flatMap((mode) =>
      (['grayscale', 'color'] as const).map((kind) => [mode, kind] as const),
    ),
  )('%s rows with %s glyphs', async (mode, kind) => {
    const previous = await recordFrames('previous', mode, kind)
    const current = await recordFrames('current', mode, kind)
    for (const [index, frame] of current.entries())
      expect({ index, ...frame }).toEqual({ index, ...previous[index] })
  })

  // Reported in review: selection and a block cursor repaint cells inside one styled run, so a
  // per-row memo keyed on the cell's own colors would hand them the run's glyph.
  it.each(['grayscale', 'color'] as const)(
    'repaints selection and block cursor cells inside styled runs (%s glyphs)',
    async (kind) => {
      const record = async (bridge: 'previous' | 'current') => {
        const runtime = await runtimeFor(bridge)
        const terminal = runtime.createTerminal({ columns: 24, rows: 3 })
        const state = runtime.createRenderState(terminal)
        const builder = state.createFrameBuilder(24, 3)
        const gesture = new GhosttySelectionGesture(terminal)
        const glyphs = fixtureGlyphs(kind)
        const options: ZigFrameOptions = {
          cellWidth: 8,
          cellHeight: 16,
          theme,
          full: true,
          overlayRows: new Set(),
        }
        const frame = (patch: Partial<ZigFrameOptions> = {}) => {
          state.update()
          const settings = { ...options, ...patch }
          let status = builder.build(settings)
          for (let attempt = 0; status === 2 && attempt < 4; attempt += 1) {
            for (const key of builder.missingGlyphs)
              builder.registerGlyph(key, glyphs.resolveInput(builder.glyphInput(key)))
            status = builder.build(settings)
          }
          expect(status).toBe(0)
          state.acknowledge()
          options.full = false
          return { cells: bytes(builder.cellData), glyphs: bytes(builder.glyphData) }
        }
        const block = (x: number, y: number) => ({
          cursor: { x, y, visible: true, style: 'block' as const },
          overlayRows: new Set([y]),
        })
        try {
          terminal.write(
            '\x1b[?25l\x1b[38;2;200;100;50;48;2;10;20;30mAAAAAAAAAAAA\x1b[0;1;31mBBBBBBBB\x1b[0m\r\n' +
              '\x1b[7;38;5;45mCCCCCCCCCC\x1b[0;3;48;5;200mdddd dddd\x1b[0m\r\n' +
              '\x1b[48;2;9;8;7m      \x1b[0;2;38;2;1;200;3mxxyyxxyy\x1b[0m',
          )
          const frames = [frame()]
          gesture.selectRange({ x: 3, y: 0 }, { x: 6, y: 0 })
          frames.push(frame({ full: true }))
          frames.push(frame(block(9, 0)))
          frames.push(frame(block(4, 0)))
          gesture.selectRange({ x: 14, y: 0 }, { x: 3, y: 1 })
          frames.push(frame({ ...block(15, 1), full: true }))
          frames.push(frame(block(2, 2)))
          gesture.clear()
          frames.push(frame({ ...block(17, 2), full: true }))
          return frames
        } finally {
          gesture.dispose()
          builder.dispose()
          state.dispose()
          terminal.dispose()
        }
      }
      const previous = await record('previous')
      const current = await record('current')
      // Every step repaints something; otherwise the overlays aren't exercised.
      for (let index = 1; index < previous.length; index += 1)
        expect(previous[index]!.cells, `step ${index}`).not.toEqual(previous[index - 1]!.cells)
      for (const [index, frame] of current.entries())
        expect({ index, ...frame }).toEqual({ index, ...previous[index] })
    },
  )

  // Reported in review: a deferred entry shares its key across brushes until it registers.
  it('keeps distinct color brushes after deferred glyphs register', async () => {
    const columns = async (bridge: 'previous' | 'current') => {
      const runtime = await runtimeFor(bridge)
      const terminal = runtime.createTerminal({ columns: 6, rows: 1 })
      const state = runtime.createRenderState(terminal)
      const builder = state.createFrameBuilder(6, 1)
      // The frozen bridge has no in-place retry; it finished missing glyphs with a second build.
      if (bridge === 'previous') builder.retryMissing = (settings) => builder.build(settings)
      const atlas = new GlyphAtlas({ pageWidth: 4, pageHeight: 2, padding: 0, maxLayersPerKind: 1 })
      const rasterizer: GlyphRasterizer = {
        rasterize: ({ foreground: { r, g, b } }) => ({
          width: 2,
          height: 2,
          offsetX: 0,
          offsetY: 0,
          kind: 'color',
          pixels: new Uint8Array([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]),
        }),
      }
      const options = {
        cellWidth: 8,
        cellHeight: 16,
        theme: {
          ...defaultRendererTheme,
          cursorText: defaultRendererTheme.background,
          minimumContrast: 1,
        },
        full: false,
        overlayRows: new Set<number>(),
      }
      try {
        const frame = (text: string) => {
          terminal.write(text)
          state.update()
          expect(buildZigFrame(builder, atlas, rasterizer, options)).toBe(0)
          state.acknowledge()
        }
        frame('\x1b[?25lCD')
        frame('\x1b[38;2;255;0;0mA\x1b[0mA')
        expect(builder.hasDeferredGlyphs).toBe(true)
        frame('\x1b[1;1H\x1b[2X')
        expect(builder.hasDeferredGlyphs).toBe(false)
        return [2, 3].map((x) => builder.glyphData[x * GLYPH_INSTANCE_FLOATS + GlyphOffset.Uv]! * 4)
      } finally {
        builder.dispose()
        state.dispose()
        terminal.dispose()
      }
    }
    const previous = await columns('previous')
    expect(previous).toEqual([0, 2])
    expect(await columns('current')).toEqual(previous)
  })
})
