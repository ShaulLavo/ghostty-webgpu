import { expect, it, vi } from 'vitest'
import { CanvasColorCache } from '../canvas/colors.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { GhosttyRenderState } from '../../core/render-state.js'
import type { GhosttyTerminal } from '../../core/terminal.js'
import type { CanonicalRendererTheme } from '../instances/types.js'
import type { RenderRow } from '../../core/types.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import { copiedFrameRow } from '../frame-row.js'
import { defaultCellStyle, defaultRowStyle, renderRowRuns } from './html.js'
import { probeFont, probeInput } from './tests/probe.js'

function expectPackedScreen({
  terminal,
  state,
  input,
  index,
  theme,
}: {
  terminal: GhosttyTerminal
  state: GhosttyRenderState
  input: string
  index: number
  theme: CanonicalRendererTheme
}): void {
  terminal.write(input)
  if (index % 2 === 0) terminal.selectAll()
  else terminal.clearSelection()
  state.update()
  const packed = state.readRows({ packed: true })
  const materialized = state.readRows()
  for (const row of packed) expectPackedRow(row, materialized[row.y]!, theme)
}

function expectPackedRow(row: RenderRow, expected: RenderRow, theme: CanonicalRendererTheme): void {
  const protectedRow: RenderRow = {
    dirty: row.dirty,
    y: row.y,
    packed: row.packed,
    get cells() {
      return expect.fail('Packed projection materialized styled cells')
    },
  }
  for (const style of [undefined, 'block', 'bar', 'underline', 'outline'] as const) {
    const cursor = style ? { style, visible: true, x: 2, y: row.y } : undefined
    const expectedRuns = renderRowRuns(expected, cursor, probeFont, theme)
    expect(renderRowRuns(protectedRow, cursor, probeFont, theme)).toEqual(expectedRuns)
    expect(
      renderRowRuns(
        protectedRow,
        cursor,
        probeFont,
        theme,
        defaultRowStyle(probeFont, theme, row.packed!.length),
      ),
    ).toEqual(expectedRuns)
  }
  const snapshot = copiedFrameRow(protectedRow)
  const expectedSnapshot = copiedFrameRow(expected)
  expect(snapshot.text).toBe(expectedSnapshot.text)
  expect(snapshot.renderCells).toEqual(expectedSnapshot.renderCells)
  expect(Object.isFrozen(snapshot.renderCells)).toBe(true)
}

it('reuses default CSS without resolving cell colors during packed row projection', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('edit 0000')
    state.update()
    const row = state.readRows({ packed: true })[0]!
    const theme = canonicalRendererTheme(mergeRendererTheme({}))
    const expected = renderRowRuns(row, undefined, probeFont, theme)
    const css = expected[0]!.style.slice(0, expected[0]!.style.lastIndexOf('width:calc('))
    const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
    try {
      expect(
        renderRowRuns(row, undefined, probeFont, theme, {
          cell: css,
          run: expected[0]!.style,
          columns: row.packed!.length,
        }),
      ).toEqual(expected)
      expect(foreground).not.toHaveBeenCalled()
    } finally {
      foreground.mockRestore()
    }
  } finally {
    runtime.dispose()
  }
})

it('projects a default packed run without decoding scratch cells', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('edit 0000')
    state.update()
    const row = state.readRows({ packed: true })[0]!
    const theme = canonicalRendererTheme(mergeRendererTheme({}))
    const expected = renderRowRuns(row, undefined, probeFont, theme)
    const css = defaultCellStyle(probeFont, theme)
    const read = vi.spyOn(row.packed!, 'read')
    try {
      expect(
        renderRowRuns(row, undefined, probeFont, theme, {
          cell: css,
          run: expected[0]!.style,
          columns: row.packed!.length,
        }),
      ).toEqual(expected)
      expect(read).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
    }
  } finally {
    runtime.dispose()
  }
})

it.each(['', ' '.repeat(40), 'a'.repeat(40), '\x1b[1;40Hx', '  é edit 0000   '])(
  'projects full-width default snapshot text without decoding each trailing cell (%#)',
  async (input) => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
      const state = runtime.createRenderState(terminal)
      terminal.write(input)
      state.update()
      const row = state.readRows({ packed: true })[0]!
      const expected = copiedFrameRow(state.readRows()[0]!)
      const text = vi.spyOn(row.packed!, 'text')
      const continuation = vi.spyOn(row.packed!, 'continuation')
      try {
        const snapshot = copiedFrameRow(row)
        expect(snapshot.text).toBe(expected.text)
        expect(text).not.toHaveBeenCalled()
        expect(continuation).not.toHaveBeenCalled()
        terminal.write('\x1b[2J\x1b[Hlater')
        state.update()
        runtime.exports.memory.grow(1)
        expect(snapshot.text).toBe(expected.text)
        expect(snapshot.cells).toEqual(expected.cells)
        expect(snapshot.continuations).toEqual(expected.continuations)
        expect(snapshot.renderCells).toEqual(expected.renderCells)
        expect(Object.isFrozen(snapshot.cells)).toBe(true)
      } finally {
        text.mockRestore()
        continuation.mockRestore()
      }
    } finally {
      runtime.dispose()
    }
  },
)

