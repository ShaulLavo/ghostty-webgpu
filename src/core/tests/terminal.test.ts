import { afterEach, describe, expect, it } from 'vitest'
import { GhosttyResult, TerminalMode, TerminalScreen } from '../abi.js'
import type { AbiLayouts } from '../abi.js'
import { GhosttyRuntime } from '../runtime.js'
import { GhosttyTerminal } from '../terminal.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

function createScrollbarTerminal(values: {
  length: bigint
  offset: bigint
  total: bigint
}): GhosttyTerminal {
  const buffer = new ArrayBuffer(64)
  const view = new DataView(buffer)
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
  const fakeRuntime = {
    ensureActive() {},
    exports: {
      ghostty_terminal_get(_terminal: number, _data: number, pointer: number) {
        view.setBigUint64(pointer, values.total, true)
        view.setBigUint64(pointer + 8, values.offset, true)
        view.setBigUint64(pointer + 16, values.length, true)
        return GhosttyResult.Success
      },
    },
    layouts,
    memory: {
      allocate: () => 8,
      free() {},
      view,
    },
  } as unknown as GhosttyRuntime
  return Object.assign(Object.create(GhosttyTerminal.prototype), {
    defaultCursorBlinkValue: false,
    defaultCursorStyleValue: 'block',
    disposed: false,
    effects: {},
    handleValue: 1,
    runtime: fakeRuntime,
    sizeValue: { cellHeight: 16, cellWidth: 8, columns: 80, rows: 24 },
  }) as GhosttyTerminal
}

