import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import type { NativeDisplayedFrame } from '../displayed-frame.js'
import { retainDisplayedFrame } from '../../render/shared/displayed-frame.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  vi.restoreAllMocks()
  runtime = undefined
})

it('keeps two native slots while unread previous text survives six submissions', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
  const state = runtime.createRenderState(terminal)
  const create = runtime.bridge.createRetainedFrame.bind(runtime.bridge)
  const destroy = runtime.bridge.destroyRetainedFrame.bind(runtime.bridge)
  const live = new Set<number>()
  let peak = 0
  vi.spyOn(runtime.bridge, 'createRetainedFrame').mockImplementation((...args) => {
    const handle = create(...args)
    if (handle) live.add(handle)
    peak = Math.max(peak, live.size)
    return handle
  })
  vi.spyOn(runtime.bridge, 'destroyRetainedFrame').mockImplementation((handle) => {
    expect(live.delete(handle)).toBe(true)
    destroy(handle)
  })
  let latest: NativeDisplayedFrame | undefined
  for (let index = 0; index < 6; index += 1) {
    terminal.write(`\x1b[H\x1b[2Kframe ${index} 界 é`)
    state.update()
    latest = state[retainDisplayedFrame]()
    state.acknowledge()
    latest.accept()
  }
  expect(peak).toBe(2)
  expect(live.size).toBe(2)
  expect(latest!.readTextRows()).toEqual(state.readTextRows())
  const previous = latest!.readPreviousTextRows()
  expect(previous[0]?.text.trimEnd()).toBe('frame 4 界 é')
  const held = JSON.stringify(previous)
  runtime.dispose()
  expect(live.size).toBe(0)
  expect(JSON.stringify(previous)).toBe(held)
})

it('preserves an unread previous frame through capture failure, populated discard and resize', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
  const state = runtime.createRenderState(terminal)
  const publish = (text: string) => {
    terminal.write(`\x1b[H\x1b[2K${text}`)
    state.update()
    const frame = state[retainDisplayedFrame]()
    state.acknowledge()
    frame.accept()
    return frame
  }
  publish('first 界 é')
  const accepted = publish('second 🧑‍💻')
  const styled = JSON.stringify(accepted.readRows())
  terminal.write('\x1b[H\x1b[2Kabandoned')
  state.update()
  const fail = vi.spyOn(runtime.bridge, 'captureRetainedFrame').mockReturnValue(-1)
  expect(() => state[retainDisplayedFrame]()).toThrow('retain_frame')
  fail.mockRestore()
  const previous = accepted.readPreviousTextRows()
  expect(previous[0]?.text.trimEnd()).toBe('first 界 é')
  expect(JSON.stringify(accepted.readRows())).toBe(styled)
  const pending = state[retainDisplayedFrame]()
  expect(pending.readTextRows()[0]?.text.trimEnd()).toBe('abandoned')
  expect(accepted.readPreviousTextRows()).toEqual(previous)
  pending.discard()
  terminal.resize({ columns: 30, rows: 5 })
  const retry = publish('retry ☕️ è')
  expect(retry.readTextRows()).toEqual(state.readTextRows())
  expect(retry.readPreviousTextRows()[0]?.text.trimEnd()).toBe('second 🧑‍💻')
  expect(() => accepted.readPreviousTextRows()).toThrow('retired')
  expect(previous[0]?.text.trimEnd()).toBe('first 界 é')
})
