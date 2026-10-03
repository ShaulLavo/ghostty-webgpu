import { afterEach, describe, expect, it } from 'vitest'
import { ClipboardWriteResult, GhosttyResult, TerminalOption } from '../abi.js'
import { requireLayout } from '../memory.js'
import { GhosttyRuntime } from '../runtime.js'
import type { ClipboardWrite } from '../types.js'
import { installNativeCallbacks } from './native-callback.js'

interface UnknownOsc {
  readonly terminal: number
  readonly userdata: number
  readonly content: Uint8Array
  readonly terminator: number
  readonly truncated: boolean
}

let runtime: GhosttyRuntime | undefined
const decoder = new TextDecoder()

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

async function observer(native: GhosttyRuntime) {
  const sequences: UnknownOsc[] = []
  const indexes = await installNativeCallbacks(native, [
    {
      name: 'unknown',
      parameters: 3,
      returnsValue: false,
      call: (terminal = 0, userdata = 0, pointer = 0) => {
        const sequence = requireLayout(native.layouts, 'GhosttyTerminalUnknownSequence')
        expect(native.memory.view.getInt32(pointer + sequence.fields.tag!.offset, true)).toBe(1)
        const osc = requireLayout(native.layouts, 'GhosttyTerminalUnknownOscSequence')
        const value = pointer + sequence.fields.value!.offset
        const content = value + osc.fields.content!.offset
        const data = native.memory.view.getUint32(content, true)
        const length = native.memory.view.getUint32(content + 4, true)
        sequences.push({
          terminal,
          userdata,
          content: native.memory.bytes.slice(data, data + length),
          terminator: native.memory.view.getInt32(value + osc.fields.terminator!.offset, true),
          truncated: native.memory.view.getUint8(value + osc.fields.truncated!.offset) !== 0,
        })
      },
    },
  ])
  return { sequences, callback: indexes.unknown! }
}

function setOption(
  native: GhosttyRuntime,
  terminal: number,
  option: TerminalOption,
  value: number,
) {
  expect(native.exports.ghostty_terminal_set(terminal, option, value)).toBe(GhosttyResult.Success)
}

function setLimit(native: GhosttyRuntime, terminal: number, limit: number) {
  const pointer = native.memory.allocate(4)
  try {
    native.memory.view.setUint32(pointer, limit, true)
    setOption(native, terminal, TerminalOption.UnknownMaxBytes, pointer)
  } finally {
    native.memory.free(pointer, 4)
  }
}

