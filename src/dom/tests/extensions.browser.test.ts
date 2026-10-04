import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { DomTerminalRenderer, Terminal } from '../../index.js'
import type { GhosttyWebGpuTerminalOptions, LinkProvider, ProvidedLink } from '../../index.js'
import type { Extension, ExtensionInput, ExtensionScope, TerminalInputEvent } from '../../index.js'
import { Terminal as WorkerTerminal } from '../../worker/index.js'
import { ExtensionManager } from '../../extensions/manager.js'

const terminals: Terminal[] = []
const workerTerminals: WorkerTerminal[] = []
const hosts: HTMLElement[] = []
const decoder = new TextDecoder()

afterEach(async () => {
  for (const terminal of workerTerminals.splice(0)) await terminal.dispose()
  for (const terminal of terminals.splice(0)) terminal.dispose()
  for (const host of hosts.splice(0)) host.remove()
})

async function openTerminal(
  options: GhosttyWebGpuTerminalOptions = {},
  beforeOpen?: (terminal: Terminal) => void,
): Promise<Terminal> {
  const host = document.createElement('div')
  host.style.width = '320px'
  host.style.height = '120px'
  document.body.append(host)
  hosts.push(host)
  const terminal = await Terminal.create({
    rendererFactory: DomTerminalRenderer.create,
    ...options,
  })
  terminals.push(terminal)
  beforeOpen?.(terminal)
  await terminal.open(host)
  return terminal
}

function press(terminal: Terminal, key = 'a', code = 'KeyA'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true })
  terminal.textarea!.dispatchEvent(event)
  return event
}

function compose(
  terminal: Terminal,
  text: string,
  order: 'input-first' | 'end-first' | 'end-only',
): void {
  const textarea = terminal.textarea!
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
  textarea.value = text
  textarea.dispatchEvent(
    new InputEvent('input', {
      data: text,
      inputType: 'insertCompositionText',
      isComposing: true,
    }),
  )
  if (order === 'input-first') {
    textarea.dispatchEvent(
      new InputEvent('input', {
        data: text,
        inputType: 'insertCompositionText',
        isComposing: false,
      }),
    )
  }
  textarea.dispatchEvent(new CompositionEvent('compositionend', { data: text }))
  if (order === 'end-first') {
    textarea.dispatchEvent(
      new InputEvent('input', {
        data: text,
        inputType: 'insertCompositionText',
        isComposing: false,
      }),
    )
  }
}

describe('public extension interest costs', () => {
  it.each([0, 1, 100, 1_000])(
    'executes no manager interest queries or traversal for keys beside %i inert extensions',
    async (count) => {
      const terminal = await openTerminal({
        extensions: Array.from({ length: count }, (_, index) => ({
          name: `inert-${index}`,
          setup: () => ({}),
        })),
      })
      terminal.use({ name: 'seed', setup: () => ({}) }).dispose()
      const data: string[] = []
      terminal.onData((bytes) => data.push(decoder.decode(bytes)))
      const inputInterest = vi.spyOn(ExtensionManager.prototype, 'hasInput', 'get')
      const eventInterest = vi.spyOn(ExtensionManager.prototype, 'hasEvent')
      const inputDispatch = vi.spyOn(ExtensionManager.prototype, 'dispatchInput')
      const eventDispatch = vi.spyOn(ExtensionManager.prototype, 'emit')
      const mapLookup = vi.spyOn(Map.prototype, 'has')
      try {
        for (let index = 0; index < 16; index++) {
          terminal.key({ action: 'press', code: 'KeyA', text: 'a', composing: false })
          press(terminal)
        }
        expect(data).toEqual(Array.from({ length: 32 }, () => 'a'))
        expect({
          inputInterest: inputInterest.mock.calls.length,
          eventInterest: eventInterest.mock.calls.length,
          inputDispatch: inputDispatch.mock.calls.length,
          eventDispatch: eventDispatch.mock.calls.length,
        }).toEqual({ inputInterest: 0, eventInterest: 0, inputDispatch: 0, eventDispatch: 0 })
        expect(mapLookup.mock.calls.filter(([key]) => key === 'data')).toHaveLength(0)
      } finally {
        inputInterest.mockRestore()
        eventInterest.mockRestore()
        inputDispatch.mockRestore()
        eventDispatch.mockRestore()
        mapLookup.mockRestore()
      }
    },
  )

  it('keeps host data listeners before published extension events across detach and reattach', async () => {
    const terminal = await openTerminal()
    const calls: string[] = []
    const extension: Extension = {
      name: 'interested',
      setup: () => ({
        input: () => {
          calls.push('input')
          return 'pass'
        },
        events: { data: () => calls.push('extension-data') },
      }),
    }
    const handle = terminal.use(extension)
    terminal.onData(() => calls.push('host-data'))
    terminal.key({ action: 'press', code: 'KeyA', text: 'a', composing: false })
    expect(calls).toEqual(['input', 'host-data', 'extension-data'])
    handle.dispose()
    calls.length = 0
    press(terminal)
    expect(calls).toEqual(['host-data'])
    const replacement = terminal.use(extension)
    handle.dispose()
    calls.length = 0
    press(terminal)
    expect(calls).toEqual(['input', 'host-data', 'extension-data'])
    replacement.dispose()
  })
})

