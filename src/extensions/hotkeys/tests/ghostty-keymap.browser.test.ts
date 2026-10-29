import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../../core/runtime.js'
import { createGhosttyWebGpuTerminalFromSession } from '../../../dom/terminal.js'
import { TerminalSession } from '../../../term/session.js'
import { attachTerminalHotkeys } from '../index.js'
import type { TerminalHotkeysOptions } from '../connection.js'

const bindings = [
  { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, text: '\x01' },
  { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, text: '\x05' },
  { key: 'Backspace', code: 'Backspace', metaKey: true, text: '\x15' },
  { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, text: '\x1bb' },
  { key: 'ArrowRight', code: 'ArrowRight', altKey: true, text: '\x1bf' },
]
const cleanups: Array<() => void> = []
let runtime: GhosttyRuntime
beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})
afterAll(() => runtime.dispose())

async function fixture(options?: TerminalHotkeysOptions) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  const host = document.createElement('div')
  host.style.cssText = 'width:480px;height:160px;position:relative'
  document.body.append(host)
  cleanups.push(() => host.remove())
  const session = await TerminalSession.create<Event>({ runtime: { kind: 'borrowed', runtime } })
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: true,
    rendererMode: 'canvas2d-fill-text',
    inputHooks: { screenReaderMode: options?.screenReaderMode },
  })
  cleanups.push(() => terminal.dispose())
  attachTerminalHotkeys(terminal, options)
  await terminal.open(host)
  terminal.focus()
  const output: string[] = []
  terminal.onData(({ bytes }) => output.push(new TextDecoder().decode(bytes)))
  function key(type: string, init: KeyboardEventInit) {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    terminal.textarea!.dispatchEvent(event)
    return event
  }
  function stroke(init: KeyboardEventInit) {
    const press = key('keydown', init)
    key('keyup', init)
    return press
  }
  return { terminal, output, key, stroke }
}

describe.each(['legacy', 'kitty'] as const)('%s Ghostty Mac keymap', (protocol) => {
  it('sends five text actions with repeats and consumes releases', async () => {
    const f = await fixture()
    if (protocol === 'kitty') f.terminal.write('\x1b[>11u')
    for (const binding of bindings) {
      f.output.length = 0
      expect(f.key('keydown', binding).defaultPrevented).toBe(true)
      expect(f.key('keydown', { ...binding, repeat: true }).defaultPrevented).toBe(true)
      f.key('keyup', binding)
      expect(f.output).toEqual([binding.text, binding.text])
    }
    f.output.length = 0
    f.key('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true })
    f.stroke(bindings[0]!)
    f.key('keyup', { key: 'Meta', code: 'MetaLeft' })
    expect(f.output).toEqual(['\x01'])
  })
})

it('passes composition and extra modifiers to native encoding', async () => {
  const f = await fixture()
  f.key('keydown', { ...bindings[0], isComposing: true })
  expect(f.output).toEqual([])
  for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }]) {
    f.output.length = 0
    f.stroke({ ...bindings[0], ...modifiers })
    expect(f.output).not.toContain('\x01')
  }
  f.output.length = 0
  f.stroke({ key: '∫', code: 'KeyB', altKey: true })
  expect(f.output).toEqual(['∫'])
})

it('reads the screen-reader flag before each event and preserves browser defaults', async () => {
  let screenReader = true
  const f = await fixture({ mode: 'standalone', screenReaderMode: () => screenReader })
  for (const binding of bindings) {
    f.output.length = 0
    const press = f.stroke(binding)
    expect(f.output).not.toContain(binding.text)
    if ('metaKey' in binding) expect(press.defaultPrevented).toBe(false)
  }
  screenReader = false
  f.output.length = 0
  f.stroke(bindings[0]!)
  expect(f.output).toEqual(['\x01'])
})

it('allows an empty replacement keymap and keeps appended bindings', async () => {
  const f = await fixture({
    mode: 'standalone',
    keymap: [],
    bindings: [
      {
        keys: 'Meta+ArrowRight',
        command: 'terminal.sendKeystroke',
        args: { text: 'custom' },
        context: 'Terminal',
      },
    ],
  })
  f.stroke(bindings[0]!)
  expect(f.output).not.toContain('\x01')
  f.output.length = 0
  f.stroke(bindings[1]!)
  expect(f.output).toEqual(['custom'])
})

