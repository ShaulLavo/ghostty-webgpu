import { afterEach, expect, it, vi } from 'vitest'
import { retainDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { GhosttyRuntime } from '../runtime.js'
import type { NativeDisplayedFrame } from '../displayed-frame.js'
import type { RenderTextRow } from '../types.js'

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

it.each([false, true])(
  'keeps accepted cache entries when a populated attempt is discarded, failure=%s',
  async (failure) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 20, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('accepted 界 é')
    state.update()
    const accepted = state[retainDisplayedFrame]()
    accepted.accept()
    state.acknowledge()
    const owned = accepted.readTextRows()
    terminal.write('\r\x1b[2Kabandoned 🧑‍💻')
    state.update()
    const pending = state[retainDisplayedFrame]()
    const revisions = runtime.bridge.readRetainedRevisions.bind(runtime.bridge)
    let calls = 0
    const fail = vi.spyOn(runtime.bridge, 'readRetainedRevisions').mockImplementation((...args) => {
      calls += 1
      if (failure && calls === 2) throw new Error('injected failure after insertion')
      revisions(...args)
    })
    try {
      if (failure) expect(() => pending.readTextRows()).toThrow('after insertion')
      if (!failure) expect(pending.readTextRows()[0]?.text).toContain('abandoned')
    } finally {
      fail.mockRestore()
      pending.discard()
    }
    terminal.write('\r\x1b[2Kretry ☕️')
    state.update()
    const retry = state[retainDisplayedFrame]()
    const extract = vi.spyOn(runtime.bridge, 'readRetainedText')
    try {
      const previous = retry.readPreviousTextRows()
      expect(previous).toEqual(owned)
      expect(previous[0]).toBe(owned[0])
      expect(extract).not.toHaveBeenCalled()
      expect(retry.readTextRows()).toEqual(state.readTextRows())
      retry.accept()
      expect(retry.readPreviousTextRows()).toEqual(owned)
      expect(owned[0]?.text).toContain('accepted')
    } finally {
      extract.mockRestore()
    }
  },
)

function readAndDiscard(
  runtime: GhosttyRuntime,
  state: ReturnType<GhosttyRuntime['createRenderState']>,
  pending: NativeDisplayedFrame,
  partial: boolean,
): void {
  const read = runtime.bridge.readRetainedRevisions.bind(runtime.bridge)
  let calls = 0
  const failure = vi
    .spyOn(runtime.bridge, 'readRetainedRevisions')
    .mockImplementation((...args) => {
      calls += 1
      if (partial && calls === 2) throw new Error('after pending insertion')
      read(...args)
    })
  try {
    if (partial) {
      expect(() => pending.readTextRows()).toThrow('after pending insertion')
      return
    }
    expect(pending.readTextRows()).toEqual(state.readTextRows())
  } finally {
    failure.mockRestore()
    pending.discard()
  }
}

function expectCachedRows(rows: readonly RenderTextRow[], owned: readonly RenderTextRow[]): void {
  expect(rows).toEqual(owned)
  for (let y = 0; y < rows.length; y += 1) {
    expect(rows[y]!.cells).toBe(owned[y]!.cells)
    expect(rows[y]!.continuations).toBe(owned[y]!.continuations)
  }
}

it.each([false, true])(
  'retains accepted rows across repeated moved-row discard/retry, partial=%s',
  async (partial) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 6 })
    const first = runtime.createRenderState(terminal)
    const second = runtime.createRenderState(terminal)
    const accept = (state: typeof first) => {
      state.update()
      const frame = state[retainDisplayedFrame]()
      frame.readTextRows()
      state.acknowledge()
      frame.accept()
      return frame
    }
    terminal.write(Array.from({ length: 6 }, (_, y) => `row ${y} 界 é`).join('\r\n'))
    let firstFrame = accept(first)
    let secondFrame = accept(second)
    terminal.write('\r\nprime 🧑‍💻')
    firstFrame = accept(first)
    secondFrame = accept(second)
    for (let index = 0; index < 32; index += 1) {
      const firstOwned = firstFrame.readTextRows()
      let secondOwned = secondFrame.readTextRows()
      const held = JSON.stringify(firstOwned)
      terminal.write(`\r\nabandoned ${index} 🧑‍💻`)
      first.update()
      second.update()
      const firstPending = first[retainDisplayedFrame]()
      const secondPending = second[retainDisplayedFrame]()
      readAndDiscard(runtime, first, firstPending, partial)
      secondPending.readTextRows()
      if (index % 3 === 0) {
        second.acknowledge()
        secondPending.accept()
        secondOwned = secondPending.readTextRows()
      } else secondPending.discard()
      terminal.write(`\x1b[6;1H\x1b[2Kretry ${index} ☕️ è`)
      first.update()
      second.update()
      const firstRetry = first[retainDisplayedFrame]()
      const secondRetry = second[retainDisplayedFrame]()
      const extraction = vi.spyOn(runtime.bridge, 'readRetainedText')
      try {
        const previous = firstRetry.readPreviousTextRows()
        const secondPrevious = secondRetry.readPreviousTextRows()
        expect(extraction).not.toHaveBeenCalled()
        expectCachedRows(previous, firstOwned)
        expectCachedRows(secondPrevious, secondOwned)
      } finally {
        extraction.mockRestore()
      }
      expect(firstRetry.readTextRows()).toEqual(first.readTextRows())
      expect(secondRetry.readTextRows()).toEqual(second.readTextRows())
      first.acknowledge()
      second.acknowledge()
      firstRetry.accept()
      secondRetry.accept()
      expect(JSON.stringify(firstOwned)).toBe(held)
      firstFrame = firstRetry
      secondFrame = secondRetry
    }
  },
)
