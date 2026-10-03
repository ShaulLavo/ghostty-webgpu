import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyResult, TerminalOption } from '../abi.js'
import { GhosttyRuntime } from '../runtime.js'
import type { CustomOscObservation } from '../types.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  vi.restoreAllMocks()
  runtime?.dispose()
  runtime = undefined
})

it('makes no payload objects, copies or decodes for inactive and unmatched numbers', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal()
  const observations: CustomOscObservation[] = []
  const factory = vi.spyOn(
    runtime.bridge as unknown as {
      captureCustomOsc(...args: number[]): CustomOscObservation
    },
    'captureCustomOsc',
  )
  const copy = vi.spyOn(Uint8Array.prototype, 'slice')
  const decode = vi.spyOn(TextDecoder.prototype, 'decode')
  terminal.write('\x1b]7400;inactive\x07')
  const inactive = [factory.mock.calls.length, copy.mock.calls.length, decode.mock.calls.length]
  const unsubscribe = terminal.subscribeCustomOsc(7400, 1, (event) => observations.push(event))
  terminal.write('\x1b]7499;unmatched\x07')
  const unmatched = [factory.mock.calls.length, copy.mock.calls.length, decode.mock.calls.length]
  terminal.write('\x1b]7400;你好;status=busy\x1b\\')
  const interested = [factory.mock.calls.length, copy.mock.calls.length, decode.mock.calls.length]
  const text = new TextDecoder().decode(observations[0]!.payload)
  const decoded = decode.mock.calls.length
  unsubscribe()
  terminal.write('\x1b]7400;detached\x07')
  const detached = [factory.mock.calls.length, copy.mock.calls.length, decode.mock.calls.length]
  vi.restoreAllMocks()
  expect(inactive).toEqual([0, 0, 0])
  expect(unmatched).toEqual([0, 0, 0])
  expect(interested).toEqual([1, 1, 0])
  expect(decoded).toBe(1)
  expect(detached).toEqual([1, 1, 1])
  expect(text).toBe('你好;status=busy')
  expect(observations[0]).toMatchObject({
    number: 7400,
    generation: 1,
    terminator: 'st',
    truncated: false,
  })
})

it('keeps the safe-integer range and rejects noncanonical native-framed headers', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal()
  const observations: CustomOscObservation[] = []
  for (const number of [7400, 4294967296, Number.MAX_SAFE_INTEGER]) {
    terminal.subscribeCustomOsc(number, 1, (event) => observations.push(event))
  }
  for (const header of [
    '07400',
    '+7400',
    '-7400',
    '77x',
    '',
    '9007199254740992',
    '18446744073709551616',
  ]) {
    terminal.write(`\x1b]${header};body\x07`)
  }
  terminal.write('\x1b]7400\x07')
  expect(observations).toHaveLength(0)
  terminal.write('\x1b]7400;one\x07\x1b]4294967296;two\x07\x1b]9007199254740991;three\x07')
  expect(observations.map((event) => event.number)).toEqual([
    7400,
    4294967296,
    Number.MAX_SAFE_INTEGER,
  ])
  expect(observations.map((event) => new TextDecoder().decode(event.payload))).toEqual([
    'one',
    'two',
    'three',
  ])
  for (const number of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    expect(() => terminal.subscribeCustomOsc(number, 1, () => {})).toThrow('safe integers')
  }
})

it('copies arbitrary borrowed bytes before callback return and preserves split native terminators', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal()
  const observations: CustomOscObservation[] = []
  terminal.subscribeCustomOsc(7400, 7, (event) => observations.push(event))
  const bytes = Uint8Array.from([
    ...new TextEncoder().encode('\x1b]7400;'),
    255,
    128,
    59,
    254,
    27,
    92,
  ])
  for (const byte of bytes) terminal.write(Uint8Array.of(byte))
  terminal.write('\x1b]7400;replacement\x07')
  expect(observations[0]!.payload).toEqual(Uint8Array.from([255, 128, 59, 254]))
  expect(observations[0]!.terminator).toBe('st')
  expect(observations[1]!.terminator).toBe('bel')
  expect(observations[0]!.payload.buffer).not.toBe(runtime.exports.memory.buffer)
  terminal.write('\x1b]7400;cancel\x18\x1b]7400;cancel\x1a')
  expect(observations).toHaveLength(2)
})

it('bounds capture to the native fixed buffer and drops incomplete truncated identifiers', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal()
  const observations: CustomOscObservation[] = []
  terminal.subscribeCustomOsc(7400, 1, (event) => observations.push(event))
  terminal.write(`\x1b]7400;${'x'.repeat(10000)}\x07`)
  expect(observations[0]!.payload.length).toBe(2043)
  expect(observations[0]!.truncated).toBe(true)
  const limit = runtime.memory.allocate(4)
  try {
    runtime.memory.view.setUint32(limit, 2, true)
    expect(
      runtime.exports.ghostty_terminal_set(terminal.handle, TerminalOption.UnknownMaxBytes, limit),
    ).toBe(GhosttyResult.Success)
    terminal.write('\x1b]7400;body\x07')
    expect(observations).toHaveLength(1)
  } finally {
    runtime.memory.free(limit, 4)
  }
})

it('leaves native titles, hyperlinks, colors, queries and default-denied OSC52 owned by native code', async () => {
  runtime = await GhosttyRuntime.create()
  const replies: Uint8Array[] = []
  const terminal = runtime.createTerminal({ effects: { writePty: (bytes) => replies.push(bytes) } })
  const observations: CustomOscObservation[] = []
  for (const number of [0, 2, 8, 10, 52, 7400]) {
    terminal.subscribeCustomOsc(number, 1, (event) => observations.push(event))
  }
  terminal.write('\x1b]0;first\x07\x1b]2;native title\x07')
  expect(terminal.title).toBe('native title')
  terminal.write('\x1b]8;;https://example.com\x1b\\x\x1b]8;;\x1b\\')
  expect(terminal.linkAt({ tag: 'viewport', x: 0, y: 0 })).toBe('https://example.com')
  terminal.write('\x1b]10;rgb:11/22/33\x07\x1b]10;?\x07\x1b]52;c;aGVsbG8=\x07\x1b]52;c;?\x07')
  expect(observations).toHaveLength(0)
  expect(replies.length).toBeGreaterThan(0)
  terminal.write('\x1b]7400;custom\x07')
  expect(observations).toHaveLength(1)
  expect(terminal.title).toBe('native title')
})

it('uses native control-byte handling across byte-split Unicode and incomplete end of stream', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal()
  const observations: CustomOscObservation[] = []
  terminal.subscribeCustomOsc(7400, 1, (event) => observations.push(event))
  const bytes = new TextEncoder().encode('\x1b]7400;你好\x00\x11;state\x1b\\')
  for (const byte of bytes) terminal.write(Uint8Array.of(byte))
  expect(observations).toHaveLength(1)
  expect(new TextDecoder().decode(observations[0]!.payload)).toBe('你好;state')
  terminal.write('\x1b]7400;incomplete')
  terminal.dispose()
  expect(observations).toHaveLength(1)
})