describe('terminal state', () => {
  it('reads cursor, screen, and live terminal modes', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })

    expect(terminal.activeScreen).toBe(TerminalScreen.Primary)
    expect(terminal.isModeEnabled(TerminalMode.BracketedPaste)).toBe(false)

    terminal.setMode(TerminalMode.FocusEvent, true)
    terminal.write('\u001b[2;3H\u001b[?25l\u001b[?2004h')

    expect(terminal.cursor).toEqual({ pendingWrap: false, visible: false, x: 2, y: 1 })
    expect(terminal.isModeEnabled(TerminalMode.FocusEvent)).toBe(true)
    expect(terminal.isModeEnabled(TerminalMode.BracketedPaste)).toBe(true)

    terminal.write('\u001b[?1049h')

    expect(terminal.activeScreen).toBe(TerminalScreen.Alternate)
  })

  it('sets the scrollback limit and moves the native viewport', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })

    expect(terminal.scrollbackLimit).toBeUndefined()
    terminal.setScrollbackLimit(0xffffffff)
    // Upstream reserves maxInt(usize) as its unlimited sentinel.
    expect(terminal.scrollbackLimit).toBeUndefined()
    expect(() => terminal.setScrollbackLimit(0x100000000)).toThrow('safe integer between 0 and')
    expect(() => terminal.setScrollbackLimit(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      'safe integer between 0 and',
    )

    terminal.setScrollbackLimit(123)
    expect(terminal.scrollbackLimit).toBe(123)
    terminal.setScrollbackLimit(undefined)
    expect(terminal.scrollbackLimit).toBeUndefined()
    terminal.write('0\r\n1\r\n2\r\n3\r\n4\r\n5')

    expect(terminal.scrollbackLength).toBe(3)
    expect(terminal.scrollbar).toEqual({ length: 3, offset: 3, total: 6 })
    expect(terminal.viewportActive).toBe(true)

    terminal.scrollToTop()
    expect(terminal.scrollbar.offset).toBe(0)
    expect(terminal.viewportActive).toBe(false)

    terminal.scrollToRow(2)
    expect(terminal.scrollbar.offset).toBe(2)
    terminal.scrollBy(-1)
    expect(terminal.scrollbar.offset).toBe(1)
    expect(() => terminal.scrollToRow(0x100000000)).toThrow('safe integer between 0 and')

    terminal.scrollToBottom()
    expect(terminal.scrollbar.offset).toBe(3)
    expect(terminal.viewportActive).toBe(true)
  })

  it('formats terminal-owned selection and resolves an OSC 8 grid reference', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 3 })
    terminal.write('\u001b]8;;https://example.com/path\u0007e\u0301界\u001b]8;;\u0007')

    expect(terminal.hasSelection).toBe(false)
    expect(terminal.getSelection()).toBeUndefined()
    expect(terminal.selectAll()).toBe(true)
    expect(terminal.hasSelection).toBe(true)
    expect(terminal.getSelection()).toBe('e\u0301界')
    expect(terminal.linkAt({ tag: 'viewport', x: 0, y: 0 })).toBe('https://example.com/path')
    expect(terminal.linkAt({ tag: 'viewport', x: 10, y: 0 })).toBeUndefined()

    terminal.clearSelection()

    expect(terminal.hasSelection).toBe(false)
    expect(terminal.getSelection()).toBeUndefined()
  })

  it('keeps semantic defaults separate from effective OSC color overrides', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()

    expect(terminal.defaultForegroundColor).toBeUndefined()
    expect(terminal.defaultBackgroundColor).toBeUndefined()
    expect(terminal.defaultCursorColor).toBeUndefined()

    terminal.setDefaultForegroundColor({ b: 3, g: 2, r: 1 })
    terminal.setDefaultBackgroundColor({ b: 6, g: 5, r: 4 })
    terminal.setDefaultCursorColor({ b: 9, g: 8, r: 7 })
    const palette = terminal.defaultPalette.map((color) => ({ ...color }))
    palette[42] = { b: 12, g: 11, r: 10 }
    terminal.setDefaultPalette(palette)

    expect(terminal.defaultColors.foreground).toEqual({ b: 3, g: 2, r: 1 })
    expect(terminal.defaultColors.background).toEqual({ b: 6, g: 5, r: 4 })
    expect(terminal.defaultColors.cursor).toEqual({ b: 9, g: 8, r: 7 })
    expect(terminal.defaultColors.palette[42]).toEqual({ b: 12, g: 11, r: 10 })
    expect(terminal.colors).toEqual(terminal.defaultColors)

    terminal.write('\u001b]10;rgb:ffff/0000/0000\u0007')
    terminal.write('\u001b]4;42;rgb:0101/0202/0303\u0007')

    expect(terminal.foregroundColor).toEqual({ b: 0, g: 0, r: 255 })
    expect(terminal.defaultForegroundColor).toEqual({ b: 3, g: 2, r: 1 })
    expect(terminal.palette[42]).toEqual({ b: 3, g: 2, r: 1 })
    expect(terminal.defaultPalette[42]).toEqual({ b: 12, g: 11, r: 10 })

    terminal.setDefaultCursorStyle('bar')
    terminal.setDefaultCursorBlink(true)
    expect(terminal.defaultCursorStyle).toBe('bar')
    expect(terminal.defaultCursorBlink).toBe(true)

    terminal.setDefaultCursorStyle(undefined)
    terminal.setDefaultCursorBlink(undefined)
    expect(terminal.defaultCursorStyle).toBe('block')
    expect(terminal.defaultCursorBlink).toBe(false)
  })

  it('is safe to dispose twice and rejects later state access', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()

    terminal.dispose()

    expect(() => terminal.dispose()).not.toThrow()
    expect(() => terminal.cursor).toThrow('The terminal has been disposed')
  })
})

describe('scrollbar uint64 decoding', () => {
  it('preserves values above uint32 without truncation', () => {
    const terminal = createScrollbarTerminal({
      length: 0x100000001n,
      offset: 0x100000002n,
      total: 0x100000003n,
    })

    expect(terminal.scrollbar).toEqual({
      length: 0x100000001,
      offset: 0x100000002,
      total: 0x100000003,
    })
  })

  it('accepts exactly Number.MAX_SAFE_INTEGER', () => {
    const maximum = BigInt(Number.MAX_SAFE_INTEGER)
    const terminal = createScrollbarTerminal({ length: maximum, offset: maximum, total: maximum })

    expect(terminal.scrollbar).toEqual({
      length: Number.MAX_SAFE_INTEGER,
      offset: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
    })
  })

  it('rejects Number.MAX_SAFE_INTEGER + 1 before numeric conversion', () => {
    const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n
    const terminal = createScrollbarTerminal({ length: 1n, offset: 1n, total: unsafe })

    expect(() => terminal.scrollbar).toThrow('scrollbar total exceeds Number.MAX_SAFE_INTEGER')
  })
})