describe('official native unknown OSC callback', () => {
  it.each([
    { name: 'BEL', chunks: ['\x07'], terminator: 1 },
    { name: 'ST', chunks: ['\x1b', '\\'], terminator: 0 },
  ])(
    'reports split $name sequences and copies borrowed payloads before returning',
    async ({ chunks, terminator }) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal()
      const capture = await observer(runtime)
      setOption(runtime, terminal.handle, TerminalOption.Userdata, 101)
      setOption(runtime, terminal.handle, TerminalOption.UnknownSequence, capture.callback)
      setLimit(runtime, terminal.handle, 2048)
      for (const chunk of ['\x1b', ']', '7400;', 'status=busy']) {
        terminal.write(chunk)
        expect(capture.sequences).toHaveLength(0)
      }
      for (const chunk of chunks) {
        terminal.write(chunk)
        expect(capture.sequences).toHaveLength(1)
      }
      expect(capture.sequences).toHaveLength(1)
      const first = capture.sequences[0]!
      expect(first).toMatchObject({
        terminal: terminal.handle,
        userdata: 101,
        terminator,
        truncated: false,
      })
      expect(decoder.decode(first.content)).toBe('7400;status=busy')
      expect(first.content.buffer).not.toBe(runtime.exports.memory.buffer)
      terminal.write('\x1b]7400;replacement\x07')
      expect(capture.sequences).toHaveLength(2)
      expect(decoder.decode(first.content)).toBe('7400;status=busy')
    },
  )

  it.each(['\x07', '\x1b\\'])(
    'reports truncation and drops CAN/SUB-cancelled sequences with %j',
    async (end) => {
      runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal()
      const capture = await observer(runtime)
      setOption(runtime, terminal.handle, TerminalOption.UnknownSequence, capture.callback)
      setLimit(runtime, terminal.handle, 8)
      terminal.write('\x1b]7400;abcdefgh')
      expect(capture.sequences).toHaveLength(0)
      terminal.write(end)
      expect(capture.sequences).toHaveLength(1)
      expect(decoder.decode(capture.sequences[0]!.content)).toBe('7400;abc')
      expect(capture.sequences[0]!.truncated).toBe(true)
      for (const cancel of ['\x18', '\x1a']) {
        terminal.write('\x1b]7400;cancelled')
        terminal.write(cancel + end)
      }
      expect(capture.sequences).toHaveLength(1)
      terminal.write('\x1b]7400;ok' + end)
      expect(capture.sequences).toHaveLength(2)
      expect(capture.sequences[1]!.truncated).toBe(false)
    },
  )

  it('preserves core title, hyperlink, color and OSC52 write-only behavior', async () => {
    runtime = await GhosttyRuntime.create()
    const writes: ClipboardWrite[] = []
    const replies: Uint8Array[] = []
    const terminal = runtime.createTerminal({
      effects: {
        clipboardWrite: (write) => {
          writes.push(write)
          return ClipboardWriteResult.Success
        },
        writePty: (bytes) => replies.push(bytes),
      },
    })
    const capture = await observer(runtime)
    setOption(runtime, terminal.handle, TerminalOption.UnknownSequence, capture.callback)
    setLimit(runtime, terminal.handle, 2048)
    terminal.write('\x1b]2;native title\x07\x1b]10;#123456\x1b\\')
    terminal.write('\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\')
    terminal.write('\x1b]52;c;Y29waWVk\x07\x1b]52;c;?\x1b\\')
    terminal.write('\x1b]52;malformed\x07\x1b]8;malformed\x07\x1b]4;malformed\x07')
    expect(terminal.title).toBe('native title')
    expect(terminal.colors.foreground).toEqual({ r: 0x12, g: 0x34, b: 0x56 })
    expect(terminal.linkAt({ tag: 'viewport', x: 0, y: 0 })).toBe('https://example.test')
    expect(writes).toHaveLength(1)
    expect(decoder.decode(writes[0]!.contents[0]!.data)).toBe('copied')
    expect(replies).toHaveLength(0)
    expect(capture.sequences).toHaveLength(0)

    const denied = runtime.createTerminal({ effects: { writePty: (bytes) => replies.push(bytes) } })
    setOption(runtime, denied.handle, TerminalOption.UnknownSequence, capture.callback)
    setLimit(runtime, denied.handle, 2048)
    denied.write('\x1b]52;c;Y29waWVk\x07\x1b]52;c;?\x07')
    expect(replies).toHaveLength(0)
    expect(capture.sequences).toHaveLength(0)
  })

  it('allocates nothing for disabled capture and the <=2048-byte path, with an allocating positive control', async () => {
    runtime = await GhosttyRuntime.create()
    const native = runtime
    const capture = await observer(native)
    const live = new Map<number, number>()
    let allocations = 0
    const callbacks = await installNativeCallbacks(native, [
      {
        name: 'alloc',
        parameters: 4,
        returnsValue: true,
        call: (_ctx = 0, length = 0, alignmentLog2 = 0) => {
          allocations += 1
          const pointer = native.exports.ghostty_wasm_alloc(length)
          expect(pointer % 2 ** alignmentLog2).toBe(0)
          if (pointer !== 0) live.set(pointer, length)
          return pointer
        },
      },
      { name: 'resize', parameters: 6, returnsValue: true, call: () => 0 },
      { name: 'remap', parameters: 6, returnsValue: true, call: () => 0 },
      {
        name: 'free',
        parameters: 5,
        returnsValue: false,
        call: (_ctx = 0, pointer = 0, length = 0) => {
          expect(live.get(pointer)).toBe(length)
          live.delete(pointer)
          native.exports.ghostty_wasm_free(pointer, length)
        },
      },
    ])
    const allocatorLayout = requireLayout(native.layouts, 'GhosttyAllocator')
    const vtableLayout = requireLayout(native.layouts, 'GhosttyAllocatorVtable')
    const allocator = native.memory.allocate(allocatorLayout.size)
    const vtable = native.memory.allocate(vtableLayout.size)
    const out = native.memory.allocateOpaque()
    let terminal = 0
    try {
      for (const [name, index] of Object.entries(callbacks)) {
        native.memory.view.setUint32(vtable + vtableLayout.fields[name]!.offset, index, true)
      }
      native.memory.view.setUint32(allocator + allocatorLayout.fields.vtable!.offset, vtable, true)
      expect(native.exports.ghostty_terminal_new(allocator, out, 80, 24)).toBe(
        GhosttyResult.Success,
      )
      terminal = native.memory.takeOpaque(out, 'ghostty_terminal_new')
      const input = native.memory.allocateBytes('\x1b]7400;' + 'x'.repeat(8192) + '\x07')
      const write = () =>
        native.exports.ghostty_terminal_vt_write(terminal, input.pointer, input.length)
      try {
        const before = allocations
        write()
        setOption(native, terminal, TerminalOption.UnknownSequence, capture.callback)
        write()
        expect(allocations - before).toBe(0)
        expect(capture.sequences).toHaveLength(0)
        setLimit(native, terminal, 2048)
        write()
        expect(allocations - before).toBe(0)
        expect(capture.sequences[0]!.content).toHaveLength(2048)
        expect(capture.sequences[0]!.truncated).toBe(true)
        setLimit(native, terminal, 16384)
        write()
        expect(allocations).toBeGreaterThan(before)
        expect(capture.sequences[1]!.content).toHaveLength(8197)
        expect(capture.sequences[1]!.truncated).toBe(false)
        setOption(native, terminal, TerminalOption.UnknownMaxBytes, 0)
        const disabled = allocations
        write()
        expect(allocations).toBe(disabled)
        expect(capture.sequences).toHaveLength(2)
        setOption(native, terminal, TerminalOption.UnknownSequence, 0)
        setLimit(native, terminal, 16384)
        write()
        expect(capture.sequences).toHaveLength(2)
      } finally {
        native.memory.freeBytes(input)
      }
    } finally {
      if (terminal !== 0) native.exports.ghostty_terminal_free(terminal)
      native.memory.freeOpaque(out)
      native.memory.free(vtable, vtableLayout.size)
      native.memory.free(allocator, allocatorLayout.size)
    }
    expect(live.size).toBe(0)
  })
})
