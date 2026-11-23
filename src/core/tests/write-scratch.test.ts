import { afterEach, expect, it, vi } from 'vitest'
import { WASM_SCRATCH_BYTES } from '../memory.js'
import { GhosttyRuntime } from '../runtime.js'
import type { GhosttyTerminal } from '../terminal.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
  vi.restoreAllMocks()
})

function screenText(terminal: GhosttyTerminal): string[] {
  const end = terminal.lineCount()
  return terminal.readLines(end - terminal.size.rows, end).map((line) => line.text)
}

it('stages ASCII, multi-byte, astral and lone-surrogate strings without allocating', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 20, rows: 3 })
  terminal.write('warm')
  const allocate = vi.spyOn(runtime.memory, 'allocateRaw')
  const free = vi.spyOn(runtime.memory, 'free')
  terminal.write('\r\nhé界😀\ud800!')
  terminal.write(new TextEncoder().encode('\r\nbytes'))
  terminal.write('')
  expect(allocate).not.toHaveBeenCalled()
  expect(free).not.toHaveBeenCalled()
  expect(screenText(terminal)).toEqual(['warm', 'hé界😀�!', 'bytes'])
})

it('copies a view of linear memory before the cold scratch allocation grows memory', async () => {
  runtime = await GhosttyRuntime.create()
  const memory = runtime.memory
  const terminal = runtime.createTerminal({ columns: 20, rows: 2 })
  const pointer = memory.allocate(4)
  memory.bytes.set(new TextEncoder().encode('abcd'), pointer)
  const input = memory.bytes.subarray(pointer, pointer + 4)
  const allocateRaw = memory.allocateRaw.bind(memory)
  const wasm = runtime.exports.memory
  const allocate = vi.spyOn(memory, 'allocateRaw').mockImplementation((length) => {
    // Force the growth that detaches every existing view of linear memory.
    wasm.grow(1)
    return allocateRaw(length)
  })
  terminal.write(input)
  expect(allocate).toHaveBeenCalledWith(WASM_SCRATCH_BYTES)
  allocate.mockRestore()
  memory.free(pointer, 4)
  const warm = vi.spyOn(memory, 'allocateRaw')
  terminal.write('ef')
  expect(warm).not.toHaveBeenCalled()
  expect(screenText(terminal)[0]).toBe('abcdef')
})

it('falls back to allocation for input larger than the scratch region', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 16, rows: 2 })
  terminal.write('warm')
  const allocate = vi.spyOn(runtime.memory, 'allocateRaw')
  const bytes = new Uint8Array(WASM_SCRATCH_BYTES + 1).fill(0x61)
  terminal.write(bytes)
  expect(allocate).toHaveBeenLastCalledWith(WASM_SCRATCH_BYTES + 1)
  // Fewer UTF-16 units than scratch bytes, but its UTF-8 overflows the region.
  const wide = '\r\n' + 'é'.repeat(WASM_SCRATCH_BYTES / 2) + '\r\ntail'
  terminal.write(wide)
  expect(allocate).toHaveBeenLastCalledWith(new TextEncoder().encode(wide).length)
  expect(screenText(terminal)).toEqual(['é'.repeat(16), 'tail'])
})

it('gives reentrant writes from native callbacks their own buffer', async () => {
  runtime = await GhosttyRuntime.create()
  const replies: number[] = []
  let nested = true
  const terminal = runtime.createTerminal({
    columns: 20,
    rows: 2,
    effects: {
      writePty: (reply) => {
        replies.push(reply.length)
        if (!nested) return
        nested = false
        // The outer input still occupies the scratch region at this point.
        expect(terminal.scrollbar.total).toBeGreaterThan(0)
        terminal.write('inner-')
      },
    },
  })
  terminal.write('\x1b[cafter')
  expect(replies.length).toBeGreaterThan(0)
  expect(screenText(terminal)[0]).toBe('inner-after')
  terminal.write('\r\nagain')
  expect(screenText(terminal)[1]).toBe('again')
})

it('borrows zeroed scratch bytes once and falls back while they are busy', async () => {
  runtime = await GhosttyRuntime.create()
  const memory = runtime.memory
  const first = memory.borrow(16)
  memory.bytes.fill(7, first, first + 16)
  const second = memory.borrow(16)
  expect(second).not.toBe(first)
  memory.release(second, 16)
  memory.release(first, 16)
  expect(memory.borrow(16)).toBe(first)
  expect(Array.from(memory.bytes.subarray(first, first + 16))).toEqual(Array(16).fill(0))
  memory.release(first, 16)
  const large = memory.borrow(WASM_SCRATCH_BYTES + 1)
  expect(large).not.toBe(first)
  memory.release(large, WASM_SCRATCH_BYTES + 1)
})

it('reads state and scrolls through cached offsets without allocating', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 10, rows: 3 })
  terminal.write(Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\r\n'))
  expect(terminal.scrollbar).toEqual({ length: 3, offset: 9, total: 12 })
  const allocate = vi.spyOn(runtime.memory, 'allocateRaw')
  terminal.scrollBy(-4)
  expect(terminal.scrollbar).toEqual({ length: 3, offset: 5, total: 12 })
  expect(terminal.viewportActive).toBe(false)
  terminal.scrollToTop()
  expect(terminal.scrollbar.offset).toBe(0)
  terminal.scrollToRow(2)
  expect(terminal.scrollbar.offset).toBe(2)
  terminal.scrollToBottom()
  expect(terminal.viewportActive).toBe(true)
  expect(terminal.cursor).toMatchObject({ x: 7, y: 2 })
  expect(terminal.hasSelection).toBe(false)
  expect(terminal.mouseTracking).toBe(false)
  expect(terminal.size).toMatchObject({ columns: 10, rows: 3 })
  expect(allocate).not.toHaveBeenCalled()
})

it('shares one frozen layout table across runtimes and frees scratch on dispose', async () => {
  const first = await GhosttyRuntime.create()
  runtime = await GhosttyRuntime.create()
  first.createTerminal().write('x')
  const free = vi.spyOn(first.memory, 'free')
  first.dispose()
  expect(free).toHaveBeenCalledWith(expect.any(Number), WASM_SCRATCH_BYTES)
  expect(runtime.layouts).toBe(first.layouts)
  expect(Object.isFrozen(runtime.layouts)).toBe(true)
  expect(Object.isFrozen(runtime.layouts.GhosttyTerminalScrollbar)).toBe(true)
})
