import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { Terminal as MainTerminal } from '../terminal.js'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'
import type { TerminalApi } from '../terminal-api.js'
import { createDomInputController } from '../input.js'
import { testFontUrl } from '../../tests/fonts.js'
import { TerminalSession } from '../../term/session.js'

const bindings = [
  { code: 'ArrowLeft', metaKey: true, text: '\x01' },
  { code: 'ArrowRight', metaKey: true, text: '\x05' },
  { code: 'Backspace', metaKey: true, text: '\x15' },
  { code: 'ArrowLeft', altKey: true, text: '\x1bb' },
  { code: 'ArrowRight', altKey: true, text: '\x1bf' },
]
const terminals: TerminalApi[] = []
const hosts: HTMLElement[] = []
let runtime: GhosttyRuntime

beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterEach(async () => {
  for (const terminal of terminals.splice(0)) await terminal.dispose()
  for (const host of hosts.splice(0)) host.remove()
  vi.restoreAllMocks()
})
afterAll(() => runtime.dispose())

it('preserves synchronous key hook ordering and screen-reader browser defaults', async () => {
  const session = await TerminalSession.create({ runtime: { kind: 'borrowed', runtime } })
  const textarea = document.createElement('textarea')
  const order: string[] = []
  session.on('data', () => order.push('data'))
  const controller = createDomInputController({
    platform: 'mac',
    textarea,
    session,
    signal: new AbortController().signal,
    hooks: {
      beforeUserInput: () => order.push('before'),
      onKey: () => order.push('key'),
      screenReaderMode: () => true,
    },
    onError: (cause) => {
      throw cause
    },
  })
  try {
    const command = key(textarea, 'keydown', bindings[0]!)
    expect(command.defaultPrevented).toBe(false)
    expect(order).toEqual(['before', 'key', 'data'])
    const option = key(textarea, 'keydown', bindings[3]!)
    expect(option.defaultPrevented).toBe(true)
  } finally {
    controller.dispose()
    session.dispose()
  }
})

function key(textarea: HTMLTextAreaElement, type: string, init: KeyboardEventInit) {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  textarea.dispatchEvent(event)
  return event
}

async function createTerminal(mode: 'main' | 'worker') {
  const terminal =
    mode === 'main'
      ? await MainTerminal.create({
          rendererMode: 'canvas2d-fill-text',
          runtime: { kind: 'borrowed', runtime },
        })
      : await WorkerTerminal.create({
          fonts: [{ family: 'MacKeybindingTest', source: { url: testFontUrl } }],
          workerUrl: new URL('../../../dist/worker/entry.js', import.meta.url),
          assets: {
            wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
            bridge: new URL('../../../bridge.wasm', import.meta.url).href,
          },
        })
  terminals.push(terminal)
  const host = document.createElement('div')
  host.style.cssText = 'width:480px;height:160px;position:relative'
  document.body.append(host)
  hosts.push(host)
  await terminal.open(host)
  return { terminal, textarea: host.querySelector('textarea')! }
}

describe.each(['main', 'worker'] as const)('%s macOS defaults', (mode) => {
  it.each(['legacy', 'kitty'] as const)(
    'sends native text bindings in %s mode, including repeats without releases',
    async (protocol) => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
      const { terminal, textarea } = await createTerminal(mode)
      const output: string[] = []
      terminal.onData(({ bytes }) => output.push(new TextDecoder().decode(bytes)))
      if (protocol === 'kitty') await terminal.write('\x1b[>11u')
      for (const binding of bindings) {
        const start = output.length
        const press = key(textarea, 'keydown', binding)
        const repeat = key(textarea, 'keydown', { ...binding, repeat: true })
        key(textarea, 'keyup', binding)
        await expect.poll(() => output.slice(start)).toEqual([binding.text, binding.text])
        expect(press.defaultPrevented).toBe(true)
        expect(repeat.defaultPrevented).toBe(true)
      }
      const start = output.length
      key(textarea, 'keydown', { code: 'MetaLeft', metaKey: true })
      key(textarea, 'keydown', bindings[0]!)
      key(textarea, 'keyup', bindings[0]!)
      key(textarea, 'keyup', { code: 'MetaLeft' })
      await expect.poll(() => output.slice(start)).toEqual(['\x01'])
    },
  )
})

it.each(['linux', 'windows'] as const)('keeps %s keys on the VT encoder path', (platform) => {
  const textarea = document.createElement('textarea')
  const encoded: string[] = []
  const sent: unknown[] = []
  const controller = createDomInputController({
    platform,
    textarea,
    signal: new AbortController().signal,
    onError: (cause) => {
      throw cause
    },
    session: {
      getSelection: () => undefined,
      selectionCoordinates: () => undefined,
      key: (input) => {
        encoded.push(input.code)
        return new Uint8Array()
      },
      paste: () => new Uint8Array(),
      sendInput: (data) => {
        sent.push(data)
        return new Uint8Array()
      },
    },
  })
  try {
    for (const binding of bindings) key(textarea, 'keydown', binding)
    expect(encoded).toEqual(bindings.map((binding) => binding.code))
    expect(sent).toEqual([])
  } finally {
    controller.dispose()
  }
})

it('honors claims, disabled input, composition, extra modifiers, and key hooks', () => {
  const textarea = document.createElement('textarea')
  const sent: unknown[] = []
  const notifications: string[] = []
  let claimed = true
  let disabled = false
  const controller = createDomInputController({
    platform: 'mac',
    textarea,
    signal: new AbortController().signal,
    claimKey: () => claimed,
    hooks: {
      inputDisabled: () => disabled,
      beforeUserInput: () => notifications.push('before'),
      onKey: (event, bytes) => notifications.push(`${event.code}:${Array.from(bytes).join(',')}`),
    },
    onError: (cause) => {
      throw cause
    },
    session: {
      getSelection: () => undefined,
      selectionCoordinates: () => undefined,
      key: () => new Uint8Array(),
      paste: () => new Uint8Array(),
      sendInput: (data) => {
        sent.push(data)
        return new TextEncoder().encode(String(data))
      },
    },
  })
  const left = bindings[0]!
  try {
    key(textarea, 'keydown', left)
    claimed = false
    controller.resetTransientState()
    disabled = true
    key(textarea, 'keydown', left)
    disabled = false
    controller.resetTransientState()
    key(textarea, 'keydown', { ...left, isComposing: true })
    controller.resetTransientState()
    key(textarea, 'keydown', { ...left, shiftKey: true })
    key(textarea, 'keydown', { ...left, ctrlKey: true })
    key(textarea, 'keydown', { ...left, altKey: true })
    expect(sent).toEqual([])
    controller.resetTransientState()
    notifications.length = 0
    key(textarea, 'keydown', left)
    key(textarea, 'keyup', left)
    expect(sent).toEqual(['\x01'])
    expect(notifications).toEqual(['before', 'ArrowLeft:1'])
  } finally {
    controller.dispose()
  }
})
