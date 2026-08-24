import type { Terminal as XtermTerminalType } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Terminal } from '../terminal.js'
import type { ITerminalAddon, ITerminalInitOnlyOptions, ITerminalOptions } from '../types.js'

interface Disposable {
  dispose(): void
}

interface SelectionPosition {
  readonly start: Readonly<{ x: number; y: number }>
  readonly end: Readonly<{ x: number; y: number }>
}

interface TerminalDriver extends Disposable {
  readonly cols: number
  readonly element: HTMLElement | undefined
  readonly name: string
  readonly options: ITerminalOptions
  readonly ready: Promise<void>
  readonly rows: number
  readonly textarea: HTMLTextAreaElement | undefined
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void
  blur(): void
  focus(): void
  getSelection(): string
  getSelectionPosition(): SelectionPosition | undefined
  input(data: string): void
  loadAddon(addon: ITerminalAddon): void
  onData(listener: (data: string) => void): Disposable
  onKey(listener: (event: { key: string; domEvent: KeyboardEvent }) => void): Disposable
  onResize(listener: (event: { cols: number; rows: number }) => void): Disposable
  onSelectionChange(listener: () => void): Disposable
  onWriteParsed(listener: () => void): Disposable
  open(parent: HTMLElement): void
  resize(cols: number, rows: number): void
  select(column: number, row: number, length: number): void
  write(data: string, callback?: () => void): void
}

type TerminalConstructionOptions = ITerminalOptions & ITerminalInitOnlyOptions
type RuntimeTerminalOptions = ITerminalOptions & Required<ITerminalInitOnlyOptions>

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

interface WriteSelectionObservation {
  readonly selection: string
  readonly selectionChanges: number
  readonly selectionPosition: SelectionPosition | undefined
  readonly timeline: readonly string[]
}

const drivers: TerminalDriver[] = []
const hosts: HTMLElement[] = []
let XtermTerminal: typeof XtermTerminalType | undefined

beforeAll(async () => {
  const runtimeUrl = new URL('../../../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url)
    .href
  const xterm = (await import(/* @vite-ignore */ runtimeUrl)) as {
    readonly Terminal: typeof XtermTerminalType
  }
  XtermTerminal = xterm.Terminal
})

afterEach(() => {
  for (const driver of drivers.splice(0).reverse()) driver.dispose()
  for (const host of hosts.splice(0).reverse()) host.remove()
})

function deferred(): Deferred {
  let resolvePromise = (): void => {}
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function trackedHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.height = '180px'
  host.style.width = '360px'
  document.body.append(host)
  hosts.push(host)
  return host
}

function createXtermDriver(options: TerminalConstructionOptions = {}): TerminalDriver {
  if (!XtermTerminal) throw new TypeError('xterm browser runtime was not loaded')
  const terminal = new XtermTerminal(options)
  return {
    attachCustomKeyEventHandler: (handler) => terminal.attachCustomKeyEventHandler(handler),
    attachCustomWheelEventHandler: (handler) => terminal.attachCustomWheelEventHandler(handler),
    blur: () => terminal.blur(),
    get cols() {
      return terminal.cols
    },
    dispose: () => terminal.dispose(),
    focus: () => terminal.focus(),
    get element() {
      return terminal.element
    },
    getSelection: () => terminal.getSelection(),
    getSelectionPosition: () => terminal.getSelectionPosition(),
    input: (data) => terminal.input(data),
    loadAddon: (addon) => terminal.loadAddon(addon as never),
    name: '@xterm/xterm@6.0.0',
    onData: (listener) => terminal.onData(listener),
    onKey: (listener) => terminal.onKey(listener),
    onResize: (listener) => terminal.onResize(listener),
    onSelectionChange: (listener) => terminal.onSelectionChange(listener),
    onWriteParsed: (listener) => terminal.onWriteParsed(listener),
    open: (parent) => terminal.open(parent),
    options: terminal.options,
    ready: Promise.resolve(),
    resize: (cols, rows) => terminal.resize(cols, rows),
    get rows() {
      return terminal.rows
    },
    select: (column, row, length) => terminal.select(column, row, length),
    get textarea() {
      return terminal.textarea
    },
    write: (data, callback) => terminal.write(data, callback),
  }
}

function createGhosttyDriver(options: TerminalConstructionOptions = {}): TerminalDriver {
  const terminal = new Terminal(options)
  const ready = Promise.all([terminal.ghosttyReady, terminal.ghosttyOpened]).then(() => {})
  void ready.catch(() => {})
  return {
    attachCustomKeyEventHandler: (handler) => terminal.attachCustomKeyEventHandler(handler),
    attachCustomWheelEventHandler: (handler) => terminal.attachCustomWheelEventHandler(handler),
    blur: () => terminal.blur(),
    get cols() {
      return terminal.cols
    },
    dispose: () => terminal.dispose(),
    focus: () => terminal.focus(),
    get element() {
      return terminal.element
    },
    getSelection: () => terminal.getSelection(),
    getSelectionPosition: () => terminal.getSelectionPosition(),
    input: (data) => terminal.input(data),
    loadAddon: (addon) => terminal.loadAddon(addon),
    name: 'ghostty-webgpu Terminal',
    onData: (listener) => terminal.onData(listener),
    onKey: (listener) => terminal.onKey(listener),
    onResize: (listener) => terminal.onResize(listener),
    onSelectionChange: (listener) => terminal.onSelectionChange(listener),
    onWriteParsed: (listener) => terminal.onWriteParsed(listener),
    open: (parent) => terminal.open(parent),
    options: terminal.options,
    ready,
    resize: (cols, rows) => terminal.resize(cols, rows),
    get rows() {
      return terminal.rows
    },
    select: (column, row, length) => terminal.select(column, row, length),
    get textarea() {
      return terminal.textarea
    },
    write: (data, callback) => terminal.write(data, callback),
  }
}

function trackedDrivers(options: TerminalConstructionOptions = {}): readonly TerminalDriver[] {
  const created = [createXtermDriver(options), createGhosttyDriver(options)]
  drivers.push(...created)
  return created
}

function dispatchKey(
  target: HTMLTextAreaElement,
  type: 'keydown' | 'keyup' = 'keydown',
  repeat = false,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code: 'KeyA',
    key: 'a',
    repeat,
  })
  target.dispatchEvent(event)
  return event
}

