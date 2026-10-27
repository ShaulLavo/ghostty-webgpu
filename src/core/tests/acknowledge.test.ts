import { afterEach, expect, it, vi } from 'vitest'
import {
  RenderStateData,
  RenderStateDirty,
  RenderStateOption,
  RenderStateRowOption,
} from '../abi.js'
import { GhosttyRuntime } from '../runtime.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
  vi.restoreAllMocks()
})

it('uses native clean once and returns the number of dirty rows', async () => {
  let cleans = 0
  const instantiate = WebAssembly.instantiate
  vi.spyOn(WebAssembly, 'instantiate').mockImplementation(async (module, imports) => {
    const clean = imports?.env?.ghostty_render_state_clean
    if (typeof clean !== 'function') return instantiate(module, imports)
    return instantiate(module, {
      ...imports,
      env: {
        ...imports?.env,
        ghostty_render_state_clean: (...args: number[]) => {
          cleans += 1
          return clean(...args)
        },
      },
    })
  })
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 4 })
  const state = runtime.createRenderState(terminal)
  expect(state.acknowledge()).toBe(0)
  terminal.write('\x1b[?25lfirst\r\nsecond')
  state.update()
  expect(state.acknowledge()).toBe(4)
  expect(cleans).toBe(2)
  expect(state.dirty).toBe(RenderStateDirty.False)
  expect(state.readRows({ dirtyOnly: true })).toEqual([])
  expect(state.acknowledge()).toBe(0)
  terminal.write('\x1b[2;1H界é👩‍💻')
  state.update()
  expect(state.acknowledge()).toBe(1)
  expect(state.acknowledge()).toBe(0)
})

it('preserves pending damage until a failed frame is retried, including during a hold', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 4 })
  const state = runtime.createRenderState(terminal)
  terminal.write('first\r\nsecond')
  state.update()
  state.acknowledge()
  terminal.write('\x1b[1;1Hnew\x1b[3;1Hthird')
  state.update()
  const damage = state.readRows({ dirtyOnly: true })
  expect(damage.map((row) => row.y)).toEqual([0, 1, 2])
  state.readRows({ rows: new Set([0]), dirtyOnly: true })
  expect(state.readRows({ dirtyOnly: true })).toEqual(damage)
  terminal.write('\x1b[?2026h\rhidden')
  state.update()
  expect(state.readTextRows()[2]?.text.trimEnd()).toBe('third')
  expect(state.acknowledge()).toBe(3)
  expect(state.acknowledge()).toBe(0)
  terminal.write('\x1b[?2026l')
  state.update()
  expect(state.readTextRows()[2]?.text.trimEnd()).toBe('hidden')
  expect(state.acknowledge()).toBeGreaterThan(0)
  expect(state.dirty).toBe(RenderStateDirty.False)
})

it('counts remaining dirty rows even when the global flag and some rows were already cleared', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 4 })
  const state = runtime.createRenderState(terminal)
  const acknowledge = vi.spyOn(runtime.bridge, 'acknowledge')
  state.update()
  state.acknowledge()
  const [handle, iterator] = acknowledge.mock.calls[0]!
  terminal.write('\x1b[2J')
  state.update()
  const pointer = runtime.memory.allocate(4)
  try {
    runtime.memory.view.setUint32(pointer, iterator, true)
    expect(
      runtime.exports.ghostty_render_state_get(handle, RenderStateData.RowIterator, pointer),
    ).toBe(0)
    runtime.exports.ghostty_render_state_row_iterator_next(iterator)
    runtime.memory.view.setUint32(pointer, 0, true)
    expect(
      runtime.exports.ghostty_render_state_row_set(iterator, RenderStateRowOption.Dirty, pointer),
    ).toBe(0)
    expect(runtime.exports.ghostty_render_state_set(handle, RenderStateOption.Dirty, pointer)).toBe(
      0,
    )
    expect(state.acknowledge()).toBe(3)
    expect(state.readRows({ dirtyOnly: true })).toEqual([])
    expect(state.acknowledge()).toBe(0)
  } finally {
    runtime.memory.free(pointer, 4)
  }
})

it('keeps damage available when native cleaning fails', async () => {
  let fail = true
  const instantiate = WebAssembly.instantiate
  vi.spyOn(WebAssembly, 'instantiate').mockImplementation(async (module, imports) => {
    const clean = imports?.env?.ghostty_render_state_clean
    if (typeof clean !== 'function') return instantiate(module, imports)
    return instantiate(module, {
      ...imports,
      env: {
        ...imports?.env,
        ghostty_render_state_clean: (...args: number[]) => (fail ? -1 : clean(...args)),
      },
    })
  })
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 4 })
  const state = runtime.createRenderState(terminal)
  terminal.write('pending')
  state.update()
  const damage = state.readRows({ dirtyOnly: true })
  expect(() => state.acknowledge()).toThrow('bridge_acknowledge')
  expect(state.readRows({ dirtyOnly: true })).toEqual(damage)
  fail = false
  expect(state.acknowledge()).toBe(4)
  expect(state.acknowledge()).toBe(0)
})