it('clears history and rows above the cursor while preserving the prompt and modes', async () => {
  const f = await fixture()
  f.terminal.write(Array.from({ length: 40 }, (_, index) => `history ${index}\r\n`).join(''))
  f.terminal.write('prompt> typing\x1b[?2004h\x1b[?1000h')
  f.terminal.selectAll()
  f.stroke({ key: 'k', code: 'KeyK', metaKey: true })
  expect(f.terminal.getSelection()).toBeUndefined()
  expect(f.terminal.geometry().cursor.y).toBe(0)
  expect(f.terminal.geometry().scrollbar.total).toBe(f.terminal.geometry().rows)
  expect(f.terminal.readLines(0, 1)[0]?.text.trim()).toBe('prompt> typing')
  expect(f.terminal.inputModes.mouseReporting).toBe(true)
  f.terminal.paste('paste')
  expect(f.output).toEqual(['\x1b[200~paste\x1b[201~'])
  f.stroke({ key: 'k', code: 'KeyK', metaKey: true })
  expect(f.terminal.readLines(0, 1)[0]?.text.trim()).toBe('prompt> typing')
})

it('leaves alternate-screen content and selection intact even with an unconditional clear binding', async () => {
  const f = await fixture({
    mode: 'standalone',
    keymap: [{ keys: 'Meta+K', command: 'terminal.clear', context: 'Terminal' }],
  })
  f.terminal.write('\x1b[?1049halt\r\napplication')
  f.terminal.selectAll()
  const selection = f.terminal.getSelection()
  f.stroke({ key: 'k', code: 'KeyK', metaKey: true })
  expect(f.terminal.readLines(0, 1)[0]?.text.trim()).toBe('alt')
  expect(f.terminal.geometry().cursor.y).toBe(1)
  expect(f.terminal.getSelection()).toBe(selection)
})

it.each(['mac', 'linux', 'windows'] as const)(
  'scrolls by pages and to history edges on %s',
  async (platform) => {
    const f = await fixture({ mode: 'standalone', platform })
    f.terminal.write(Array.from({ length: 60 }, (_, index) => `row ${index}\r\n`).join(''))
    const modifiers = platform === 'mac' ? { metaKey: true } : { shiftKey: true }
    const bottom = f.terminal.geometry().scrollbar.offset
    const rows = f.terminal.geometry().rows
    f.stroke({ key: 'PageUp', code: 'PageUp', ...modifiers })
    expect(f.terminal.geometry().scrollbar.offset).toBe(bottom - rows)
    f.stroke({ key: 'PageDown', code: 'PageDown', ...modifiers })
    expect(f.terminal.geometry().scrollbar.offset).toBe(bottom)
    f.stroke({ key: 'Home', code: 'Home', ...modifiers })
    expect(f.terminal.geometry().scrollbar.offset).toBe(0)
    f.stroke({ key: 'End', code: 'End', ...modifiers })
    expect(f.terminal.geometry().scrollbar.offset).toBe(bottom)
  },
)

it('flushes queued output before placing the prompt at the top', async () => {
  const f = await fixture()
  const queued = f.terminal.writeBatched('old\r\nprompt> ')
  f.stroke({ key: 'k', code: 'KeyK', metaKey: true })
  await queued
  expect(f.terminal.geometry().cursor.y).toBe(0)
  expect(f.terminal.readLines(0, 1)[0]?.text.trim()).toBe('prompt>')
})

it('preserves an alternate screen entered by queued output before clear', async () => {
  const f = await fixture()
  f.terminal.write('primary\r\nline')
  const queued = f.terminal.writeBatched('\x1b[?1049h\x1b[Halt\r\napplication')
  f.stroke({ key: 'k', code: 'KeyK', metaKey: true })
  await queued
  expect(f.terminal.inputModes.alternateScreen).toBe(true)
  expect(f.terminal.readLines(0, 1)[0]?.text.trim()).toBe('alt')
  expect(f.terminal.geometry().cursor.y).toBe(1)
})