function dispatchWheel(target: HTMLElement): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: 24,
  })
  target.dispatchEvent(event)
  return event
}

function dispatchArrowUp(target: HTMLTextAreaElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'ArrowUp',
    key: 'ArrowUp',
  })
  Object.defineProperty(event, 'keyCode', { value: 38 })
  Object.defineProperty(event, 'which', { value: 38 })
  target.dispatchEvent(event)
  return event
}

function wheelTarget(driver: TerminalDriver): HTMLElement {
  const canvas = driver.element?.querySelector('canvas')
  if (canvas instanceof HTMLElement) return canvas
  if (driver.element) return driver.element
  throw new TypeError(`${driver.name} has no wheel target after open`)
}

async function observeWriteAndSelection(
  driver: TerminalDriver,
): Promise<WriteSelectionObservation> {
  const callback = deferred()
  const parsed = deferred()
  const timeline: string[] = []
  let selectionChanges = 0
  const subscriptions = [
    driver.onSelectionChange(() => {
      selectionChanges += 1
    }),
    driver.onWriteParsed(() => {
      timeline.push('onWriteParsed')
      parsed.resolve()
    }),
  ]
  driver.write('abcdef', () => {
    timeline.push('callback')
    callback.resolve()
  })
  timeline.push('returned')
  await Promise.all([callback.promise, parsed.promise])
  driver.select(1, 0, 3)
  const observation = {
    selection: driver.getSelection(),
    selectionChanges,
    selectionPosition: driver.getSelectionPosition(),
    timeline,
  }
  for (const subscription of subscriptions) subscription.dispose()
  return observation
}

