import { describe, expect, it, vi } from 'vitest'
import { TerminalOptionsStore } from '../options.js'
import type { ITerminalInitOnlyOptions, ITerminalOptions } from '../types.js'

type RuntimeOptions = ITerminalOptions & Required<ITerminalInitOnlyOptions>

function runtimeOptions(store: TerminalOptionsStore): RuntimeOptions {
  return store.options as RuntimeOptions
}

describe('TerminalOptionsStore', () => {
  it('exposes live constructor-only dimensions as enumerable own options', () => {
    const store = new TerminalOptionsStore({ cols: 91, rows: 32 })
    const options = runtimeOptions(store)

    expect(Object.hasOwn(options, 'cols')).toBe(true)
    expect(Object.hasOwn(options, 'rows')).toBe(true)
    expect(Object.keys(options)).toEqual(expect.arrayContaining(['cols', 'rows']))
    expect(options.cols).toBe(91)
    expect(options.rows).toBe(32)

    store.resize(101, 44)
    expect(options.cols).toBe(91)
    expect(options.rows).toBe(32)
  })

  it('rejects direct and bulk dimension changes as constructor-only options', () => {
    const store = new TerminalOptionsStore({ cols: 91, rows: 32 })
    const options = runtimeOptions(store)

    expect(() => {
      options.cols = 100
    }).toThrow('Option "cols" can only be set in the constructor')
    expect(() => store.set({ rows: 40 } as ITerminalOptions)).toThrow(
      'Option "rows" can only be set in the constructor',
    )
    expect(store.cols).toBe(91)
    expect(store.rows).toBe(32)
  })

  it('logs invalid constructor dimensions and keeps released defaults', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const store = new TerminalOptionsStore({
      cols: Number.NaN,
      rows: Number.NaN,
    })

    expect(store.cols).toBe(80)
    expect(store.rows).toBe(24)
    expect(consoleError).toHaveBeenCalledTimes(2)
    expect(consoleError.mock.calls.map(([cause]) => String(cause))).toEqual([
      'TypeError: cols must be an integer',
      'TypeError: rows must be an integer',
    ])
    consoleError.mockRestore()
  })

  it('rolls public options back when native application fails', () => {
    const failure = new Error('native apply failed')
    const store = new TerminalOptionsStore({}, () => {
      throw failure
    })
    const options = store.options

    expect(() => store.set({ cursorBlink: true, fontSize: 18 })).toThrow(failure)
    expect(options.cursorBlink).toBe(false)
    expect(options.fontSize).toBe(15)
    expect(store.values.cursorBlink).toBe(false)
    expect(store.values.fontSize).toBe(15)
  })

  it('applies bulk options sequentially and retains changes before a failure', () => {
    const store = new TerminalOptionsStore({ fontSize: 15, scrollback: 1000 })

    expect(() => store.set({ fontSize: 19, scrollback: -1 })).toThrow(
      'scrollback cannot be less than 0',
    )

    expect(store.options.fontSize).toBe(19)
    expect(store.options.scrollback).toBe(1000)
  })

  it('matches released sanitizer handling for undefined and non-finite values', () => {
    const store = new TerminalOptionsStore()

    store.set({
      cursorWidth: undefined,
      fastScrollSensitivity: Number.NaN,
      fontSize: undefined,
      lineHeight: undefined,
      minimumContrastRatio: undefined,
      scrollback: undefined,
      scrollSensitivity: undefined,
    })

    expect(store.options.cursorWidth).toBeNaN()
    expect(store.options.fastScrollSensitivity).toBeNaN()
    expect(store.options.fontSize).toBeUndefined()
    expect(store.options.lineHeight).toBeUndefined()
    expect(store.options.minimumContrastRatio).toBeNaN()
    expect(store.options.scrollback).toBeNaN()
    expect(store.options.scrollSensitivity).toBeUndefined()
  })
})