it.each(['edit 0000', '  é edit 0000   ', '\x1b[1;40Hx'])(
  'reuses owned default glyph projection for padded frame text (%#)',
  async (input) => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
      const state = runtime.createRenderState(terminal)
      terminal.write(input)
      state.update()
      const row = state.readRows({ packed: true })[0]!
      const expected = copiedFrameRow(state.readRows()[0]!)
      const decode = vi.spyOn(String, 'fromCodePoint')
      try {
        const prefix = row.packed!.defaultRunText()
        const firstReads = decode.mock.calls.length
        expect(firstReads).toBeGreaterThan(0)
        const snapshot = copiedFrameRow(row)
        expect(snapshot.text).toBe(expected.text)
        expect(decode.mock.calls.length).toBe(firstReads)
        terminal.write('\x1b[2J\x1b[Hlater')
        state.update()
        runtime.exports.memory.grow(1)
        expect(row.packed!.defaultRunText()).toBe(prefix)
        expect(row.packed!.defaultRunText(true)).toBe(expected.text)
        expect(snapshot.cells).toEqual(expected.cells)
        expect(snapshot.renderCells).toEqual(expected.renderCells)
        expect(snapshot.continuations).toEqual(expected.continuations)
      } finally {
        decode.mockRestore()
      }
    } finally {
      runtime.dispose()
    }
  },
)

it('reuses full-width default run CSS without serializing the width again', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('edit 0000')
    state.update()
    const row = state.readRows({ packed: true })[0]!
    const theme = canonicalRendererTheme(mergeRendererTheme({}))
    const expected = renderRowRuns(row, undefined, probeFont, theme)
    const fullStyle = expected[0]!.style
    const css = fullStyle.slice(0, fullStyle.lastIndexOf('width:calc('))
    let widthReads = 0
    const font = {
      ...probeFont,
      get cssCellWidth() {
        widthReads += 1
        return probeFont.cssCellWidth
      },
    }
    expect(
      renderRowRuns(row, undefined, font, theme, {
        cell: css,
        run: fullStyle,
        columns: row.packed!.length,
      }),
    ).toEqual(expected)
    expect(widthReads).toBe(0)
  } finally {
    runtime.dispose()
  }
})

it('projects owned packed rows identically without materializing cells across styles, wide text and cursor states', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
    const state = runtime.createRenderState(terminal)
    const theme = canonicalRendererTheme(mergeRendererTheme({ minimumContrast: 7 }))
    const cases = [
      probeInput,
      '\x1b[?25l\x1b[2J\x1b[H\x1b[0m  edit 0000   ',
      '\x1b[2J\x1b[H\x1b[1;4Habc',
      '\x1b[2J\x1b[H\x1b[0mé ',
      '\x1b[?25l\x1b[2J\x1b[H' + '\x1b[31mA\x1b[32mB'.repeat(15),
      '\x1b[2J\x1b[H\x1b[1;2;3;4:3;7;9;53mA界é👩‍💻\x1b[0mB',
      '\x1b[2J\x1b[H\x1b[8mhidden\x1b[0m 日本語 中文 🧪 👨‍👩‍👧‍👦',
      '\x1b[2J\x1b[H\x1b[38;2;12;24;36mF\x1b[48;2;50;60;70mG\x1b[0mH',
      '\x1b[2J\x1b[Habc\r\ndef\r\nghi',
    ]
    for (const [index, input] of cases.entries())
      expectPackedScreen({ terminal, state, input, index, theme })
  } finally {
    runtime.dispose()
  }
})

it('keeps projected runs and lazy immutable snapshots stable across later writes and memory growth', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write(probeInput)
    state.update()
    const row = state.readRows({ packed: true })[0]!
    const theme = canonicalRendererTheme(mergeRendererTheme({}))
    const runs = renderRowRuns(row, undefined, probeFont, theme)
    const snapshot = copiedFrameRow(row)
    const expectedText = snapshot.text
    const expectedCells = copiedFrameRow(state.readRows()[0]!).renderCells
    const expectedRuns = structuredClone(runs)
    runtime.exports.memory.grow(1)
    terminal.write('\x1b[2J\x1b[Hdifferent styled \x1b[31mtext')
    state.update()
    renderRowRuns(state.readRows({ packed: true })[0]!, undefined, probeFont, theme)
    expect(runs).toEqual(expectedRuns)
    expect(snapshot.text).toBe(expectedText)
    expect(snapshot.renderCells).toEqual(expectedCells)
    expect(Object.isFrozen(snapshot.renderCells[0])).toBe(true)
  } finally {
    runtime.dispose()
  }
})
