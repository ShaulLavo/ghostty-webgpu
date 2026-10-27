import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import { retainDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { RenderStateDirty } from '../abi.js'
import type { GhosttyRenderState } from '../render-state.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
  vi.useRealTimers()
})

function text(state: GhosttyRenderState): string | undefined {
  return state.readTextRows()[0]?.text.trimEnd()
}

async function createPair() {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
  const first = runtime.createRenderState(terminal)
  const second = runtime.createRenderState(terminal)
  terminal.write('old')
  first.update()
  first.acknowledge()
  second.update()
  second.acknowledge()
  return { terminal, first, second }
}

it('delivers incremental text and row damage to both states in either update order', async () => {
  const { terminal, first, second } = await createPair()
  terminal.write(' before')
  first.update()
  first.acknowledge()
  expect(second.update()).not.toBe(RenderStateDirty.False)
  expect(text(first)).toBe('old before')
  expect(text(second)).toBe('old before')
  expect(second.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual([0])
  second.acknowledge()
  terminal.write(' after')
  second.update()
  second.acknowledge()
  expect(first.update()).not.toBe(RenderStateDirty.False)
  expect(text(first)).toBe('old before after')
  expect(first.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual([0])
  first.acknowledge()
  expect(first.update()).toBe(RenderStateDirty.False)
  expect(second.update()).toBe(RenderStateDirty.False)
})

it('accumulates missed rows until each state acknowledges them', async () => {
  const { terminal, first, second } = await createPair()
  terminal.write('\x1b[2;1Hrow two')
  first.update()
  first.acknowledge()
  terminal.write('\x1b[3;1Hrow three')
  first.update()
  first.acknowledge()
  second.update()
  expect(second.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual([0, 1, 2])
  expect(second.acknowledge()).toBe(3)
  expect(first.readRows({ dirtyOnly: true })).toEqual([])
  expect(second.readRows({ dirtyOnly: true })).toEqual([])
})

it('captures both views before consecutive synchronized holds and after resize', async () => {
  const { terminal, first, second } = await createPair()
  terminal.write(' before\x1b[?2026h\r\x1b[2Kpartial')
  first.update()
  second.update()
  expect(text(first)).toBe('old before')
  expect(text(second)).toBe('old before')
  first.acknowledge()
  terminal.write(' complete\x1b[?2026l\x1b[?2026h\r\x1b[2Knext')
  second.update()
  first.update()
  expect(text(first)).toBe('partial complete')
  expect(text(second)).toBe('partial complete')
  second.acknowledge()
  terminal.resize({ columns: 20, rows: 4 })
  first.update()
  first.acknowledge()
  expect(second.update()).toBe(RenderStateDirty.Full)
  expect(text(first)).toBe('next')
  expect(text(second)).toBe('next')
  expect(second.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual([0, 1, 2, 3])
})

it('releases both snapshots on a synchronized-output timeout', async () => {
  vi.useFakeTimers()
  const { terminal, first, second } = await createPair()
  terminal.write('\x1b[?2026h\rnew')
  first.acknowledge()
  second.acknowledge()
  vi.advanceTimersByTime(1000)
  second.update()
  second.acknowledge()
  first.update()
  expect(text(first)).toBe('new')
  expect(text(second)).toBe('new')
  expect(first.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual([0])
})

it('shares snapshots while preserving damage when a subscriber joins or leaves', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
  const first = runtime.createRenderState(terminal)
  terminal.write('old')
  first.update()
  const second = runtime.createRenderState(terminal)
  expect(text(second)).toBe('old')
  expect(second.acknowledge()).toBe(3)
  expect(first.readRows({ dirtyOnly: true })).toHaveLength(3)
  first.acknowledge()
  terminal.write(' before')
  second.update()
  const version = second.snapshotVersion
  expect(text(first)).toBe('old before')
  first.dispose()
  second.acknowledge()
  expect(second.update()).toBe(RenderStateDirty.False)
  expect(second.snapshotVersion).toBe(version)
  terminal.write(' after')
  second.update()
  expect(text(second)).toBe('old before after')
  second.dispose()
  const replacement = runtime.createRenderState(terminal)
  replacement.update()
  expect(text(replacement)).toBe('old before after')
})

it('shares the safe baseline with subscribers created during a hold', async () => {
  const { terminal, first, second } = await createPair()
  terminal.write(' before\x1b[?2026h\r\x1b[2Kpartial')
  const third = runtime!.createRenderState(terminal)
  expect(third.update()).toBe(RenderStateDirty.Full)
  expect(text(third)).toBe('old before')
  first.dispose()
  second.dispose()
  terminal.write(' complete\x1b[?2026l')
  third.update()
  expect(text(third)).toBe('partial complete')
})

it('drops obsolete row damage when a lagging subscriber follows a smaller viewport', async () => {
  const { terminal, first, second } = await createPair()
  terminal.write('\x1b[3;1Hlast')
  first.update()
  first.acknowledge()
  terminal.resize({ columns: 20, rows: 2 })
  first.update()
  first.acknowledge()
  second.update()
  expect(second.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual([0, 1])
  expect(second.acknowledge()).toBe(2)
})

it('does not acknowledge newer damage captured by a different subscriber after a read', async () => {
  const { terminal, first, second } = await createPair()
  terminal.write(' before')
  first.update()
  expect(text(first)).toBe('old before')
  terminal.write('\rNEW')
  second.update()
  second.acknowledge()
  expect(first.acknowledge()).toBe(0)
  expect(first.dirty).not.toBe(RenderStateDirty.False)
  expect(text(first)).toBe('NEW before')
  expect(first.acknowledge()).toBe(1)
  expect(first.dirty).toBe(RenderStateDirty.False)
})

it('retains separate submitted-frame histories for each subscriber', async () => {
  const { terminal, first, second } = await createPair()
  const firstFrame = first[retainDisplayedFrame]()
  const secondFrame = second[retainDisplayedFrame]()
  firstFrame.accept()
  secondFrame.accept()
  terminal.write(' before')
  first.update()
  const nextFirst = first[retainDisplayedFrame]()
  nextFirst.accept()
  expect(nextFirst.readTextRows()[0]?.text.trimEnd()).toBe('old before')
  expect(secondFrame.readTextRows()[0]?.text.trimEnd()).toBe('old')
  first.dispose()
  expect(secondFrame.readTextRows()[0]?.text.trimEnd()).toBe('old')
  second.update()
  const nextSecond = second[retainDisplayedFrame]()
  nextSecond.accept()
  expect(nextSecond.readTextRows()[0]?.text.trimEnd()).toBe('old before')
  expect(nextSecond.readPreviousTextRows()[0]?.text.trimEnd()).toBe('old')
})

it.each([
  'cell data',
  'glyph data',
  'metadata',
  'glyph input',
  'glyph registration',
  'glyph clearing',
])('does not observe newer native damage through cached frame %s', async (operation) => {
  const { terminal, first, second } = await createPair()
  const { canonicalRendererTheme, mergeRendererTheme } =
    await import('../../render/shared/config.js')
  const builder = first.createFrameBuilder(16, 3)
  try {
    terminal.write(' before')
    first.update()
    const options = {
      cellWidth: 10,
      cellHeight: 20,
      theme: canonicalRendererTheme(mergeRendererTheme()),
      full: true,
      overlayRows: new Set<number>(),
    }
    builder.build(options)
    const keys = builder.missingGlyphs
    for (const key of keys) builder.registerGlyph(key, undefined)
    expect(builder.build(options)).toBe(0)
    const built = builder.cellData.slice()
    terminal.write('\rNEW')
    second.update()
    second.acknowledge()
    if (operation === 'cell data') expect(builder.cellData).toEqual(built)
    if (operation === 'glyph data') expect(builder.glyphData.length).toBeGreaterThan(0)
    if (operation === 'metadata') expect(builder.rowRebuilds).toBeGreaterThan(0)
    if (operation === 'glyph input') expect(builder.glyphInput(keys[0]!).text).not.toBe('')
    if (operation === 'glyph registration') builder.registerGlyph(keys[0]!, undefined)
    if (operation === 'glyph clearing') builder.clearGlyphs()
    expect(first.acknowledge()).toBe(0)
    expect(first.dirty).not.toBe(RenderStateDirty.False)
  } finally {
    builder.dispose()
  }
})