describe('public extension links', () => {
  it('resolves one contributed provider on the classic public link surface', async () => {
    const terminal = await openTerminal()
    terminal.writeAndReadGeometry('link')
    await vi.waitFor(() => {
      expect(terminal.submittedFrame?.nativeRevision).toBe(terminal.geometry().revision)
      expect(terminal.visibleLines()[0]).toMatch(/^link/)
    })
    const activate = vi.fn()
    const classic = vi.fn(() => [{ range: { start: 0, end: 3 }, activate }])
    const registration = terminal.registerLinkProvider({ provideLinks: classic })
    const classicFocused = await terminal.focusNextLink()
    expect({ calls: classic.mock.calls.length, focused: classicFocused }).toEqual({
      calls: 1,
      focused: true,
    })
    registration.dispose()

    const contributed = vi.fn(() => [{ range: { start: 0, end: 3 }, activate }])
    terminal.use({ name: 'public-links', setup: () => ({ links: { provideLinks: contributed } }) })
    const focused = await terminal.focusNextLink()
    expect({ calls: contributed.mock.calls.length, focused }).toEqual({ calls: 1, focused: true })
    expect(document.activeElement).toBe(terminal.element?.querySelector('[role="link"]'))
    await page.screenshot({
      element: terminal.element!,
      path: '../../../.artifacts/review-public-extension-link.png',
      scale: 'css',
    })
  })

  it('keeps nested presets, classic registration and use in encounter order across opening', async () => {
    const calls: string[] = []
    const activate = vi.fn()
    const provider = (name: string, hit = false): LinkProvider<Event> => ({
      provideLinks: () => {
        calls.push(name)
        return hit ? [{ range: { start: 0, end: 3 }, text: name, activate }] : undefined
      },
    })
    const extension = (name: string): Extension => ({
      name,
      setup: () => ({ links: provider(name) }),
    })
    const terminal = await openTerminal(
      { extensions: [extension('preset-first'), [extension('preset-second')]] },
      (created) => {
        expect(created.lifecycle).toBe('created')
        created.registerLinkProvider(provider('classic-before'))
        created.use(extension('use-before'))
      },
    )
    terminal.use({ name: 'use-after', setup: () => ({ links: provider('use-after', true) }) })
    terminal.registerLinkProvider(provider('classic-after', true))
    terminal.writeAndReadGeometry('link')
    await vi.waitFor(() => expect(terminal.visibleLines()[0]).toMatch(/^link/))
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(calls).toEqual([
      'preset-first',
      'preset-second',
      'classic-before',
      'use-before',
      'use-after',
    ])
    expect(terminal.element?.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
      'use-after',
    )
  })

  it('removes focused links once on detach and restores the next classic provider', async () => {
    const terminal = await openTerminal()
    const activate = vi.fn()
    const provideLinks = vi.fn(() => [{ range: { start: 0, end: 3 }, activate }])
    const extension: Extension = {
      name: 'detached-links',
      setup: () => ({ links: { provideLinks } }),
    }
    const handle = terminal.use(extension)
    const classic = vi.fn(() => [{ range: { start: 0, end: 3 }, text: 'classic', activate }])
    const registration = terminal.registerLinkProvider({ provideLinks: classic })
    terminal.writeAndReadGeometry('link')
    await vi.waitFor(() => expect(terminal.visibleLines()[0]).toMatch(/^link/))
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    const overlay = terminal.element?.querySelector('[role="link"]')!
    expect(document.activeElement).toBe(overlay)
    expect(provideLinks).toHaveBeenCalledTimes(1)
    expect(classic).not.toHaveBeenCalled()
    handle.dispose()
    handle.dispose()
    expect(terminal.element?.querySelector('[role="link"]')).toBeNull()
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(activate).not.toHaveBeenCalled()
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(provideLinks).toHaveBeenCalledTimes(1)
    expect(classic).toHaveBeenCalledTimes(1)
    expect(terminal.element?.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
      'classic',
    )
    registration.dispose()
    const replacement = terminal.use(extension)
    handle.dispose()
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(provideLinks).toHaveBeenCalledTimes(2)
    replacement.dispose()
    await expect(terminal.focusNextLink()).resolves.toBe(false)
    expect(provideLinks).toHaveBeenCalledTimes(2)
  })

  it.each(['detach', 'teardown'] as const)(
    'discards a pending extension link result after %s',
    async (action) => {
      const terminal = await openTerminal()
      let finish!: (links: readonly ProvidedLink<Event>[]) => void
      const pending = new Promise<readonly ProvidedLink<Event>[]>((resolve) => {
        finish = resolve
      })
      const provideLinks = vi.fn(() => pending)
      const cleanup = vi.fn()
      let signal!: AbortSignal
      const handle = terminal.use({
        name: 'pending-links',
        setup: (scope) => {
          signal = scope.signal
          scope.own(cleanup)
          return { links: { provideLinks } }
        },
      })
      terminal.writeAndReadGeometry('link')
      await vi.waitFor(() => expect(terminal.visibleLines()[0]).toMatch(/^link/))
      const root = terminal.element!
      const discovery = terminal.focusNextLink()
      expect(provideLinks).toHaveBeenCalledTimes(1)
      expect(terminal.hasPendingLinkResolution).toBe(true)
      if (action === 'detach') handle.dispose()
      if (action === 'teardown') terminal.dispose()
      finish([{ range: { start: 0, end: 3 }, activate: vi.fn() }])
      await expect(discovery).resolves.toBe(false)
      expect(root.querySelector('[role="link"]')).toBeNull()
      expect(terminal.hasPendingLinkResolution).toBe(false)
      expect(signal.aborted).toBe(true)
      handle.dispose()
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(provideLinks).toHaveBeenCalledTimes(1)
      if (action === 'detach') await expect(terminal.focusNextLink()).resolves.toBe(false)
      expect(provideLinks).toHaveBeenCalledTimes(1)
    },
  )

  it('rolls back links and other hooks when public registry validation fails', async () => {
    const terminal = await openTerminal()
    const failure = new TypeError('registry validation failure')
    const cleanup = vi.fn()
    const input = vi.fn(() => 'pass' as const)
    const title = vi.fn()
    const provideLinks = vi.fn(() => [{ range: { start: 0, end: 3 }, activate: vi.fn() }])
    let reads = 0
    const provider: LinkProvider<Event> = {
      get provideLinks() {
        reads += 1
        if (reads === 2) throw failure
        return provideLinks
      },
    }
    let scope!: ExtensionScope
    const extension: Extension = {
      name: 'registration-failure',
      setup: (owned) => {
        scope = owned
        owned.own(cleanup)
        return { links: provider, input, events: { title } }
      },
    }
    expect(() => terminal.use(extension)).toThrow(failure)
    expect(scope.signal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(1)
    terminal.sendInput('input')
    terminal.writeAndReadGeometry('\u001b]2;title\u0007link')
    await vi.waitFor(() => expect(terminal.visibleLines()[0]).toMatch(/^link/))
    await expect(terminal.focusNextLink()).resolves.toBe(false)
    expect(provideLinks).not.toHaveBeenCalled()
    expect(input).not.toHaveBeenCalled()
    expect(title).not.toHaveBeenCalled()
    const replacement = terminal.use(extension)
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    replacement.dispose()
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('releases late registrations when a provider accessor disposes the terminal', async () => {
    const terminal = await openTerminal()
    const cleanup = vi.fn()
    const provideLinks = vi.fn(() => undefined)
    let reads = 0
    let scope!: ExtensionScope
    expect(() =>
      terminal.use({
        name: 'reentrant-registration',
        setup: (owned) => {
          scope = owned
          owned.own(cleanup)
          return {
            links: {
              get provideLinks() {
                reads += 1
                if (reads === 2) terminal.dispose()
                return provideLinks
              },
            },
          }
        },
      }),
    ).toThrow('LinkResolver.registerProvider called after disposal')
    expect(reads).toBe(2)
    expect(terminal.lifecycle).toBe('disposed')
    expect(scope.signal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(provideLinks).not.toHaveBeenCalled()
  })

  it('keeps inert contribution getters untouched during links, input and output', async () => {
    const reads = vi.fn()
    const terminal = await openTerminal({
      extensions: Array.from({ length: 3 }, (_, index) => ({
        name: `inert-${index}`,
        setup: () => ({
          get links() {
            reads()
            return undefined
          },
        }),
      })),
    })
    const provideLinks = vi.fn(() => [{ range: { start: 0, end: 3 }, activate: vi.fn() }])
    terminal.use({ name: 'interested-links', setup: () => ({ links: { provideLinks } }) })
    expect(reads).toHaveBeenCalledTimes(3)
    terminal.sendInput('input')
    press(terminal)
    terminal.writeAndReadGeometry('link')
    await vi.waitFor(() => expect(terminal.visibleLines()[0]).toMatch(/^link/))
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(provideLinks).toHaveBeenCalledTimes(1)
    expect(reads).toHaveBeenCalledTimes(3)
  })
})

describe('public extension activation', () => {
  it('rejects unavailable OSC ownership and rolls back setup resources', async () => {
    const terminal = await openTerminal()
    let cleaned = 0
    expect(() =>
      terminal.use({
        name: 'osc',
        setup: (scope) => {
          scope.own(() => (cleaned += 1))
          return { osc: { 777: () => {} } }
        },
      }),
    ).toThrow('Custom OSC observation is unavailable')
    expect(cleaned).toBe(1)
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    press(terminal)
    expect(output).toEqual(['a'])
  })

  it.each(['input-first', 'end-first'] as const)(
    'publishes an unclaimed composition commit exactly once for %s order',
    async (order) => {
      const terminal = await openTerminal()
      const output: string[] = []
      terminal.onData((data) => output.push(decoder.decode(data)))
      compose(terminal, '中', order)
      expect(output).toEqual(['中'])
    },
  )
  it('installs readonly nested presets before opening the real terminal', async () => {
    const order: number[] = []
    const extension = (value: number): Extension => ({
      name: String(value),
      setup: (scope) => {
        expect(scope.terminal.lifecycle).toBe('created')
        order.push(value)
        return {}
      },
    })
    const extensions: readonly ExtensionInput[] = [extension(1), [extension(2), [extension(3)]]]
    await openTerminal({ extensions })
    expect(order).toEqual([1, 2, 3])
  })

  it('observes a known-good native key and lets an extension claim before any PTY output', async () => {
    const control = await openTerminal()
    const controlOutput: string[] = []
    control.onData((data) => controlOutput.push(decoder.decode(data)))
    press(control)
    expect(controlOutput).toEqual(['a'])
    const claimed: KeyboardEvent[] = []
    const terminal = await openTerminal({
      extensions: [
        {
          name: 'claim-key',
          setup: () => ({
            input: (input) => {
              if (input.type === 'key' && 'event' in input) claimed.push(input.event)
              return 'claim'
            },
          }),
        },
      ],
    })
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    const event = press(terminal)
    expect(claimed).toEqual([event])
    expect(event.defaultPrevented).toBe(true)
    const modified = new KeyboardEvent('keydown', {
      key: 'Z',
      code: 'KeyZ',
      ctrlKey: true,
      altKey: true,
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    })
    terminal.textarea!.dispatchEvent(modified)
    expect(claimed[1]).toBe(modified)
    expect(modified.defaultPrevented).toBe(true)
    expect(output).toEqual([])
  })

  it.each([
    { name: 'isComposing', init: { key: 'n', code: 'KeyN', isComposing: true } },
    { name: 'Dead', init: { key: 'Dead', code: 'KeyD' } },
    { name: 'Process', init: { key: 'Process', code: 'KeyP' } },
    { name: 'keyCode229', init: { key: 'n', code: 'KeyN', keyCode: 229 } },
    { name: 'active composition', init: { key: 'n', code: 'KeyN' }, active: true },
  ])(
    'offers original $name keys before native composition suppression',
    async ({ init, active }) => {
      const seen: KeyboardEvent[] = []
      let claim = false
      const terminal = await openTerminal()
      terminal.connectInput((input) => {
        if (input.type !== 'key' || !('event' in input)) return 'pass'
        seen.push(input.event)
        return claim ? 'claim' : 'pass'
      })
      const output: string[] = []
      terminal.onData((data) => output.push(decoder.decode(data)))
      if (active) terminal.textarea!.dispatchEvent(new CompositionEvent('compositionstart'))
      for (const ownership of [false, true]) {
        claim = ownership
        const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
        terminal.textarea!.dispatchEvent(event)
        expect(seen.at(-1)).toBe(event)
        expect(event.defaultPrevented).toBe(ownership)
      }
      expect(seen).toHaveLength(2)
      expect(output).toEqual([])
    },
  )

  it('returns a typed synchronous API with per-terminal identity and reverse cleanup', async () => {
    const order: string[] = []
    const signals: AbortSignal[] = []
    const shared: Extension<{ value: number }> = {
      name: 'shared',
      setup: (scope) => {
        signals.push(scope.signal)
        scope.own(() => order.push('first'))
        scope.own(() => order.push('last'))
        return { api: { value: signals.length } }
      },
    }
    const first = await openTerminal()
    const second = await openTerminal()
    const handle = first.use(shared)
    expectTypeOf(handle.api).toEqualTypeOf<{ value: number }>()
    expect(handle.api.value).toBe(1)
    expect(second.use(shared).api.value).toBe(2)
    expect(() => first.use(shared)).toThrow('already attached')
    expect(signals[0]).not.toBe(signals[1])
    handle.dispose()
    handle.dispose()
    expect(order).toEqual(['last', 'first'])
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    first.use(shared)
    first.dispose()
    expect(order).toEqual(['last', 'first', 'last', 'first'])
    second.dispose()
    expect(order).toEqual(['last', 'first', 'last', 'first', 'last', 'first'])
  })

  it('disposes public attachments and their owned resources in reverse order once', async () => {
    const order: string[] = []
    const terminal = await openTerminal()
    const extension = (name: string): Extension => ({
      name,
      setup: (scope) => {
        scope.own(() => order.push(`${name}.first`))
        scope.own(() => order.push(`${name}.last`))
        return {}
      },
    })
    const first = terminal.use(extension('first'))
    const last = terminal.use(extension('last'))
    terminal.dispose()
    first.dispose()
    last.dispose()
    terminal.dispose()
    expect(order).toEqual(['last.last', 'last.first', 'first.last', 'first.first'])
  })

  it('rolls back a failed readonly preset and its acquired native owner', async () => {
    const order: string[] = []
    const scopes: ExtensionScope[] = []
    const failure = Symbol('setup failure')
    const good: Extension = {
      name: 'good',
      setup: (scope) => {
        scopes.push(scope)
        scope.own(() => order.push('good'))
        return {}
      },
    }
    const bad: Extension = {
      name: 'bad',
      setup: (scope) => {
        scopes.push(scope)
        scope.own(() => order.push('bad'))
        throw failure
      },
    }
    await expect(Terminal.create({ extensions: [good, [bad]] })).rejects.toBe(failure)
    expect(order).toEqual(['bad', 'good'])
    expect(scopes.every((scope) => scope.signal.aborted)).toBe(true)
    expect(scopes[0]?.terminal.lifecycle).toBe('disposed')
    expect(() => scopes[0]?.terminal.appearance).toThrow('disposed')
  })

  it('releases real DOM and input controllers when opening fails after input installation', async () => {
    const failure = Symbol('observer factory failure')
    let signal: AbortSignal | undefined
    let textarea: HTMLTextAreaElement | undefined
    const terminal = await Terminal.create({
      extensions: [
        {
          name: 'lifetime',
          setup: (scope) => {
            signal = scope.signal
            return {}
          },
        },
      ],
      rendererFactory: async (options) => {
        textarea = (options.canvas as HTMLCanvasElement).parentElement!.querySelector('textarea')!
        return DomTerminalRenderer.create(options)
      },
      fitEnvironment: {
        createResizeObserver: () => {
          throw failure
        },
      },
    })
    terminals.push(terminal)
    const host = document.createElement('div')
    host.style.width = '320px'
    host.style.height = '120px'
    document.body.append(host)
    hosts.push(host)
    await expect(terminal.open(host)).rejects.toBe(failure)
    expect(terminal.lifecycle).toBe('disposed')
    expect(signal?.aborted).toBe(true)
    expect(host.childElementCount).toBe(0)
    expect(textarea?.isConnected).toBe(false)
    expect(() =>
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'a',
          code: 'KeyA',
          cancelable: true,
        }),
      ),
    ).not.toThrow()
  })

  it('rolls back disposal during synchronous setup', async () => {
    const order: string[] = []
    let scopeValue: ExtensionScope | undefined
    await expect(
      Terminal.create({
        extensions: [
          {
            name: 'dispose-in-setup',
            setup: (scope) => {
              scopeValue = scope
              scope.own(() => order.push('cleanup'))
              scope.terminal.dispose()
              return {}
            },
          },
        ],
      }),
    ).rejects.toThrow('disposed')
    expect(order).toEqual(['cleanup'])
    expect(scopeValue?.signal.aborted).toBe(true)
    expect(scopeValue?.terminal.lifecycle).toBe('disposed')
  })

  it('claims original DOM paste, committed composition, text and programmatic input', async () => {
    const inputs: TerminalInputEvent[] = []
    const terminal = await openTerminal({
      extensions: [
        {
          name: 'claim',
          setup: () => ({
            input: (input) => {
              inputs.push(input)
              return 'claim'
            },
          }),
        },
      ],
    })
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'paste\ntext')
    const paste = new ClipboardEvent('paste', { clipboardData, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: clipboardData })
    terminal.textarea!.dispatchEvent(paste)
    compose(terminal, '中', 'end-first')
    terminal.textarea!.dispatchEvent(
      new InputEvent('input', {
        data: 'text',
        inputType: 'insertText',
      }),
    )
    expect(terminal.paste('programmatic paste')).toHaveLength(0)
    expect(terminal.sendInput('programmatic text')).toHaveLength(0)
    const bytes = new Uint8Array([0xc3, 0xa9])
    expect(terminal.sendInput(bytes)).toHaveLength(0)
    const input = { action: 'press', code: 'KeyA', text: 'a', composing: false } as const
    expect(terminal.key(input)).toHaveLength(0)
    expect(inputs).toEqual([
      { type: 'paste', data: 'paste\ntext' },
      { type: 'composition', text: '中' },
      { type: 'text', data: 'text' },
      { type: 'paste', data: 'programmatic paste' },
      { type: 'text', data: 'programmatic text' },
      { type: 'text', data: bytes },
      { type: 'key', input },
    ])
    expect(paste.defaultPrevented).toBe(true)
    expect(output).toEqual([])
  })

  it.each(['input-first', 'end-first'] as const)(
    'claims one composition commit for %s order',
    async (order) => {
      const inputs: TerminalInputEvent[] = []
      const terminal = await openTerminal({
        extensions: [
          {
            name: 'composition',
            setup: () => ({
              input: (input) => {
                inputs.push(input)
                return 'claim'
              },
            }),
          },
        ],
      })
      const output: string[] = []
      terminal.onData((data) => output.push(decoder.decode(data)))
      compose(terminal, '中', order)
      expect(inputs).toEqual([{ type: 'composition', text: '中' }])
      expect(output).toEqual([])
    },
  )

  it.each(['cancel', 'blur', 'dispose'] as const)(
    'drops pending composition after %s',
    async (action) => {
      const terminal = await openTerminal()
      terminal.focus()
      const textarea = terminal.textarea!
      const output: string[] = []
      terminal.onData((data) => output.push(decoder.decode(data)))
      textarea.dispatchEvent(new CompositionEvent('compositionstart'))
      textarea.value = '中'
      textarea.dispatchEvent(
        new InputEvent('input', {
          data: '中',
          inputType: 'insertCompositionText',
          isComposing: true,
        }),
      )
      if (action === 'blur') terminal.blur()
      if (action === 'dispose') terminal.dispose()
      textarea.dispatchEvent(
        new CompositionEvent('compositionend', {
          data: action === 'cancel' ? '' : '中',
        }),
      )
      textarea.dispatchEvent(
        new InputEvent('input', {
          data: '中',
          inputType: 'insertCompositionText',
          isComposing: false,
        }),
      )
      expect(output).toEqual([])
      if (action !== 'dispose') {
        press(terminal)
        expect(output).toEqual(['a'])
      }
    },
  )

  it.each(['x', '中'])(
    'preserves a separate keyless text action %s after an end-only composition',
    async (later) => {
      const inputs: TerminalInputEvent[] = []
      const terminal = await openTerminal({
        extensions: [
          {
            name: 'observe',
            setup: () => ({
              input: (input) => {
                inputs.push(input)
                return 'pass'
              },
            }),
          },
        ],
      })
      const output: string[] = []
      terminal.onData((data) => output.push(decoder.decode(data)))
      const textarea = terminal.textarea!
      textarea.dispatchEvent(new CompositionEvent('compositionstart'))
      textarea.value = '中'
      textarea.dispatchEvent(
        new InputEvent('input', {
          data: '中',
          inputType: 'insertCompositionText',
          isComposing: true,
        }),
      )
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '中' }))
      expect(output).toEqual(['中'])
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      textarea.value = later
      textarea.dispatchEvent(
        new InputEvent('input', {
          data: later,
          inputType: 'insertText',
          isComposing: false,
        }),
      )
      expect(output).toEqual(['中', later])
      expect(inputs).toEqual([
        { type: 'composition', text: '中' },
        { type: 'text', data: later },
      ])
    },
  )

  it('lets an extension claim a new identical keyless action after an end-only composition', async () => {
    const inputs: TerminalInputEvent[] = []
    const terminal = await openTerminal({
      extensions: [
        {
          name: 'text gate',
          setup: () => ({
            input: (input) => {
              inputs.push(input)
              return input.type === 'text' ? 'claim' : 'pass'
            },
          }),
        },
      ],
    })
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    compose(terminal, '中', 'end-only')
    const textarea = terminal.textarea!
    textarea.value = '中'
    textarea.dispatchEvent(new InputEvent('input', { data: '中', inputType: 'insertText' }))
    expect(inputs).toEqual([
      { type: 'composition', text: '中' },
      { type: 'text', data: '中' },
    ])
    expect(output).toEqual(['中'])
  })

  it.each(['x', '中'])(
    'preserves a separate keyless text action %s after cancelling composition',
    async (later) => {
      const terminal = await openTerminal()
      const output: string[] = []
      terminal.onData((data) => output.push(decoder.decode(data)))
      const textarea = terminal.textarea!
      textarea.dispatchEvent(new CompositionEvent('compositionstart'))
      textarea.value = '中'
      textarea.dispatchEvent(
        new InputEvent('input', {
          data: '中',
          inputType: 'insertCompositionText',
          isComposing: true,
        }),
      )
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' }))
      textarea.dispatchEvent(
        new InputEvent('input', {
          data: '中',
          inputType: 'insertCompositionText',
          isComposing: false,
        }),
      )
      expect(output).toEqual([])
      textarea.value = later
      textarea.dispatchEvent(new InputEvent('input', { data: later, inputType: 'insertText' }))
      expect(output).toEqual([later])
    },
  )

  it('consumes the genuine composition final tail once and preserves a later identical text action', async () => {
    const terminal = await openTerminal()
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    compose(terminal, '中', 'end-only')
    const textarea = terminal.textarea!
    const tail = new InputEvent('input', { data: '中', inputType: 'insertCompositionText' })
    expect(tail.inputType).toBe('insertCompositionText')
    textarea.dispatchEvent(tail)
    expect(output).toEqual(['中'])
    textarea.dispatchEvent(new InputEvent('beforeinput', { data: '中', inputType: 'insertText' }))
    textarea.value = '中'
    textarea.dispatchEvent(new InputEvent('input', { data: '中', inputType: 'insertText' }))
    expect(output).toEqual(['中', '中'])
  })

  it('preserves a later ordinary key with the same text as the previous composition', async () => {
    const terminal = await openTerminal()
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    compose(terminal, '中', 'end-first')
    press(terminal, '中')
    expect(output).toEqual(['中', '中'])
  })

  it('passes through native bracketed paste and native query replies exactly once', async () => {
    let calls = 0
    const terminal = await openTerminal({
      extensions: [
        {
          name: 'pass',
          setup: () => ({
            input: () => {
              calls += 1
              return 'pass'
            },
          }),
        },
      ],
    })
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    terminal.write('\x1b[?2004h')
    terminal.paste('a\nb')
    expect(output).toEqual(['\x1b[200~a\nb\x1b[201~'])
    expect(calls).toBe(1)
    terminal.use({ name: 'always claim', setup: () => ({ input: () => 'claim' }) })
    terminal.write('abc\x1b[6n')
    expect(output.at(-1)).toBe('\x1b[1;4R')
    expect(calls).toBe(1)
  })

  it('skips detached handlers, preserves later nodes and excludes new handlers until next input', async () => {
    const terminal = await openTerminal()
    const calls: string[] = []
    let attached = false
    let second: { dispose(): void }
    const late: Extension = {
      name: 'late',
      setup: () => ({
        input: () => {
          calls.push('late')
          return 'pass'
        },
      }),
    }
    terminal.use({
      name: 'first',
      setup: () => ({
        input: () => {
          calls.push('first')
          second.dispose()
          if (!attached) {
            attached = true
            terminal.use(late)
          }
          return 'pass'
        },
      }),
    })
    second = terminal.use({
      name: 'second',
      setup: () => ({
        input: () => {
          calls.push('second')
          return 'pass'
        },
      }),
    })
    terminal.use({
      name: 'third',
      setup: () => ({
        input: () => {
          calls.push('third')
          return 'pass'
        },
      }),
    })
    terminal.sendInput('a')
    expect(calls).toEqual(['first', 'third'])
    terminal.sendInput('b')
    expect(calls).toEqual(['first', 'third', 'first', 'third', 'late'])
  })

  it('stops at the first claim and suppresses native release after detaching a claimed press', async () => {
    const terminal = await openTerminal()
    const calls: string[] = []
    terminal.write('\x1b[>3u')
    const first = terminal.use({
      name: 'first',
      setup: () => ({
        input: () => {
          calls.push('first')
          return 'claim'
        },
      }),
    })
    const second = terminal.use({
      name: 'second',
      setup: () => ({
        input: () => {
          calls.push('second')
          return 'claim'
        },
      }),
    })
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    press(terminal)
    first.dispose()
    second.dispose()
    terminal.textarea!.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'a',
        code: 'KeyA',
        cancelable: true,
      }),
    )
    expect(calls).toEqual(['first'])
    expect(output).toEqual([])
  })

  it('does not encode a passed original key after a handler disposes the terminal', async () => {
    const terminal = await openTerminal()
    terminal.use({
      name: 'dispose-input',
      setup: () => ({
        input: () => {
          terminal.dispose()
          return 'pass'
        },
      }),
    })
    const output: string[] = []
    terminal.onData((data) => output.push(decoder.decode(data)))
    const event = press(terminal)
    expect(terminal.lifecycle).toBe('disposed')
    expect(event.defaultPrevented).toBe(true)
    expect(output).toEqual([])
  })

  it('broadcasts interested host events and contains a failing error handler', async () => {
    const clipboardFailure = Symbol('clipboard policy failure')
    const terminal = await openTerminal({
      clipboardWrite: () => {
        throw clipboardFailure
      },
    })
    const titles: string[] = []
    const publicErrors: unknown[] = []
    terminal.on('error', ({ cause }) => publicErrors.push(cause))
    terminal.use({
      name: 'events',
      setup: () => ({
        events: {
          title: (title) => titles.push(title),
          error: () => {
            throw 'extension error handler failure'
          },
        },
      }),
    })
    terminal.write('\x1b]0;one\x07')
    terminal.write('\x1b]0;two\x07')
    terminal.write('\x1b]52;c;eA==\x07')
    expect(titles).toEqual(['one', 'two'])
    expect(publicErrors).toHaveLength(2)
    expect(publicErrors[0]).toBe(clipboardFailure)
    expect(publicErrors.at(-1)).toBe('extension error handler failure')
  })
})

