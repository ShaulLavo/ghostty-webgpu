import { afterEach, expect, it, vi } from 'vitest'
import { retainDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { GhosttyRuntime } from '../runtime.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

it.each([false, true])(
  'does not reuse cached text from a discarded capture after resize=%s',
  async (resize) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('accepted')
    state.update()
    const accepted = state[retainDisplayedFrame]()
    accepted.accept()
    const previous = JSON.stringify(accepted.readTextRows())
    state.acknowledge()
    terminal.write('\r\x1b[2Kdiscarded 界 é')
    state.update()
    const abandoned = state[retainDisplayedFrame]()
    expect(abandoned.readTextRows()[0]?.text).toContain('discarded')
    abandoned.discard()
    if (resize) terminal.resize({ columns: 20, rows: 4 })
    terminal.write('\r\x1b[2Kcorrect 🧑‍💻')
    state.update()
    const expected = JSON.stringify(state.readTextRows())
    const retry = state[retainDisplayedFrame]()
    expect(JSON.stringify(retry.readTextRows())).toBe(expected)
    state.acknowledge()
    retry.accept()
    expect(JSON.stringify(retry.readTextRows())).toBe(expected)
    expect(JSON.stringify(retry.readPreviousTextRows())).toBe(previous)
    expect(() => abandoned.readTextRows()).toThrow('token has retired')
  },
)

it('keeps independent accepted histories through overlapping captures, discard, unequal cadence and disposal', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
  const first = runtime.createRenderState(terminal)
  const second = runtime.createRenderState(terminal)
  terminal.write('initial')
  first.update()
  second.update()
  const firstInitial = first[retainDisplayedFrame]()
  const secondInitial = second[retainDisplayedFrame]()
  firstInitial.accept()
  secondInitial.accept()
  const initial = JSON.stringify(secondInitial.readTextRows())
  first.acknowledge()
  second.acknowledge()
  terminal.write('\r\x1b[2Kdiscarded')
  first.update()
  second.update()
  const firstPending = first[retainDisplayedFrame]()
  const secondPending = second[retainDisplayedFrame]()
  expect(secondPending.readTextRows()[0]?.text.trimEnd()).toBe('discarded')
  firstPending.accept()
  secondPending.discard()
  expect(JSON.stringify(secondInitial.readTextRows())).toBe(initial)
  terminal.write('\r\x1b[2Kfirst ahead')
  first.update()
  const firstAhead = first[retainDisplayedFrame]()
  firstAhead.accept()
  expect(firstAhead.readPreviousTextRows()[0]?.text.trimEnd()).toBe('discarded')
  expect(JSON.stringify(secondInitial.readTextRows())).toBe(initial)
  first.dispose()
  expect(JSON.stringify(secondInitial.readTextRows())).toBe(initial)
  second.update()
  const retry = second[retainDisplayedFrame]()
  expect(retry.readTextRows()[0]?.text.trimEnd()).toBe('first ahead')
  retry.accept()
  expect(JSON.stringify(retry.readPreviousTextRows())).toBe(initial)
  expect(() => firstAhead.readTextRows()).toThrow('token has retired')
  expect(() => secondPending.readTextRows()).toThrow('token has retired')
  second.dispose()
  expect(() => retry.readTextRows()).toThrow('token has retired')
})

it('discards text inserted before a pending read fails while pruning', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 20, rows: 3 })
  const state = runtime.createRenderState(terminal)
  terminal.write('accepted')
  state.update()
  const accepted = state[retainDisplayedFrame]()
  accepted.accept()
  state.acknowledge()
  const owned = accepted.readTextRows()
  terminal.write('\r\x1b[2Kabandoned 界')
  state.update()
  const pending = state[retainDisplayedFrame]()
  const read = runtime.bridge.readRetainedRevisions.bind(runtime.bridge)
  let calls = 0
  const fail = vi.spyOn(runtime.bridge, 'readRetainedRevisions').mockImplementation((...args) => {
    calls += 1
    if (calls === 2) throw new Error('injected failure after text extraction')
    read(...args)
  })
  try {
    expect(() => pending.readTextRows()).toThrow('after text extraction')
  } finally {
    fail.mockRestore()
    pending.discard()
  }
  terminal.write('\r\x1b[2Kretry é 🧑‍💻')
  state.update()
  const retry = state[retainDisplayedFrame]()
  expect(retry.readTextRows()).toEqual(state.readTextRows())
  retry.accept()
  expect(retry.readPreviousTextRows()).toEqual(owned)
  expect(owned[0]?.text.trimEnd()).toBe('accepted')
})
