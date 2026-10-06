import { expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { GhosttyRenderState } from '../../core/render-state.js'
import type { GhosttyTerminal } from '../../core/terminal.js'
import type { CanonicalRendererTheme } from '../instances/types.js'
import type { RenderRow } from '../../core/types.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import { copiedFrameRow } from '../frame-row.js'
import { renderRowRuns } from './html.js'
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
  for (const style of ['block', 'bar', 'underline', 'outline'] as const) {
    const cursor = { style, visible: true, x: 2, y: row.y }
    expect(renderRowRuns(protectedRow, cursor, probeFont, theme)).toEqual(
      renderRowRuns(expected, cursor, probeFont, theme),
    )
  }
  const snapshot = copiedFrameRow(protectedRow)
  const expectedSnapshot = copiedFrameRow(expected)
  expect(snapshot.text).toBe(expectedSnapshot.text)
  expect(snapshot.renderCells).toEqual(expectedSnapshot.renderCells)
  expect(Object.isFrozen(snapshot.renderCells)).toBe(true)
}

it('projects owned packed rows identically without materializing cells across styles, wide text and cursor states', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 40, rows: 3 })
    const state = runtime.createRenderState(terminal)
    const theme = canonicalRendererTheme(mergeRendererTheme({ minimumContrast: 7 }))
    const cases = [
      probeInput,
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
