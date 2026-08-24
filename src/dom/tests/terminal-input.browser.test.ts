import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { SelectionCoordinates } from '../../core/selection.js'
import type { RendererTheme } from '../../render/instances/types.js'
import type { RendererGridSize, WebGpuTerminalRendererOptions } from '../../render/renderer.js'
import type { TerminalFittedFont, TerminalKeyInput } from '../../term/types.js'
import { createDomInputController } from '../input.js'
import { GhosttyWebGpuTerminal } from '../terminal.js'
import type {
  GhosttyWebGpuRenderer,
  GhosttyWebGpuRendererFactory,
  GhosttyWebGpuTerminalOptions,
} from '../types.js'

const decoder = new TextDecoder()

class RecordingRenderer implements GhosttyWebGpuRenderer {
  cursorBlink: boolean[] = []
  disposeCount = 0
  documentVisible: boolean[] = []
  focused: boolean[] = []
  fonts: TerminalFittedFont[] = []
  readonly hasPendingFrame = false
  readonly hasPendingTimer = false
  notifications: string[] = []
  onResize?: () => void
  resizes: RendererGridSize[] = []
  themes: Partial<RendererTheme>[] = []

  dispose(): void {
    this.disposeCount += 1
  }

  notifyScroll(): void {
    this.notifications.push('scroll')
  }

  notifySelectionChange(): void {
    this.notifications.push('selection')
  }

  notifyWrite(): void {
    this.notifications.push('write')
  }

  resize(grid: RendererGridSize): void {
    this.onResize?.()
    this.resizes.push({ ...grid })
    this.notifications.push('resize')
  }

  schedule(): void {
    this.notifications.push('schedule')
  }

  setCursorBlinkEnabled(enabled: boolean): void {
    this.cursorBlink.push(enabled)
  }

  setDocumentVisible(visible: boolean): void {
    this.documentVisible.push(visible)
  }

  setFocused(focused: boolean): void {
    this.focused.push(focused)
  }

  setFont(font: TerminalFittedFont): void {
    this.fonts.push(font)
  }

  setTheme(theme: Partial<RendererTheme>): void {
    this.themes.push(theme)
  }
}

interface RendererRecording {
  options?: WebGpuTerminalRendererOptions
  renderer?: RecordingRenderer
}

function recordingRendererFactory(recording: RendererRecording): GhosttyWebGpuRendererFactory {
  return async (options) => {
    const renderer = new RecordingRenderer()
    recording.options = options
    recording.renderer = renderer
    return renderer
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolveValue: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve
  })
  return { promise, resolve: resolveValue }
}

function createHost(width = 360, height = 180): HTMLDivElement {
  const host = document.createElement('div')
  host.style.height = `${height}px`
  host.style.width = `${width}px`
  document.body.append(host)
  return host
}

function keyboardEvent(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit,
  states?: Readonly<Record<string, boolean>>,
): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  if (!states) return event
  const fallback = event.getModifierState.bind(event)
  Object.defineProperty(event, 'getModifierState', {
    value: (key: string) => (key in states ? states[key] : fallback(key)),
  })
  return event
}

function dispatchKey(
  target: HTMLTextAreaElement,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit,
  states?: Readonly<Record<string, boolean>>,
): KeyboardEvent {
  const event = keyboardEvent(type, init, states)
  target.dispatchEvent(event)
  return event
}

function dispatchInput(
  target: HTMLTextAreaElement,
  value: string,
  init: InputEventInit,
): InputEvent {
  target.value = value
  const event = new InputEvent('input', { bubbles: true, ...init })
  target.dispatchEvent(event)
  return event
}

function dispatchComposition(target: HTMLTextAreaElement, type: string, data = ''): void {
  target.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }))
}

function primaryModifier(view: Window = window): Pick<KeyboardEventInit, 'ctrlKey' | 'metaKey'> {
  const apple = /^(Mac|iPhone|iPad|iPod)/iu.test(view.navigator.platform)
  return apple ? { metaKey: true } : { ctrlKey: true }
}

async function animationFrames(count = 2): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

async function settleRenderer(terminal: GhosttyWebGpuTerminal): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await animationFrames(1)
    if (!terminal.hasPendingFrame && !terminal.hasPendingTimer) return
  }
  throw new Error('Renderer did not settle')
}

function decodedOutput(output: readonly Uint8Array[]): string[] {
  return output.map((bytes) => decoder.decode(bytes))
}

