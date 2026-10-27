import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
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
  expect(second.readRows({ dirtyOnly: true }).map((row) => row.y)).toEqual([1, 2])
  expect(second.acknowledge()).toBe(2)
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
