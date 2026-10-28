import { expect, it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import { retainDisplayedFrame } from '../../render/shared/displayed-frame.js'

function seedCounter(
  runtime: GhosttyRuntime,
  state: ReturnType<GhosttyRuntime['createRenderState']>,
  value: bigint,
): void {
  const store = Reflect.get(state, 'displayedFrames')
  const current = Reflect.get(Reflect.get(store, 'frames'), 'current')
  const slot = Reflect.get(current, 'slot')
  const handle: unknown = Reflect.get(slot, 'handle')
  if (typeof handle !== 'number') throw new Error('Expected native retained slot')
  // The pinned wasm32 Frame puts its text counter after the u64 revision at byte 24.
  expect(runtime.memory.view.getUint32(handle + 32, true)).toBe(2)
  runtime.memory.view.setBigUint64(handle + 32, value, true)
}

it.each([false, true])(
  'keeps clean rows distinct across the former 32-bit rollover, discard=%s',
  async (discard) => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 20, rows: 2 })
      const state = runtime.createRenderState(terminal)
      terminal.write('header\r\nbody')
      state.update()
      const first = state[retainDisplayedFrame]()
      first.accept()
      const original = first.readTextRows()
      state.acknowledge()
      seedCounter(runtime, state, 0xffffffffn)
      terminal.write('\x1b[2;1H\x1b[2Knew body')
      state.update()
      let next = state[retainDisplayedFrame]()
      expect(next.readTextRows()).toEqual(state.readTextRows())
      if (discard) {
        next.discard()
        terminal.write('\x1b[2;1H\x1b[2Kretry 界 é')
        state.update()
        next = state[retainDisplayedFrame]()
      }
      const expected = state.readTextRows()
      expect(next.readTextRows()).toEqual(expected)
      expect(next.readTextRows().map((row) => row.y)).toEqual([0, 1])
      state.acknowledge()
      next.accept()
      expect(next.readTextRows()).toEqual(expected)
      expect(next.readPreviousTextRows()).toEqual(original)
      expect(original[0]?.text.trimEnd()).toBe('header')
    } finally {
      runtime.dispose()
    }
  },
)

it('uses the last exact JS revision and rejects exhaustion without retiring the accepted frame', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 20, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('header\r\nbody')
    state.update()
    const first = state[retainDisplayedFrame]()
    first.accept()
    first.readTextRows()
    state.acknowledge()
    seedCounter(runtime, state, BigInt(Number.MAX_SAFE_INTEGER) - 1n)
    terminal.write('\x1b[2;1H\x1b[2Klast exact body')
    state.update()
    const last = state[retainDisplayedFrame]()
    expect(last.readTextRows()).toEqual(state.readTextRows())
    state.acknowledge()
    last.accept()
    const accepted = last.readTextRows()
    terminal.write('\x1b[2;1H\x1b[2Kcannot alias header')
    state.update()
    expect(() => state[retainDisplayedFrame]()).toThrow('retain_frame')
    expect(last.readTextRows()).toBe(accepted)
    expect(last.readTextRows()[1]?.text.trimEnd()).toBe('last exact body')
  } finally {
    runtime.dispose()
  }
})