describe.sequential('GhosttyWebGpuTerminal DOM host', () => {
  let runtime: GhosttyRuntime
  const hosts: HTMLElement[] = []
  const terminals: GhosttyWebGpuTerminal[] = []

  beforeAll(async () => {
    runtime = await GhosttyRuntime.create()
  })

  afterEach(() => {
    for (const terminal of terminals.splice(0)) terminal.dispose()
    for (const host of hosts.splice(0)) host.remove()
  })

  afterAll(() => {
    runtime.dispose()
  })

  function trackedHost(width = 360, height = 180): HTMLDivElement {
    const host = createHost(width, height)
    hosts.push(host)
    return host
  }

  async function trackedTerminal(
    options: GhosttyWebGpuTerminalOptions = {},
  ): Promise<GhosttyWebGpuTerminal> {
    const terminal = await GhosttyWebGpuTerminal.create({
      ...options,
      runtime: { kind: 'borrowed', runtime },
    })
    terminals.push(terminal)
    return terminal
  }

  it('opens a real WebGPU renderer, preserves the host, and leaves idle cleanup empty', async () => {
    const host = trackedHost()
    host.dataset.owner = 'caller'
    host.style.border = '1px solid transparent'
    const existing = document.createElement('span')
    existing.textContent = 'keep'
    host.append(existing)
    const terminal = await trackedTerminal({ appearance: { cursor: { blink: false } } })

    await terminal.open(host)
    await settleRenderer(terminal)

    expect(terminal.lifecycle).toBe('open')
    expect(terminal.canvas?.width).toBeGreaterThan(0)
    expect(terminal.canvas?.height).toBeGreaterThan(0)
    expect(terminal.hasPendingFrame).toBe(false)
    expect(terminal.hasPendingTimer).toBe(false)
    expect(host.dataset.owner).toBe('caller')
    expect(host.style.border).toContain('1px')

    terminal.dispose()
    expect(terminal.lifecycle).toBe('disposed')
    expect(Array.from(host.children)).toEqual([existing])
    expect(() => runtime.ensureActive()).not.toThrow()
    await expect(terminal.open(host)).rejects.toThrow('cannot open')
  })

  it('unwinds renderer failures and disposes a renderer that resolves after cancellation', async () => {
    const failedHost = trackedHost()
    const failed = await trackedTerminal({
      rendererFactory: async () => {
        throw new Error('renderer failed')
      },
    })

    await expect(failed.open(failedHost)).rejects.toThrow('renderer failed')
    expect(failed.lifecycle).toBe('disposed')
    expect(failedHost.querySelector('.ghostty-webgpu')).toBeNull()

    const pendingHost = trackedHost()
    const pendingRenderer = new RecordingRenderer()
    const creation = deferred<GhosttyWebGpuRenderer>()
    const pending = await trackedTerminal({ rendererFactory: () => creation.promise })
    const opening = pending.open(pendingHost)
    await Promise.resolve()
    pending.dispose()
    creation.resolve(pendingRenderer)

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(pendingRenderer.disposeCount).toBe(1)
    expect(pendingHost.querySelector('.ghostty-webgpu')).toBeNull()
    expect(() => runtime.ensureActive()).not.toThrow()
  })

  it('routes printable and Kitty press, repeat, and release keys through real wasm', async () => {
    const recording: RendererRecording = {}
    const terminal = await trackedTerminal({ rendererFactory: recordingRendererFactory(recording) })
    const manualPress: TerminalKeyInput = Object.freeze({
      action: 'press',
      code: 'KeyA',
      composing: false,
      text: 'a',
    })
    expect(() => terminal.key(manualPress)).toThrow('not open')
    await terminal.open(trackedHost())
    const textarea = terminal.textarea!
    const output: Uint8Array[] = []
    terminal.onData((bytes) => output.push(bytes))

    const plain = dispatchKey(textarea, 'keydown', { code: 'KeyA', key: 'a' })
    expect(plain.defaultPrevented).toBe(true)
    expect(decodedOutput(output)).toEqual(['a'])

    output.length = 0
    terminal.write('\u001b[>11u')
    const press = dispatchKey(textarea, 'keydown', { code: 'KeyA', key: 'a' })
    const repeat = dispatchKey(textarea, 'keydown', { code: 'KeyA', key: 'a', repeat: true })
    const release = dispatchKey(textarea, 'keyup', { code: 'KeyA', key: 'a' })

    expect([press.defaultPrevented, repeat.defaultPrevented, release.defaultPrevented]).toEqual([
      true,
      true,
      true,
    ])
    expect(decodedOutput(output)).toEqual(['\u001b[97u', '\u001b[97;1:2u', '\u001b[97;1:3u'])
    expect(recording.renderer?.notifications).toContain('write')

    const expected = output.map((bytes) => bytes.slice())
    output.length = 0
    const manualInputs: readonly TerminalKeyInput[] = Object.freeze([
      manualPress,
      Object.freeze({ ...manualPress, action: 'repeat' }),
      Object.freeze({ ...manualPress, action: 'release' }),
    ])
    const returned = manualInputs.map((input) => terminal.key(input))
    expect(returned).toEqual(expected)
    expect(output).toEqual(expected)

    terminal.dispose()
    expect(() => terminal.key(manualPress)).toThrow('disposed')
  })

  it('tracks modifier sides, locks, AltGraph consumption, and unknown-code fallback', () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    hosts.push(textarea)
    const keys: TerminalKeyInput[] = []
    const abort = new AbortController()
    const session = {
      getSelection: () => undefined,
      key: (input: TerminalKeyInput) => {
        keys.push(input)
        return new Uint8Array()
      },
      paste: () => new Uint8Array(),
      selectionCoordinates: () => undefined,
      sendInput: () => new Uint8Array(),
      setFocused: () => new Uint8Array(),
    }
    const controller = createDomInputController({
      onError: (cause) => {
        throw cause
      },
      platform: 'linux',
      session,
      signal: abort.signal,
      textarea,
    })

    dispatchKey(textarea, 'keydown', { code: 'ControlRight', ctrlKey: true, key: 'Control' })
    dispatchKey(textarea, 'keydown', { code: 'KeyC', ctrlKey: true, key: 'c' })
    expect(keys.at(-1)?.modifiers?.control).toBe('right')

    dispatchKey(textarea, 'keydown', { code: 'ControlLeft', ctrlKey: true, key: 'Control' })
    dispatchKey(textarea, 'keydown', { code: 'KeyC', ctrlKey: true, key: 'c' })
    expect(keys.at(-1)?.modifiers?.control).toBe('unknown')

    controller.resetTransientState()
    dispatchKey(textarea, 'keydown', { code: 'ControlLeft', ctrlKey: true, key: 'Control' })
    dispatchKey(textarea, 'keydown', { altKey: true, code: 'AltRight', ctrlKey: true, key: 'Alt' })
    dispatchKey(
      textarea,
      'keydown',
      { altKey: true, code: 'KeyQ', ctrlKey: true, key: '@' },
      { Alt: true, AltGraph: true, Control: true },
    )
    expect(keys.at(-1)?.consumedModifiers).toMatchObject({ alt: 'right', control: 'left' })

    dispatchKey(textarea, 'keydown', { code: 'KeyA', key: 'A' }, { CapsLock: true })
    expect(keys.at(-1)).toMatchObject({
      code: 'KeyA',
      consumedModifiers: { capsLock: true },
      modifiers: { capsLock: true },
    })
    dispatchKey(textarea, 'keydown', { code: 'Numpad1', key: '1' }, { NumLock: true })
    expect(keys.at(-1)?.consumedModifiers).toMatchObject({ numLock: true })

    for (const code of ['IntlYen', 'F24', 'NumpadMemorySubtract', 'AudioVolumeUp']) {
      dispatchKey(textarea, 'keydown', { code, key: code })
    }
    expect(keys.slice(-4).map((key) => key.code)).toEqual([
      'IntlYen',
      'F24',
      'NumpadMemorySubtract',
      'AudioVolumeUp',
    ])

    const beforeUnknown = keys.length
    const unknown = dispatchKey(textarea, 'keydown', { code: 'FutureVendorKey', key: 'x' })
    expect(keys).toHaveLength(beforeUnknown)
    expect(unknown.defaultPrevented).toBe(false)
    controller.dispose()
  })

  it('commits CJK, emoji, dead-key, replacement, and identical IME input exactly once', async () => {
    const terminal = await trackedTerminal({ rendererFactory: recordingRendererFactory({}) })
    await terminal.open(trackedHost())
    const textarea = terminal.textarea!
    const output: Uint8Array[] = []
    terminal.onData((bytes) => output.push(bytes))

    dispatchComposition(textarea, 'compositionstart')
    dispatchInput(textarea, 'に', {
      data: 'に',
      inputType: 'insertCompositionText',
      isComposing: true,
    })
    dispatchComposition(textarea, 'compositionend', '日本')
    dispatchInput(textarea, '日本', { data: '日本', inputType: 'insertText', isComposing: false })

    dispatchComposition(textarea, 'compositionstart')
    dispatchInput(textarea, '😀', { data: '😀', inputType: 'insertText', isComposing: false })
    dispatchComposition(textarea, 'compositionend', '😀')

    const dead = dispatchKey(textarea, 'keydown', { code: 'Quote', key: 'Dead' })
    dispatchComposition(textarea, 'compositionstart')
    dispatchComposition(textarea, 'compositionend', 'é')
    dispatchInput(textarea, 'é', { data: 'é', inputType: 'insertText', isComposing: false })

    dispatchInput(textarea, 'replacement', {
      data: null,
      inputType: 'insertReplacementText',
      isComposing: false,
    })
    dispatchInput(textarea, 'same', { data: 'same', inputType: 'insertText' })
    dispatchInput(textarea, 'same', { data: 'same', inputType: 'insertText' })

    expect(dead.defaultPrevented).toBe(false)
    expect(decodedOutput(output)).toEqual(['日本', '😀', 'é', 'replacement', 'same', 'same'])
    expect(textarea.value).toBe('')
  })

  it('routes paste fallbacks and focus reports without duplicate shortcut keys', async () => {
    const terminal = await trackedTerminal({ rendererFactory: recordingRendererFactory({}) })
    await terminal.open(trackedHost())
    const textarea = terminal.textarea!
    const output: Uint8Array[] = []
    terminal.onData((bytes) => output.push(bytes))

    terminal.write('\u001b[?1004h')
    terminal.focus()
    terminal.blur()
    expect(decodedOutput(output)).toEqual(['\u001b[I', '\u001b[O'])

    output.length = 0
    const pasteKey = dispatchKey(textarea, 'keydown', {
      code: 'KeyV',
      key: 'v',
      ...primaryModifier(),
    })
    const pasteRepeat = dispatchKey(textarea, 'keydown', {
      code: 'KeyV',
      key: 'v',
      repeat: true,
      ...primaryModifier(),
    })
    const pasteRelease = dispatchKey(textarea, 'keyup', {
      code: 'KeyV',
      key: 'v',
      ...primaryModifier(),
    })
    expect(pasteKey.defaultPrevented).toBe(false)
    expect(pasteRepeat.defaultPrevented).toBe(true)
    expect(pasteRelease.defaultPrevented).toBe(false)
    expect(output).toHaveLength(0)

    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'first\nsecond')
    const paste = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    })
    textarea.dispatchEvent(paste)
    const unavailablePaste = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    textarea.dispatchEvent(unavailablePaste)
    dispatchInput(textarea, 'fallback\nvalue', {
      data: null,
      inputType: 'insertFromPaste',
    })

    expect(paste.defaultPrevented).toBe(true)
    expect(unavailablePaste.defaultPrevented).toBe(false)
    expect(decodedOutput(output)).toEqual(['first\rsecond', 'fallback\rvalue'])
  })

  it('keeps focus and visibility lifecycle active when keyboard transport is manual', async () => {
    const recording: RendererRecording = {}
    const terminal = await trackedTerminal({
      keyboard: false,
      rendererFactory: recordingRendererFactory(recording),
    })
    await terminal.open(trackedHost())
    const textarea = terminal.textarea!
    const output: Uint8Array[] = []
    terminal.onData((bytes) => output.push(bytes))

    terminal.write('\u001b[?1004h')
    terminal.focus()
    terminal.blur()
    expect(decodedOutput(output)).toEqual(['\u001b[I', '\u001b[O'])
    expect(recording.renderer?.focused).toEqual([true, false])

    output.length = 0
    const key = dispatchKey(textarea, 'keydown', { code: 'KeyA', key: 'a' })
    dispatchKey(textarea, 'keyup', { code: 'KeyA', key: 'a' })
    dispatchComposition(textarea, 'compositionstart')
    dispatchComposition(textarea, 'compositionend', '日本')
    dispatchInput(textarea, '日本', { data: '日本', inputType: 'insertText' })
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'paste')
    const paste = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    })
    textarea.dispatchEvent(paste)

    expect(key.defaultPrevented).toBe(false)
    expect(paste.defaultPrevented).toBe(false)
    expect(output).toEqual([])

    const visibilityCount = recording.renderer!.documentVisible.length
    textarea.ownerDocument.dispatchEvent(new Event('visibilitychange'))
    expect(recording.renderer!.documentVisible).toHaveLength(visibilityCount + 1)

    const manual = terminal.key({ action: 'press', code: 'KeyA', composing: false, text: 'a' })
    expect(decoder.decode(manual)).toBe('a')
    expect(decodedOutput(output)).toEqual(['a'])

    const visibleAfterManual = recording.renderer!.documentVisible.length
    terminal.dispose()
    terminal.dispose()
    dispatchKey(textarea, 'keydown', { code: 'KeyB', key: 'b' })
    textarea.ownerDocument.dispatchEvent(new Event('visibilitychange'))
    expect(decodedOutput(output)).toEqual(['a'])
    expect(recording.renderer!.documentVisible).toHaveLength(visibleAfterManual)
  })

  it('reserves copy once, suppresses repeat/release, and removes listeners on direct disposal', () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    hosts.push(textarea)
    const keys: TerminalKeyInput[] = []
    const copies: string[] = []
    const selection: SelectionCoordinates = {
      end: { x: 3, y: 0 },
      rectangle: false,
      start: { x: 0, y: 0 },
    }
    const controller = createDomInputController({
      copySelection: (text) => {
        copies.push(text)
      },
      onError: (cause) => {
        throw cause
      },
      platform: 'mac',
      session: {
        getSelection: () => 'copy me',
        key: (input) => {
          keys.push(input)
          return new Uint8Array()
        },
        paste: () => new Uint8Array(),
        selectionCoordinates: () => selection,
        sendInput: () => new Uint8Array(),
      },
      signal: new AbortController().signal,
      textarea,
    })

    dispatchKey(textarea, 'keydown', { altKey: true, code: 'AltLeft', key: 'Alt' })
    dispatchKey(textarea, 'keydown', { altKey: true, code: 'KeyE', key: 'é' })
    expect(keys.at(-1)?.consumedModifiers).toMatchObject({ alt: 'left' })
    keys.length = 0

    const press = dispatchKey(textarea, 'keydown', { code: 'KeyC', key: 'c', metaKey: true })
    const repeat = dispatchKey(textarea, 'keydown', {
      code: 'KeyC',
      key: 'c',
      metaKey: true,
      repeat: true,
    })
    const release = dispatchKey(textarea, 'keyup', { code: 'KeyC', key: 'c', metaKey: true })

    expect(copies).toEqual(['copy me'])
    expect(keys).toHaveLength(0)
    expect([press.defaultPrevented, repeat.defaultPrevented, release.defaultPrevented]).toEqual([
      true,
      true,
      false,
    ])

    dispatchKey(textarea, 'keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true })
    keys.length = 0
    dispatchKey(textarea, 'keydown', { code: 'KeyC', key: 'c', metaKey: true })
    dispatchKey(textarea, 'keyup', { code: 'MetaLeft', key: 'Meta' })
    keys.length = 0
    const freshPress = dispatchKey(textarea, 'keydown', { code: 'KeyC', key: 'c' })
    const freshRelease = dispatchKey(textarea, 'keyup', { code: 'KeyC', key: 'c' })

    expect(copies).toEqual(['copy me', 'copy me'])
    expect(keys.map((input) => [input.code, input.action])).toEqual([
      ['KeyC', 'press'],
      ['KeyC', 'release'],
    ])
    expect([freshPress.defaultPrevented, freshRelease.defaultPrevented]).toEqual([false, false])

    controller.dispose()
    dispatchKey(textarea, 'keydown', { code: 'KeyA', key: 'a' })
    expect(keys).toHaveLength(2)
  })

  it('replaces defaults, preserves declaration order, and keeps shortcut state instance-local', () => {
    const host = document.createElement('div')
    const textarea = document.createElement('textarea')
    host.append(textarea)
    document.body.append(host)
    hosts.push(host)
    const keys: TerminalKeyInput[] = []
    const calls: string[] = []
    const copies: string[] = []
    const sent: string[] = []
    const pasted: string[] = []
    const bubbled: string[] = []
    host.addEventListener('keydown', (event) => bubbled.push(event.code))
    const selection: SelectionCoordinates = {
      end: { x: 3, y: 0 },
      rectangle: false,
      start: { x: 0, y: 0 },
    }
    const controller = createDomInputController({
      copySelection: (text) => {
        copies.push(text)
      },
      onError: (cause) => {
        throw cause
      },
      platform: 'mac',
      session: {
        getSelection: () => 'selected',
        key: (input) => {
          keys.push(input)
          return new Uint8Array()
        },
        paste: (data) => {
          pasted.push(String(data))
          return new Uint8Array()
        },
        selectionCoordinates: () => selection,
        sendInput: (data) => {
          sent.push(String(data))
          return new Uint8Array()
        },
      },
      shortcuts: [
        {
          hotkey: 'Mod+C',
          id: 'replacement-copy',
          onTrigger: () => {
            calls.push('copy-passthrough')
            return 'passthrough'
          },
        },
        {
          hotkey: 'Mod+K',
          id: 'first',
          onTrigger: () => {
            calls.push('first-passthrough')
            return 'passthrough'
          },
        },
        {
          hotkey: { key: 'K', mod: true },
          id: 'second',
          onTrigger: (context) => {
            calls.push('second-claim')
            expect(context.event.code).toBe('KeyK')
            expect(context.hasSelection()).toBe(true)
            expect(context.getSelection()).toBe('selected')
            context.sendInput('command')
            context.paste('clipboard')
            return 'claim'
          },
          preventDefault: false,
          stopPropagation: false,
        },
      ],
      signal: new AbortController().signal,
      textarea,
    })

    dispatchKey(textarea, 'keydown', { code: 'KeyC', key: 'c', metaKey: true })
    const press = dispatchKey(textarea, 'keydown', { code: 'KeyK', key: 'k', metaKey: true })
    const repeat = dispatchKey(textarea, 'keydown', {
      code: 'KeyK',
      key: 'k',
      metaKey: true,
      repeat: true,
    })
    const release = dispatchKey(textarea, 'keyup', { code: 'KeyK', key: 'k', metaKey: true })

    expect(calls).toEqual(['copy-passthrough', 'first-passthrough', 'second-claim'])
    expect(copies).toEqual([])
    expect(keys.map((input) => input.code)).toEqual(['KeyC'])
    expect(sent).toEqual(['command'])
    expect(pasted).toEqual(['clipboard'])
    expect(bubbled.filter((code) => code === 'KeyK')).toEqual(['KeyK', 'KeyK'])
    expect([press.defaultPrevented, repeat.defaultPrevented, release.defaultPrevented]).toEqual([
      false,
      false,
      false,
    ])

    controller.dispose()
    controller.dispose()
    dispatchKey(textarea, 'keydown', { code: 'KeyA', key: 'a' })
    expect(keys.map((input) => input.code)).toEqual(['KeyC'])

    const secondTextarea = document.createElement('textarea')
    host.append(secondTextarea)
    const secondKeys: string[] = []
    const secondPastes: string[] = []
    const secondCopies: string[] = []
    const second = createDomInputController({
      copySelection: (text) => {
        secondCopies.push(text)
      },
      onError: (cause) => {
        throw cause
      },
      platform: 'mac',
      session: {
        getSelection: () => 'selected',
        key: (input) => {
          secondKeys.push(input.code)
          return new Uint8Array()
        },
        paste: (data) => {
          secondPastes.push(String(data))
          return new Uint8Array()
        },
        selectionCoordinates: () => selection,
        sendInput: () => new Uint8Array(),
      },
      shortcuts: false,
      signal: new AbortController().signal,
      textarea: secondTextarea,
    })
    dispatchKey(secondTextarea, 'keydown', { code: 'KeyC', key: 'c', metaKey: true })
    const pasteKey = dispatchKey(secondTextarea, 'keydown', {
      code: 'KeyV',
      key: 'v',
      metaKey: true,
    })
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'browser paste')
    secondTextarea.dispatchEvent(
      new ClipboardEvent('paste', { cancelable: true, clipboardData: clipboard }),
    )

    expect(secondCopies).toEqual([])
    expect(secondKeys).toEqual(['KeyC'])
    expect(pasteKey.defaultPrevented).toBe(false)
    expect(secondPastes).toEqual(['browser paste'])
    second.dispose()
  })

  it('keeps AltGraph, composing, and dead keys on the native Ghostty path', () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    hosts.push(textarea)
    const callbacks: string[] = []
    const keys: TerminalKeyInput[] = []
    const controller = createDomInputController({
      onError: (cause) => {
        throw cause
      },
      platform: 'linux',
      session: {
        getSelection: () => undefined,
        key: (input) => {
          keys.push(input)
          return new Uint8Array()
        },
        paste: () => new Uint8Array(),
        selectionCoordinates: () => undefined,
        sendInput: () => new Uint8Array(),
      },
      shortcuts: [
        {
          hotkey: 'Control+Alt+Q',
          id: 'alt-graph',
          onTrigger: () => {
            callbacks.push('alt-graph')
            return 'claim'
          },
        },
        {
          hotkey: 'Alt+E',
          id: 'dead',
          onTrigger: () => {
            callbacks.push('dead')
            return 'claim'
          },
        },
        {
          hotkey: 'Mod+K',
          id: 'composing',
          onTrigger: () => {
            callbacks.push('composing')
            return 'claim'
          },
        },
      ],
      signal: new AbortController().signal,
      textarea,
    })

    dispatchKey(
      textarea,
      'keydown',
      { altKey: true, code: 'KeyQ', ctrlKey: true, key: '@' },
      { Alt: true, AltGraph: true, Control: true },
    )
    dispatchKey(
      textarea,
      'keydown',
      { altKey: true, code: 'KeyV', ctrlKey: true, key: 'v' },
      { Alt: true, AltGraph: true, Control: true },
    )
    dispatchComposition(textarea, 'compositionstart')
    dispatchKey(textarea, 'keydown', { code: 'KeyK', ctrlKey: true, key: 'k' })
    dispatchComposition(textarea, 'compositionend')
    dispatchKey(textarea, 'keydown', { altKey: true, code: 'KeyE', key: 'Dead' })

    expect(callbacks).toEqual([])
    expect(keys.map((input) => [input.code, input.composing])).toEqual([
      ['KeyQ', false],
      ['KeyV', false],
      ['KeyK', true],
      ['KeyE', true],
    ])
    expect(keys[0]?.consumedModifiers).toMatchObject({ alt: 'unknown', control: 'unknown' })
    controller.dispose()
  })

  it('claims callback failures and rejects duplicate non-empty shortcut ids', async () => {
    const failure = new Error('host command failed')
    let calls = 0
    const terminal = await trackedTerminal({
      keyboard: {
        shortcuts: [
          {
            hotkey: 'Mod+E',
            id: 'explode',
            onTrigger: () => {
              calls += 1
              throw failure
            },
          },
        ],
      },
      rendererFactory: recordingRendererFactory({}),
    })
    await terminal.open(trackedHost())
    const errors: Array<{ cause: unknown; operation: string }> = []
    const output: Uint8Array[] = []
    terminal.on('error', (event) => errors.push(event))
    terminal.onData((bytes) => output.push(bytes))
    terminal.write('\u001b[>11u')
    const modifiers = primaryModifier()
    const press = dispatchKey(terminal.textarea!, 'keydown', {
      code: 'KeyE',
      key: 'e',
      ...modifiers,
    })
    const repeat = dispatchKey(terminal.textarea!, 'keydown', {
      code: 'KeyE',
      key: 'e',
      repeat: true,
      ...modifiers,
    })
    const release = dispatchKey(terminal.textarea!, 'keyup', {
      code: 'KeyE',
      key: 'e',
      ...modifiers,
    })

    expect(calls).toBe(1)
    expect(errors).toEqual([{ cause: failure, operation: 'input.hotkey.explode' }])
    expect(output).toEqual([])
    expect([press.defaultPrevented, repeat.defaultPrevented, release.defaultPrevented]).toEqual([
      true,
      true,
      false,
    ])

    const duplicateHost = trackedHost()
    const duplicate = await trackedTerminal({
      keyboard: {
        shortcuts: [
          { hotkey: 'Mod+A', id: 'same', onTrigger: () => 'claim' },
          { hotkey: 'Mod+B', id: 'same', onTrigger: () => 'claim' },
        ],
      },
      rendererFactory: recordingRendererFactory({}),
    })
    await expect(duplicate.open(duplicateHost)).rejects.toThrow(
      'Duplicate terminal hotkey binding id: same',
    )
    expect(duplicate.lifecycle).toBe('disposed')
    expect(duplicateHost.querySelector('.ghostty-webgpu')).toBeNull()
  })

  it('coalesces fit and DPR changes and emits resize only after renderer resize', async () => {
    const recording: RendererRecording = {}
    let pixelRatio = 1
    let notifyPixelRatio = (): void => {}
    const terminal = await trackedTerminal({
      fitEnvironment: {
        getPixelRatio: () => pixelRatio,
        subscribePixelRatio: (notify) => {
          notifyPixelRatio = notify
          return () => {
            notifyPixelRatio = (): void => {}
          }
        },
      },
      padding: { bottom: 3.1, left: 4.2, right: 5.3, top: 6.4 },
      rendererFactory: recordingRendererFactory(recording),
      scrollbar: { width: 0.1 },
    })
    const host = trackedHost(320, 140)
    const order: string[] = []
    const sizes: { cols: number; rows: number }[] = []
    terminal.onResize((size) => {
      order.push('event')
      sizes.push(size)
    })

    await terminal.open(host)
    const renderer = recording.renderer!
    renderer.onResize = () => order.push('renderer')
    await animationFrames(3)
    expect(sizes).toHaveLength(1)
    expect(renderer.resizes).toHaveLength(1)
    expect(renderer.resizes[0]).toMatchObject({
      columns: sizes[0]!.cols,
      rows: sizes[0]!.rows,
    })
    expect(renderer.notifications.indexOf('resize')).toBeLessThan(
      renderer.notifications.indexOf('schedule'),
    )
    const scrollbar = host.querySelector<HTMLElement>('[role="scrollbar"]')
    expect(scrollbar?.style.width).toBe('1px')
    const root = host.querySelector<HTMLElement>('.ghostty-webgpu')
    const initialGrid = renderer.resizes[0]!
    const fitted = renderer.fonts.at(-1) ?? recording.options!.font
    const reservedColumns = Math.max(
      2,
      Math.floor((root!.clientWidth - 4 - 5 - 1) / fitted.cssCellWidth),
    )
    expect(initialGrid.columns).toBe(reservedColumns)

    const previousResizeCount = sizes.length
    host.style.width = '330px'
    host.style.width = '340px'
    host.style.width = '350px'
    await animationFrames(3)
    expect(sizes).toHaveLength(previousResizeCount + 1)
    expect(renderer.resizes).toHaveLength(previousResizeCount + 1)

    const unchangedCount = sizes.length
    window.dispatchEvent(new Event('resize'))
    await animationFrames(2)
    expect(sizes).toHaveLength(unchangedCount)

    pixelRatio = 2
    notifyPixelRatio()
    await animationFrames(3)
    expect(terminal.appearance.grid.pixelRatio).toBe(2)
    expect(scrollbar?.style.width).toBe('0.5px')
    expect(sizes).toHaveLength(unchangedCount + 1)
    expect(order).toEqual(Array.from({ length: sizes.length }, () => ['renderer', 'event']).flat())

    const disposedResizeCount = sizes.length
    terminal.dispose()
    pixelRatio = 3
    notifyPixelRatio()
    await animationFrames(2)
    expect(sizes).toHaveLength(disposedResizeCount)
  })

  it('keeps zero-sized hosts idle until a real resize source and updates appearance atomically', async () => {
    const recording: RendererRecording = {}
    const terminal = await trackedTerminal({ rendererFactory: recordingRendererFactory(recording) })
    const host = trackedHost(0, 0)
    const sizes: { cols: number; rows: number }[] = []
    terminal.onResize((size) => sizes.push(size))
    await terminal.open(host)
    await animationFrames(3)

    expect(sizes).toHaveLength(0)
    expect(recording.renderer?.resizes).toHaveLength(0)

    host.style.height = '120px'
    host.style.width = '300px'
    await animationFrames(3)
    expect(sizes).toHaveLength(1)
    expect(sizes[0]!.cols).toBeGreaterThanOrEqual(2)
    expect(sizes[0]!.rows).toBeGreaterThanOrEqual(1)

    const appearanceOrder: string[] = []
    terminal.on('appearance', () => appearanceOrder.push('event'))
    terminal.setFont({ family: 'serif', lineHeight: 1.1, size: 18 })
    terminal.setCursor({ blink: true, style: 'bar' })
    const current = terminal.appearance.theme
    terminal.setTheme({ ...current, background: { b: 3, g: 2, r: 1 } })

    expect(recording.renderer?.fonts.at(-1)?.settings.family).not.toBe('serif')
    expect(recording.renderer?.cursorBlink.at(-1)).toBe(true)
    expect(recording.renderer?.themes.at(-1)?.background).toEqual({ b: 3, g: 2, r: 1 })
    expect(appearanceOrder).toHaveLength(3)
    await animationFrames(3)
    expect(recording.renderer?.fonts.at(-1)?.settings).toMatchObject({
      family: 'serif',
      lineHeight: 1.1,
      size: 18,
    })
    expect(sizes).toHaveLength(2)
  })

  it('survives listener-triggered disposal after native write effects return', async () => {
    const terminal = await trackedTerminal({ rendererFactory: recordingRendererFactory({}) })
    const host = trackedHost()
    await terminal.open(host)
    terminal.on('title', () => terminal.dispose())

    expect(() => terminal.write('\u001b]0;dispose now\u0007')).not.toThrow()
    expect(terminal.lifecycle).toBe('disposed')
    expect(host.querySelector('.ghostty-webgpu')).toBeNull()
  })
})