describe('interested frame delivery', () => {
  it.each([0, 100, 1000])(
    'keeps %i inert attachments out of hot-path contribution reads',
    async (count) => {
      let reads = 0
      const extensions: Extension[] = Array.from({ length: count }, (_, index) => ({
        name: String(index),
        setup: () => ({
          get input() {
            reads += 1
            return undefined
          },
          get events() {
            reads += 1
            return undefined
          },
        }),
      }))
      const terminal = await openTerminal({ extensions })
      reads = 0
      let inputs = 0
      let titles = 0
      let frames = 0
      terminal.use({
        name: 'interested control',
        setup: () => ({
          input: () => {
            inputs += 1
            return 'pass'
          },
          events: { title: () => (titles += 1), frame: () => (frames += 1) },
        }),
      })
      terminal.sendInput('a')
      press(terminal)
      terminal.write('\x1b]0;counter\x07x')
      await vi.waitFor(() => expect(frames).toBeGreaterThan(0))
      expect(inputs).toBe(2)
      expect(titles).toBe(1)
      expect(reads).toBe(0)
    },
  )
})

it('delivers an extension-only frame queued during opening through the host boundary', async () => {
  const observed: (readonly number[])[] = []
  const terminal = await openTerminal({
    extensions: [
      {
        name: 'opening-frame',
        setup: () => ({ events: { frame: (event) => observed.push(event.rows) } }),
      },
    ],
    rendererFactory: async (options) => {
      const renderer = await DomTerminalRenderer.create(options)
      options.onRowsChanged?.([0])
      return renderer
    },
  })
  expect(terminal.lifecycle).toBe('open')
  expect(observed).toContainEqual([0])
})

