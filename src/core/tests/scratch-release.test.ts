import { expect, it, vi } from 'vitest'
import { GhosttyResult } from '../abi.js'
import type { AbiLayouts, GhosttyWasmExports } from '../abi.js'
import { WasmMemory } from '../memory.js'
import type { GhosttyRuntime } from '../runtime.js'
import { GhosttyTerminal } from '../terminal.js'

const layouts = {
  GhosttyTerminalScrollbar: {
    align: 8,
    fields: {
      len: { offset: 16, size: 8, type: 'u64' },
      offset: { offset: 8, size: 8, type: 'u64' },
      total: { offset: 0, size: 8, type: 'u64' },
    },
    kind: 'struct',
    size: 24,
  },
} as AbiLayouts

function fakeTerminal(get: (view: DataView, pointer: number) => number) {
  const wasm = new WebAssembly.Memory({ initial: 2 })
  let next = 8
  const free = vi.fn()
  const exports = {
    memory: wasm,
    ghostty_wasm_alloc(length: number) {
      const pointer = next
      next += length + 8
      return pointer
    },
    ghostty_wasm_free: free,
    ghostty_terminal_get: (_terminal: number, _data: number, pointer: number) =>
      get(new DataView(wasm.buffer), pointer),
  }
  const memory = new WasmMemory(exports as unknown as GhosttyWasmExports)
  const runtime = { ensureActive() {}, exports, layouts, memory } as unknown as GhosttyRuntime
  const terminal = Object.assign(Object.create(GhosttyTerminal.prototype), {
    disposed: false,
    handleValue: 1,
    runtime,
  }) as GhosttyTerminal
  const scratch = memory.borrow(1)
  memory.release(scratch, 1)
  return { free, memory, scratch, terminal }
}

const getters: readonly [string, (terminal: GhosttyTerminal) => unknown][] = [
  ['totalRows', (terminal) => terminal.totalRows],
  ['cursor', (terminal) => terminal.cursor],
  ['size', (terminal) => terminal.size],
  ['activeScreen', (terminal) => terminal.activeScreen],
  ['scrollbar', (terminal) => terminal.scrollbar],
]

it.each(getters)('releases scratch when the native %s call traps', (_name, read) => {
  const { memory, scratch, terminal } = fakeTerminal(() => {
    throw new Error('trap')
  })
  expect(() => read(terminal)).toThrow('trap')
  expect(memory.borrow(1)).toBe(scratch)
})

it.each(getters)('releases scratch when the native %s call fails', (_name, read) => {
  const { memory, scratch, terminal } = fakeTerminal(() => GhosttyResult.InvalidValue)
  expect(() => read(terminal)).toThrow('invalid value')
  expect(memory.borrow(1)).toBe(scratch)
})

it('releases scratch when decoding a scrollbar value throws', () => {
  const { memory, scratch, terminal } = fakeTerminal((view, pointer) => {
    view.setBigUint64(pointer, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true)
    return GhosttyResult.Success
  })
  expect(() => terminal.scrollbar).toThrow('exceeds Number.MAX_SAFE_INTEGER')
  expect(memory.borrow(1)).toBe(scratch)
})

it('frees the fallback allocation when a getter throws while scratch is busy', () => {
  const { free, memory, scratch, terminal } = fakeTerminal(() => {
    throw new Error('trap')
  })
  expect(memory.borrow(1)).toBe(scratch)
  expect(() => terminal.totalRows).toThrow('trap')
  expect(free).toHaveBeenCalledTimes(1)
  expect(free.mock.calls[0]![0]).not.toBe(scratch)
  memory.release(scratch, 1)
  expect(memory.borrow(1)).toBe(scratch)
})

it('releases scratch when the consumer of staged input throws', () => {
  const { memory, scratch } = fakeTerminal(() => GhosttyResult.Success)
  expect(() =>
    memory.withBytes('input', () => {
      throw new Error('boom')
    }),
  ).toThrow('boom')
  expect(memory.borrow(1)).toBe(scratch)
})