describe.sequential('released xterm Terminal facade observables', () => {
  it('matches valid constructor dimensions, init-only options, and resize events', () => {
    const observations = trackedDrivers({ cols: 91, rows: 32 }).map((driver) => {
      const options = driver.options as RuntimeTerminalOptions
      const resizeEvents: Array<{ cols: number; rows: number }> = []
      driver.onResize(({ cols, rows }) => resizeEvents.push({ cols, rows }))
      expect(Object.hasOwn(options, 'cols'), driver.name).toBe(true)
      expect(Object.hasOwn(options, 'rows'), driver.name).toBe(true)
      expect(() => {
        options.cols = 100
      }, driver.name).toThrow()

      driver.resize(101, 44)
      driver.resize(101, 44)
      return {
        cols: driver.cols,
        initialOptionCols: options.cols,
        initialOptionRows: options.rows,
        resizeEvents,
        rows: driver.rows,
      }
    })

    expect(observations[0]).toEqual({
      cols: 101,
      initialOptionCols: 91,
      initialOptionRows: 32,
      resizeEvents: [{ cols: 101, rows: 44 }],
      rows: 44,
    })
    expect(observations[1]).toEqual(observations[0])
  })

  it('matches synchronous open, no-op reopen, and retained disposed DOM identities', () => {
    for (const driver of trackedDrivers()) {
      const firstHost = trackedHost()
      const secondHost = trackedHost()

      expect(driver.open(firstHost), driver.name).toBeUndefined()
      const opened = { element: driver.element, textarea: driver.textarea }
      expect(opened.element, driver.name).toBeInstanceOf(HTMLElement)
      expect(opened.textarea, driver.name).toBeInstanceOf(HTMLTextAreaElement)
      expect(firstHost.contains(opened.element!), driver.name).toBe(true)

      expect(driver.open(secondHost), driver.name).toBeUndefined()
      expect(driver.element, driver.name).toBe(opened.element)
      expect(driver.textarea, driver.name).toBe(opened.textarea)
      expect(firstHost.contains(opened.element!), driver.name).toBe(true)
      expect(secondHost.childElementCount, driver.name).toBe(0)
      expect(() => driver.open(null as unknown as HTMLElement), driver.name).toThrow()

      driver.dispose()
      expect(driver.element, driver.name).toBe(opened.element)
      expect(driver.textarea, driver.name).toBe(opened.textarea)
      expect(opened.element?.isConnected, driver.name).toBe(false)
      expect(opened.textarea?.isConnected, driver.name).toBe(false)
      expect(() => driver.focus(), driver.name).not.toThrow()
      expect(() => driver.blur(), driver.name).not.toThrow()
      expect(() => driver.open(firstHost), driver.name).not.toThrow()
    }
  })

  it.skip('matches released open behavior after disposal before the first open', () => {
    const observations = trackedDrivers().map((driver) => {
      driver.dispose()
      expect(() => driver.focus(), driver.name).not.toThrow()
      expect(() => driver.blur(), driver.name).not.toThrow()
      let openThrew = false
      try {
        driver.open(trackedHost())
      } catch {
        openThrew = true
      }
      return {
        connected: driver.element?.isConnected ?? false,
        hasElement: driver.element !== undefined,
        hasTextarea: driver.textarea !== undefined,
        openThrew,
      }
    })

    expect(observations[1]).toEqual(observations[0])
  })

  it('focuses and blurs the synchronous textarea before native readiness', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      driver.focus()
      expect(driver.textarea?.ownerDocument.activeElement, driver.name).toBe(driver.textarea)

      await driver.ready
      expect(driver.textarea?.ownerDocument.activeElement, driver.name).toBe(driver.textarea)

      driver.blur()
      expect(driver.textarea?.ownerDocument.activeElement, driver.name).not.toBe(driver.textarea)
    }
  })

  it('preserves focus-reporting order when focus precedes mode parsing', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      const callback = deferred()
      const data: string[] = []
      const subscription = driver.onData((value) => data.push(value))

      driver.focus()
      driver.write('\u001b[?1004h', () => callback.resolve())
      await Promise.all([driver.ready, callback.promise])
      expect(data, driver.name).toEqual(['\u001b[I'])

      driver.blur()
      driver.focus()
      expect(data, driver.name).toEqual(['\u001b[I', '\u001b[O', '\u001b[I'])
      subscription.dispose()
    }
  })

  it.skip('matches focus-report timing inside pre-ready write callbacks', async () => {
    const observations: string[][] = []
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      const callback = deferred()
      const data: string[] = []
      driver.onData((value) => data.push(value))
      driver.write('\u001b[?1004h', () => {
        driver.focus()
        const afterFocus = data.join('')
        driver.blur()
        observations.push([afterFocus, data.join('')])
        callback.resolve()
      })
      await Promise.all([driver.ready, callback.promise])
    }

    expect(observations[1]).toEqual(observations[0])
  })

  it('gives custom keyboard and wheel handlers first refusal', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      const calls: string[] = []
      const data: string[] = []
      const keys: string[] = []
      const subscriptions = [
        driver.onData((value) => data.push(value)),
        driver.onKey((event) => keys.push(event.key)),
      ]
      driver.attachCustomKeyEventHandler((event) => {
        calls.push(`key:${event.type}:${event.code}`)
        return false
      })
      driver.attachCustomWheelEventHandler((event) => {
        calls.push(`wheel:${event.deltaY}`)
        return false
      })

      const immediateKey = dispatchKey(driver.textarea!)
      const immediateWheel = dispatchWheel(wheelTarget(driver))
      expect(calls, driver.name).toEqual(['key:keydown:KeyA', 'wheel:24'])
      expect(immediateKey.defaultPrevented, driver.name).toBe(false)
      expect(immediateWheel.defaultPrevented, driver.name).toBe(false)

      await driver.ready
      calls.length = 0
      const key = dispatchKey(driver.textarea!)
      const repeatedKey = dispatchKey(driver.textarea!, 'keydown', true)
      const releasedKey = dispatchKey(driver.textarea!, 'keyup')
      const wheel = dispatchWheel(wheelTarget(driver))

      expect(calls, driver.name).toEqual([
        'key:keydown:KeyA',
        'key:keydown:KeyA',
        'key:keyup:KeyA',
        'wheel:24',
      ])
      expect(data, driver.name).toEqual([])
      expect(keys, driver.name).toEqual([])
      expect(key.defaultPrevented, driver.name).toBe(false)
      expect(repeatedKey.defaultPrevented, driver.name).toBe(false)
      expect(releasedKey.defaultPrevented, driver.name).toBe(false)
      expect(wheel.defaultPrevented, driver.name).toBe(false)
      for (const subscription of subscriptions) subscription.dispose()
    }
  })

  it('uses only the latest accepting key handler and emits matching key/data payloads', async () => {
    const observations: Array<{
      calls: string[]
      data: string[]
      defaultPrevented: boolean
      keys: string[]
    }> = []
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready
      const calls: string[] = []
      const data: string[] = []
      const keys: string[] = []
      driver.attachCustomKeyEventHandler(() => {
        calls.push('old')
        return false
      })
      driver.attachCustomKeyEventHandler(() => {
        calls.push('new')
        return true
      })
      const subscriptions = [
        driver.onData((value) => data.push(value)),
        driver.onKey((event) => keys.push(event.key)),
      ]

      const event = dispatchArrowUp(driver.textarea!)

      expect(calls, driver.name).toEqual(['new'])
      expect(data, driver.name).toHaveLength(1)
      expect(keys, driver.name).toEqual(data)
      expect(event.defaultPrevented, driver.name).toBe(true)
      observations.push({ calls, data, defaultPrevented: event.defaultPrevented, keys })
      for (const subscription of subscriptions) subscription.dispose()
    }
    expect(observations[1]).toEqual(observations[0])
  })

  it('skips event listeners disposed earlier in the same emission', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready
      const calls: string[] = []
      let second: Disposable | undefined
      driver.onData(() => {
        calls.push('first')
        second?.dispose()
      })
      second = driver.onData(() => calls.push('second'))

      driver.input('data')

      expect(calls, driver.name).toEqual(['first'])
    }
  })

  it('keeps failed addon activation registered for later terminal disposal', () => {
    for (const driver of trackedDrivers()) {
      const failure = new Error('activate failed')
      let disposeCount = 0
      const addon: ITerminalAddon = {
        activate() {
          throw failure
        },
        dispose() {
          disposeCount += 1
        },
      }
      const originalDispose = addon.dispose

      expect(() => driver.loadAddon(addon), driver.name).toThrow(failure)
      expect(addon.dispose, driver.name).not.toBe(originalDispose)
      driver.dispose()
      expect(disposeCount, driver.name).toBe(1)
    }
  })

  it('matches write ordering and selection observables after readiness', async () => {
    const observations: WriteSelectionObservation[] = []
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready
      observations.push(await observeWriteAndSelection(driver))
    }

    expect(observations[0]).toEqual({
      selection: 'bcd',
      selectionChanges: 1,
      selectionPosition: { end: { x: 4, y: 0 }, start: { x: 1, y: 0 } },
      timeline: ['returned', 'callback', 'onWriteParsed'],
    })
    expect(observations[1]).toEqual(observations[0])
  })
})