async function createWorkerTerminal(): Promise<WorkerTerminal> {
  const family = 'ExtensionWorkerIntegration'
  const url = new URL(
    '../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2',
    import.meta.url,
  ).href
  const terminal = await WorkerTerminal.create({
    backend: 'webgl',
    fonts: [{ family, source: { url } }],
    appearance: { font: { family, size: 16 }, cursor: { blink: false } },
    workerUrl: new URL('../../../dist/worker/entry.js', import.meta.url),
  })
  workerTerminals.push(terminal)
  return terminal
}

function workerContainer(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.width = '320px'
  host.style.height = '120px'
  document.body.append(host)
  hosts.push(host)
  return host
}

describe('public worker extension integration', () => {
  it('returns a Promise for every use outcome while setup and owned cleanup stay on the host', async () => {
    const terminal = await createWorkerTerminal()
    const order: string[] = []
    const extension = {
      name: 'typed worker handle',
      setup(scope: ExtensionScope) {
        order.push('setup')
        scope.own(() => order.push('cleanup'))
        return { api: { answer: 42 }, osc: {} }
      },
    }
    const installed = terminal.use(extension)
    expect(installed instanceof Promise).toBe(true)
    const handle = await installed
    expect(handle.api.answer).toBe(42)
    expect(order).toEqual(['setup'])
    let duplicate: ReturnType<typeof terminal.use> | undefined
    expect(() => {
      duplicate = terminal.use(extension)
    }).not.toThrow()
    expect(duplicate instanceof Promise).toBe(true)
    await expect(duplicate).rejects.toThrow('already')
    handle.dispose()
    expect(order).toEqual(['setup', 'cleanup'])
    const reattached = terminal.use(extension)
    expect(reattached instanceof Promise).toBe(true)
    await reattached
    await terminal.dispose()
    expect(order).toEqual(['setup', 'cleanup', 'setup', 'cleanup'])
    let disposed: ReturnType<typeof terminal.use> | undefined
    expect(() => {
      disposed = terminal.use(extension)
    }).not.toThrow()
    expect(disposed instanceof Promise).toBe(true)
    await expect(disposed).rejects.toThrow()
  })

  it('rejects setup and contribution failures asynchronously and rolls back their resources', async () => {
    const terminal = await createWorkerTerminal()
    const failures: Extension[] = [
      {
        name: 'throws',
        setup: () => {
          throw new TypeError('setup failed')
        },
      },
      {
        name: 'invalid OSC number',
        setup: () => ({ osc: { '-1': () => {} } }),
      },
      { name: 'unavailable OSC', setup: () => ({ osc: { 999: () => {} } }) },
    ]
    for (const failure of failures) {
      const cleanup: string[] = []
      const extension = {
        name: failure.name,
        setup(scope: ExtensionScope) {
          scope.own(() => cleanup.push('disposed'))
          return failure.setup(scope)
        },
      }
      let result: ReturnType<typeof terminal.use> | undefined
      expect(() => {
        result = terminal.use(extension)
      }).not.toThrow()
      expect(result instanceof Promise).toBe(true)
      await expect(result).rejects.toThrow()
      expect(cleanup).toEqual(['disposed'])
    }
    const absent = terminal.use({ name: 'absent OSC', setup: () => ({}) })
    expect(absent instanceof Promise).toBe(true)
    await absent
  })

  it('delivers submitted worker frames to an extension without a public frame listener', async () => {
    const terminal = await createWorkerTerminal()
    await terminal.open(workerContainer())
    const extensionRevisions: number[] = []
    const publicRevisions: number[] = []
    const handle = await terminal.use({
      name: 'worker frame observer',
      setup: () => ({
        events: {
          frame: () => extensionRevisions.push(terminal.submittedFrame!.nativeRevision),
        },
      }),
    })
    const control = terminal.onFrame(() =>
      publicRevisions.push(terminal.submittedFrame!.nativeRevision),
    )
    const first = await terminal.writeAndReadGeometry('control')
    await vi.waitFor(() => {
      expect(publicRevisions).toContain(first.revision)
      expect(extensionRevisions).toContain(first.revision)
    })
    control.dispose()
    const extensionOnly = await terminal.writeAndReadGeometry('extension only')
    await vi.waitFor(() => expect(extensionRevisions).toContain(extensionOnly.revision))
    handle.dispose()
    const received = extensionRevisions.length
    const detachedControl = terminal.onFrame(() =>
      publicRevisions.push(terminal.submittedFrame!.nativeRevision),
    )
    const detached = await terminal.writeAndReadGeometry('detached')
    await vi.waitFor(() => expect(publicRevisions).toContain(detached.revision))
    expect(extensionRevisions).toHaveLength(received)
    detachedControl.dispose()
  })

  it('claims original worker input synchronously before forwarding and preserves later keyless text', async () => {
    const terminal = await createWorkerTerminal()
    await terminal.open(workerContainer())
    const received: TerminalInputEvent[] = []
    const output: string[] = []
    terminal.onData((data) => output.push(new TextDecoder().decode(data)))
    await terminal.use({
      name: 'original worker input',
      setup: () => ({
        input: (event) => {
          received.push(event)
          if (event.type === 'text' && event.data === 'native pass') return 'pass'
          return 'claim'
        },
      }),
    })
    await terminal.sendInput('native pass')
    expect(output).toEqual(['native pass'])
    const text = terminal.sendInput('claimed text')
    const paste = terminal.paste('claimed paste')
    const key = terminal.key({
      action: 'press',
      code: 'KeyA',
      composing: false,
      text: 'a',
    })
    expect([text, paste, key].every((result) => result instanceof Promise)).toBe(true)
    expect((await Promise.all([text, paste, key])).map((bytes) => bytes.length)).toEqual([0, 0, 0])
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      code: 'KeyB',
      bubbles: true,
      cancelable: true,
    })
    terminal.textarea!.dispatchEvent(event)
    expect(received.at(-1)).toEqual({ type: 'key', event })
    expect(event.defaultPrevented).toBe(true)
    const textarea = terminal.textarea!
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
    textarea.value = '中'
    textarea.dispatchEvent(
      new InputEvent('input', {
        data: '中',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    )
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '中' }))
    textarea.value = '中'
    textarea.dispatchEvent(
      new InputEvent('input', {
        data: '中',
        inputType: 'insertText',
        isComposing: false,
      }),
    )
    expect(received.slice(-2)).toEqual([
      { type: 'composition', text: '中' },
      { type: 'text', data: '中' },
    ])
    await terminal.write('fence')
    expect(output).toEqual(['native pass'])
    expect(
      received.filter((input) => input.type === 'text' && input.data === 'native pass'),
    ).toHaveLength(1)
  })
})

