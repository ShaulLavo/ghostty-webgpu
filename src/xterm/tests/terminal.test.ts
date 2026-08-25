import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSession } from '../../term/session.js'
import { Plan009UnavailableError } from '../placeholders.js'
import { Terminal } from '../terminal.js'
import type { ITerminalAddon } from '../types.js'

const terminals: Terminal[] = []

afterEach(async () => {
  const owned = terminals.splice(0).reverse()
  for (const terminal of owned) terminal.dispose()
  await Promise.allSettled(owned.map((terminal) => terminal.ghosttyReady))
})

function trackedTerminal(options: ConstructorParameters<typeof Terminal>[0] = {}): Terminal {
  const terminal = new Terminal(options)
  terminals.push(terminal)
  return terminal
}

function addon(
  name: string,
  timeline: string[],
  onActivate?: (terminal: Terminal) => void,
): ITerminalAddon {
  return {
    activate(terminal) {
      timeline.push(`activate:${name}`)
      onActivate?.(terminal)
    },
    dispose() {
      timeline.push(`dispose:${name}`)
    },
  }
}

describe('xterm Terminal facade', () => {
  it('returns fresh static string accessors backed by shared values', () => {
    const first = Terminal.strings
    const second = Terminal.strings
    const originalPromptLabel = first.promptLabel

    try {
      expect(second).not.toBe(first)
      first.promptLabel = 'Custom prompt'
      expect(second.promptLabel).toBe('Custom prompt')
      expect(Terminal.strings.promptLabel).toBe('Custom prompt')
      expect(Object.getOwnPropertyDescriptor(Terminal, 'strings')?.set).toBeUndefined()
    } finally {
      first.promptLabel = originalPromptLabel
    }
  })

  it('exposes synchronous constructor defaults and one live options object', async () => {
    const terminal = trackedTerminal({ cols: 92, rows: 31 })
    const options = terminal.options

    expect(terminal.cols).toBe(92)
    expect(terminal.rows).toBe(31)
    expect(terminal.element).toBeUndefined()
    expect(terminal.textarea).toBeUndefined()
    expect(options).toBe(terminal.options)
    expect(options).toMatchObject({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: false,
      cursorStyle: 'block',
      disableStdin: false,
      fontFamily: 'monospace',
      fontSize: 15,
      scrollback: 1000,
      scrollOnUserInput: true,
    })

    options.fontSize = 17
    terminal.options = { cursorBlink: true, scrollback: 250 }

    expect(terminal.options).toBe(options)
    expect(options.fontSize).toBe(17)
    expect(options.cursorBlink).toBe(true)
    expect(options.scrollback).toBe(250)

    expect(() => {
      terminal.options = { fontSize: 19, scrollback: -1 }
    }).toThrow('scrollback cannot be less than 0')
    expect(options.fontSize).toBe(19)
    expect(options.scrollback).toBe(250)

    await terminal.ghosttyReady
    expect(terminal.options).toBe(options)
    expect(terminal.cols).toBe(92)
    expect(terminal.rows).toBe(31)
  })

  it('updates shadow dimensions synchronously and emits only real resize changes', async () => {
    const terminal = trackedTerminal()
    const events: Array<{ cols: number; rows: number }> = []
    terminal.onResize((event) => events.push(event))

    terminal.resize(101, 37)
    terminal.resize(101, 37)

    expect(terminal.cols).toBe(101)
    expect(terminal.rows).toBe(37)
    expect(events).toEqual([{ cols: 101, rows: 37 }])

    await terminal.ghosttyReady
    terminal.resize(102, 38)

    expect(terminal.cols).toBe(102)
    expect(terminal.rows).toBe(38)
    expect(events).toEqual([
      { cols: 101, rows: 37 },
      { cols: 102, rows: 38 },
    ])
  })

  it('retains bytes through scheduled slices and preserves FIFO callback order', async () => {
    const terminal = trackedTerminal({ cols: 8, rows: 3 })
    const bytes = new Uint8Array([0x42])
    const timeline: string[] = []
    let bytesWritten = false
    const parsed = new Promise<void>((resolve) => {
      const subscription = terminal.onWriteParsed(() => {
        timeline.push('parsed')
        if (!bytesWritten) return
        subscription.dispose()
        resolve()
      })
    })

    terminal.write('A', () => timeline.push('string'))
    terminal.write(bytes, () => {
      timeline.push('bytes')
      bytesWritten = true
    })
    bytes[0] = 0x58
    timeline.push('returned')

    await parsed

    expect(timeline.filter((event) => event !== 'parsed')).toEqual(['returned', 'string', 'bytes'])
    expect(timeline.at(-1)).toBe('parsed')
    terminal.select(0, 0, 2)
    expect(terminal.getSelection()).toBe('AX')
  })

  it('emits input synchronously and honors the live disableStdin option', async () => {
    const terminal = trackedTerminal({ disableStdin: true })
    const data: string[] = []
    terminal.onData((value) => data.push(value))

    terminal.input('blocked-before-ready')
    terminal.options.disableStdin = false
    terminal.input('before-ready')

    expect(data).toEqual(['before-ready'])

    await terminal.ghosttyReady
    terminal.input('after-ready', false)
    terminal.options.disableStdin = true
    terminal.input('blocked-after-ready')

    expect(data).toEqual(['before-ready', 'after-ready'])
  })

  it('visually clears the active screen after native readiness', async () => {
    const terminal = trackedTerminal({ cols: 5, rows: 3 })
    await terminal.ghosttyReady
    await new Promise<void>((resolve) => {
      terminal.write('one\r\ntwo\r\nthree\r\nkeep!', resolve)
    })

    terminal.clear()
    terminal.select(0, 0, 5)

    expect(terminal.getSelection()).toBe('')
  })

  it('treats pre-ready clear as a synchronous no-op before queued writes', async () => {
    const terminal = trackedTerminal({ cols: 8, rows: 3 })
    const written = new Promise<void>((resolve) => terminal.write('queued', resolve))

    expect(() => terminal.clear()).not.toThrow()
    await Promise.all([terminal.ghosttyReady, written])
    terminal.select(0, 0, 6)

    expect(terminal.getSelection()).toBe('queued')
  })

  it('disposes the native session when initial option application fails', async () => {
    const dispose = vi.spyOn(TerminalSession.prototype, 'dispose')
    try {
      const terminal = trackedTerminal({ logLevel: 'off', theme: null as never })

      await expect(terminal.ghosttyReady).rejects.toBeInstanceOf(TypeError)
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      dispose.mockRestore()
    }
  })

  it('abandons callbacks when native creation fails without claiming a parse', async () => {
    const terminal = trackedTerminal({ logLevel: 'off', theme: null as never })
    let callbackCount = 0
    let parsedCount = 0
    terminal.onWriteParsed(() => {
      parsedCount += 1
    })
    terminal.write('queued', () => {
      callbackCount += 1
    })

    await expect(terminal.ghosttyReady).rejects.toBeInstanceOf(TypeError)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callbackCount).toBe(0)
    expect(parsedCount).toBe(0)
  })

  it('abandons writes disposed before delivery without fake completion', async () => {
    const terminal = trackedTerminal()
    let callbackCount = 0
    let parsedCount = 0
    terminal.onWriteParsed(() => {
      parsedCount += 1
    })
    terminal.write('queued', () => {
      callbackCount += 1
    })

    terminal.dispose()
    await Promise.allSettled([terminal.ghosttyReady])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callbackCount).toBe(0)
    expect(parsedCount).toBe(0)
  })

  it('emits line-feed events for LF, VT, and FF parser controls', async () => {
    const terminal = trackedTerminal()
    await terminal.ghosttyReady
    let lineFeeds = 0
    terminal.onLineFeed(() => {
      lineFeeds += 1
    })

    await new Promise<void>((resolve) => terminal.write('\n\v\f', resolve))

    expect(lineFeeds).toBe(3)
  })

  it('treats pre-ready reset and scrolling as empty-terminal no-ops', async () => {
    const terminal = trackedTerminal()

    expect(() => terminal.reset()).not.toThrow()
    expect(() => terminal.scrollLines(-1)).not.toThrow()
    expect(() => terminal.scrollPages(1)).not.toThrow()
    expect(() => terminal.scrollToLine(-1)).not.toThrow()
    expect(() => terminal.scrollToTop()).not.toThrow()
    expect(() => terminal.scrollToBottom()).not.toThrow()

    await terminal.ghosttyReady
  })

  it('activates addons synchronously, honors self-disposal, and disposes the rest in reverse', () => {
    const terminal = trackedTerminal()
    const timeline: string[] = []
    let activatedWith: Terminal | undefined
    const first = addon('first', timeline, (value) => {
      activatedWith = value
    })
    const selfDisposed = addon('self', timeline)
    const last = addon('last', timeline)

    terminal.loadAddon(first)
    terminal.loadAddon(selfDisposed)
    selfDisposed.dispose()
    selfDisposed.dispose()
    terminal.loadAddon(last)

    expect(activatedWith).toBe(terminal)
    expect(timeline).toEqual(['activate:first', 'activate:self', 'dispose:self', 'activate:last'])

    terminal.dispose()
    terminal.dispose()

    expect(timeline).toEqual([
      'activate:first',
      'activate:self',
      'dispose:self',
      'activate:last',
      'dispose:last',
      'dispose:first',
    ])
  })

  it('disposes an addon whose activation failed', () => {
    const terminal = trackedTerminal()
    const timeline: string[] = []
    const activationFailure = new Error('activate failed')
    const failed = addon('failed', timeline, () => {
      throw activationFailure
    })
    const wrappedDispose = failed.dispose

    expect(() => terminal.loadAddon(failed)).toThrow(activationFailure)
    expect(failed.dispose).not.toBe(wrappedDispose)

    terminal.dispose()

    expect(timeline).toEqual(['activate:failed', 'dispose:failed'])
  })

  it('keeps extension placeholders stable and gates proposed surfaces from live options', async () => {
    const terminal = trackedTerminal()
    const buffer = terminal.buffer
    const modes = terminal.modes
    const parser = terminal.parser

    expect(terminal.buffer).toBe(buffer)
    expect(terminal.modes).toBe(modes)
    expect(terminal.parser).toBe(parser)
    expect(() => buffer.active).toThrow(Plan009UnavailableError)
    expect(() => parser.registerCsiHandler({ final: 'm' }, () => true)).toThrow(
      Plan009UnavailableError,
    )
    expect(() => terminal.markers).toThrow('allowProposedApi option to true')
    expect(() => terminal.unicode).toThrow('allowProposedApi option to true')

    terminal.options.allowProposedApi = true
    const markers = terminal.markers
    const unicode = terminal.unicode

    expect(terminal.markers).toBe(markers)
    expect(terminal.unicode).toBe(unicode)
    expect(Object.isFrozen(markers)).toBe(true)
    expect(() => unicode.versions).toThrow(Plan009UnavailableError)

    await terminal.ghosttyReady
    expect(terminal.modes).toBe(modes)
    expect(() => modes.bracketedPasteMode).toThrow(Plan009UnavailableError)
  })

  it('makes subscriptions and disposal idempotent and retains disposed options mutability', async () => {
    const terminal = trackedTerminal()
    let resizeEvents = 0
    const subscription = terminal.onResize(() => {
      resizeEvents += 1
    })

    terminal.resize(81, 25)
    subscription.dispose()
    subscription.dispose()
    terminal.resize(82, 26)

    expect(resizeEvents).toBe(1)

    await terminal.ghosttyReady
    terminal.dispose()
    terminal.dispose()

    expect(() => terminal.resize(83, 27)).toThrow('after disposal')
    expect(() => terminal.write('late')).toThrow('after disposal')
    expect(() => {
      terminal.options.fontSize = 16
      terminal.options = { cursorBlink: true }
    }).not.toThrow()
    expect(terminal.options.fontSize).toBe(16)
    expect(terminal.options.cursorBlink).toBe(true)

    let lateAddonActivations = 0
    expect(() =>
      terminal.loadAddon({
        activate() {
          lateAddonActivations += 1
        },
        dispose() {},
      }),
    ).not.toThrow()
    expect(() => terminal.attachCustomKeyEventHandler(() => true)).not.toThrow()
    expect(() => terminal.attachCustomWheelEventHandler(() => true)).not.toThrow()
    expect(lateAddonActivations).toBe(1)

    const lateSubscription = terminal.onResize(() => {
      resizeEvents += 1
    })
    lateSubscription.dispose()
    lateSubscription.dispose()
    expect(resizeEvents).toBe(1)
  })
})