describe('finite original input ownership', () => {
  it('offers finite ownership first, then interested general input, then native once', async () => {
    const terminal = await openTerminal()
    const order: string[] = []
    const output: string[] = []
    terminal.onData((bytes) => output.push(decoder.decode(bytes)))
    terminal.use({
      name: 'general input',
      setup: () => ({
        input: (input) => {
          order.push('general')
          return input.type === 'key' && 'event' in input && input.event.key === 'b'
            ? 'claim'
            : 'pass'
        },
      }),
    })
    terminal.connectInput((input) => {
      order.push('finite')
      return input.type === 'key' && 'event' in input && input.event.key === 'a' ? 'claim' : 'pass'
    })
    const claimed = press(terminal, 'a', 'KeyA')
    expect(claimed.defaultPrevented).toBe(true)
    expect(order).toEqual(['finite'])
    const general = press(terminal, 'b', 'KeyB')
    expect(general.defaultPrevented).toBe(true)
    expect(order).toEqual(['finite', 'finite', 'general'])
    press(terminal, 'c', 'KeyC')
    expect(order).toEqual(['finite', 'finite', 'general', 'finite', 'general'])
    expect(output).toEqual(['c'])
  })

  it('rejects a second finite owner and keeps old disposal from clearing a replacement', async () => {
    const terminal = await openTerminal()
    const output: string[] = []
    terminal.onData((bytes) => output.push(decoder.decode(bytes)))
    const first = terminal.connectInput(() => 'claim')
    expect(() => terminal.connectInput(() => 'pass')).toThrow('already has an owner')
    press(terminal)
    expect(output).toEqual([])
    first.dispose()
    expect(first.signal.aborted).toBe(true)
    const replacement = terminal.connectInput(() => 'claim')
    first.dispose()
    press(terminal)
    expect(output).toEqual([])
    replacement.dispose()
    press(terminal)
    expect(output).toEqual(['a'])
    const last = terminal.connectInput(() => 'pass')
    terminal.dispose()
    expect(last.signal.aborted).toBe(true)
    expect(() => terminal.connectInput(() => 'pass')).toThrow('disposed')
  })

  it.each(['owner', 'terminal'] as const)(
    'stops forwarding when the finite handler disposes its %s',
    async (target) => {
      const terminal = await openTerminal()
      const output: string[] = []
      const general = vi.fn(() => 'pass' as const)
      terminal.onData((bytes) => output.push(decoder.decode(bytes)))
      terminal.use({ name: 'general after finite', setup: () => ({ input: general }) })
      const connection = terminal.connectInput(() => {
        if (target === 'terminal') terminal.dispose()
        else connection.dispose()
        return 'pass'
      })
      const event = press(terminal)
      expect(event.defaultPrevented).toBe(true)
      expect(connection.signal.aborted).toBe(true)
      expect(general).not.toHaveBeenCalled()
      expect(output).toEqual([])
      if (target === 'owner') {
        press(terminal)
        expect(general).toHaveBeenCalledTimes(1)
        expect(output).toEqual(['a'])
      }
    },
  )

  it('claims original text, paste and composition while generated input and native replies bypass ownership', async () => {
    const terminal = await openTerminal()
    const seen: TerminalInputEvent[] = []
    const output: string[] = []
    terminal.onData((bytes) => output.push(decoder.decode(bytes)))
    terminal.connectInput((input) => {
      seen.push(input)
      return 'claim'
    })
    const key = { action: 'press', code: 'KeyQ', text: 'q', composing: false } as const
    expect(terminal.sendInput('original')).toHaveLength(0)
    expect(terminal.paste('original paste')).toHaveLength(0)
    expect(terminal.key(key)).toHaveLength(0)
    compose(terminal, '中', 'end-only')
    expect(seen).toEqual([
      { type: 'text', data: 'original' },
      { type: 'paste', data: 'original paste' },
      { type: 'key', input: key },
      { type: 'composition', text: '中' },
    ])
    expect(seen[2]?.type === 'key' && 'input' in seen[2] && seen[2].input).toBe(key)
    terminal.sendGeneratedInput({ type: 'text', data: 'generated' })
    terminal.sendGeneratedInput({ type: 'key', input: key })
    terminal.write('\x1b[5n')
    expect(output).toEqual(['generated', 'q', '\x1b[0n'])
    expect(seen).toHaveLength(4)
  })
})
