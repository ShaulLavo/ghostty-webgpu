import type { Terminal as XtermTerminalType } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { GhosttyWebGpuRenderer } from '../../dom/types.js'
import type { RendererTheme } from '../../render/instances/types.js'
import {
  WebGpuTerminalRenderer,
  type RendererGridSize,
  type WebGpuTerminalRendererOptions,
} from '../../render/renderer.js'
import type { TerminalFittedFont } from '../../term/types.js'
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
  clear(): void
  clearSelection(): void
  focus(): void
  getSelection(): string
  getSelectionPosition(): SelectionPosition | undefined
  hasSelection(): boolean
  input(data: string, wasUserInput?: boolean): void
  loadAddon(addon: ITerminalAddon): void
  onData(listener: (data: string) => void): Disposable
  onKey(listener: (event: { key: string; domEvent: KeyboardEvent }) => void): Disposable
  onLineFeed(listener: () => void): Disposable
  onResize(listener: (event: { cols: number; rows: number }) => void): Disposable
  onScroll(listener: (position: number) => void): Disposable
  onSelectionChange(listener: () => void): Disposable
  onWriteParsed(listener: () => void): Disposable
  open(parent: HTMLElement): void
  resize(cols: number, rows: number): void
  select(column: number, row: number, length: number): void
  selectAll(): void
  selectLines(start: number, end: number): void
  setOptions(options: ITerminalOptions): void
  write(data: string | Uint8Array, callback?: () => void): void
  writeln(data: string | Uint8Array, callback?: () => void): void
}

type TerminalConstructionOptions = ITerminalOptions & ITerminalInitOnlyOptions
type RuntimeTerminalOptions = ITerminalOptions & Required<ITerminalInitOnlyOptions>

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

interface DeferredValue<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

interface WriteSelectionObservation {
  readonly selection: string
  readonly selectionChanges: number
  readonly selectionPosition: SelectionPosition | undefined
  readonly timeline: readonly string[]
}

interface VisualClearObservation {
  readonly content: string
  readonly hasSelection: boolean
  readonly position: SelectionPosition | undefined
  readonly selection: string
  readonly selectionChanges: number
  readonly scroll: readonly number[]
}

interface ListenerFailureObservation {
  readonly globalError: boolean
  readonly laterListeners: number
  readonly loggerErrors: number
}

const drivers: TerminalDriver[] = []
const hosts: HTMLElement[] = []
const rendererRestores: Array<() => void> = []
let XtermTerminal: typeof XtermTerminalType | undefined

class NoopRenderer implements GhosttyWebGpuRenderer {
  readonly themes: Partial<RendererTheme>[] = []

  dispose(): void {}
  notifyScroll(): void {}
  notifySelectionChange(): void {}
  notifyWrite(): void {}
  resize(_grid: RendererGridSize): void {}
  schedule(): void {}
  setCursorBlinkEnabled(_enabled: boolean): void {}
  setDocumentVisible(_visible: boolean): void {}
  setFocused(_focused: boolean): void {}
  setFont(_font: TerminalFittedFont): void {}
  setTheme(theme: Partial<RendererTheme>): void {
    this.themes.push(theme)
  }
}

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
  for (const restore of rendererRestores.splice(0).reverse()) restore()
})

function deferred(): Deferred {
  let resolvePromise = (): void => {}
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function deferredValue<T>(): DeferredValue<T> {
  let resolveValue = (_value: T): void => {}
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve
  })
  return { promise, resolve: resolveValue }
}

function deferRendererCreation(): {
  readonly creation: DeferredValue<WebGpuTerminalRenderer>
  readonly requested: Deferred
} {
  const creation = deferredValue<WebGpuTerminalRenderer>()
  const requested = deferred()
  const originalCreate = WebGpuTerminalRenderer.create
  WebGpuTerminalRenderer.create = (() => {
    requested.resolve()
    return creation.promise
  }) as typeof WebGpuTerminalRenderer.create
  rendererRestores.push(() => {
    WebGpuTerminalRenderer.create = originalCreate
  })
  return { creation, requested }
}

function noopRenderer(): WebGpuTerminalRenderer {
  return new NoopRenderer() as unknown as WebGpuTerminalRenderer
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
    clear: () => terminal.clear(),
    clearSelection: () => terminal.clearSelection(),
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
    hasSelection: () => terminal.hasSelection(),
    input: (data, wasUserInput) => terminal.input(data, wasUserInput),
    loadAddon: (addon) => terminal.loadAddon(addon as never),
    name: '@xterm/xterm@6.0.0',
    onData: (listener) => terminal.onData(listener),
    onKey: (listener) => terminal.onKey(listener),
    onLineFeed: (listener) => terminal.onLineFeed(listener),
    onResize: (listener) => terminal.onResize(listener),
    onScroll: (listener) => terminal.onScroll(listener),
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
    selectAll: () => terminal.selectAll(),
    selectLines: (start, end) => terminal.selectLines(start, end),
    setOptions: (options) => {
      terminal.options = options
    },
    get textarea() {
      return terminal.textarea
    },
    write: (data, callback) => terminal.write(data, callback),
    writeln: (data, callback) => terminal.writeln(data, callback),
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
    clear: () => terminal.clear(),
    clearSelection: () => terminal.clearSelection(),
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
    hasSelection: () => terminal.hasSelection(),
    input: (data, wasUserInput) => terminal.input(data, wasUserInput),
    loadAddon: (addon) => terminal.loadAddon(addon),
    name: 'ghostty-webgpu Terminal',
    onData: (listener) => terminal.onData(listener),
    onKey: (listener) => terminal.onKey(listener),
    onLineFeed: (listener) => terminal.onLineFeed(listener),
    onResize: (listener) => terminal.onResize(listener),
    onScroll: (listener) => terminal.onScroll(listener),
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
    selectAll: () => terminal.selectAll(),
    selectLines: (start, end) => terminal.selectLines(start, end),
    setOptions: (options) => {
      terminal.options = options
    },
    get textarea() {
      return terminal.textarea
    },
    write: (data, callback) => terminal.write(data, callback),
    writeln: (data, callback) => terminal.writeln(data, callback),
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

async function observeWriteTaskOrder(driver: TerminalDriver): Promise<readonly string[]> {
  const parsed = deferred()
  const timeline: string[] = []
  const subscription = driver.onWriteParsed(() => {
    timeline.push('onWriteParsed')
    parsed.resolve()
  })
  driver.write('task', () => timeline.push('callback'))
  timeline.push('returned')
  await Promise.resolve()
  timeline.push('microtask')
  await parsed.promise
  subscription.dispose()
  return timeline
}

async function observeMutableBytes(driver: TerminalDriver): Promise<string> {
  const bytes = new Uint8Array([0x41])
  const written = deferred()
  driver.write(bytes, () => written.resolve())
  bytes[0] = 0x42
  queueMicrotask(() => {
    bytes[0] = 0x43
  })
  await written.promise
  driver.select(0, 0, 1)
  return driver.getSelection()
}

async function observeUserInputWrite(
  driver: TerminalDriver,
  wasUserInput: boolean,
): Promise<readonly string[]> {
  const parsed = deferred()
  const timeline: string[] = []
  const subscription = driver.onWriteParsed(() => {
    timeline.push('onWriteParsed')
    parsed.resolve()
  })
  driver.input('typed', wasUserInput)
  driver.write('response', () => timeline.push('callback'))
  timeline.push('returned')
  await parsed.promise
  subscription.dispose()
  return timeline
}

async function observeParsedUserInputWrite(driver: TerminalDriver): Promise<readonly string[]> {
  const nestedParsed = deferred()
  const timeline: string[] = []
  let parsed = 0
  const subscription = driver.onWriteParsed(() => {
    parsed += 1
    const event = parsed
    timeline.push(`parsed:${event}:start`)
    if (event === 1) {
      driver.input('typed', true)
      timeline.push('before')
      driver.write('B', () => timeline.push('B'))
      timeline.push('after')
    }
    timeline.push(`parsed:${event}:end`)
    if (event === 2) nestedParsed.resolve()
  })
  driver.write('A', () => timeline.push('A'))
  await nestedParsed.promise
  subscription.dispose()
  return timeline
}

async function observeReentrantWrite(driver: TerminalDriver): Promise<readonly string[]> {
  const parsed = deferred()
  const timeline: string[] = []
  const subscription = driver.onWriteParsed(() => {
    timeline.push('onWriteParsed')
    parsed.resolve()
  })
  driver.write('A', () => {
    timeline.push('A')
    driver.write('B', () => timeline.push('B'))
  })
  await parsed.promise
  subscription.dispose()
  return timeline
}

async function observeWriteln(driver: TerminalDriver): Promise<readonly string[]> {
  const parsed = deferred()
  const timeline: string[] = []
  const subscriptions = [
    driver.onLineFeed(() => timeline.push('lineFeed')),
    driver.onWriteParsed(() => {
      timeline.push('onWriteParsed')
      parsed.resolve()
    }),
  ]
  driver.writeln('line', () => timeline.push('callback'))
  await parsed.promise
  for (const subscription of subscriptions) subscription.dispose()
  return timeline
}

async function observeDisposeWithPendingWrites(driver: TerminalDriver): Promise<readonly string[]> {
  const timeline: string[] = []
  driver.onWriteParsed(() => timeline.push('onWriteParsed'))
  driver.write('A', () => timeline.push('A'))
  driver.write('B', () => timeline.push('B'))
  driver.dispose()
  timeline.push('disposed')
  await nextTask()
  return timeline
}

async function observeListenerFailure(driver: TerminalDriver): Promise<ListenerFailureObservation> {
  let loggerErrors = 0
  let laterListeners = 0
  driver.options.logger = {
    debug() {},
    error() {
      loggerErrors += 1
    },
    info() {},
    trace() {},
    warn() {},
  }
  const errorEvent = new Promise<ErrorEvent>((resolve) => {
    window.addEventListener(
      'error',
      (event) => {
        event.preventDefault()
        resolve(event)
      },
      { once: true },
    )
  })
  driver.onData(() => {
    throw new Error('listener failed')
  })
  driver.onData(() => {
    laterListeners += 1
  })

  driver.input('data', false)
  const globalError = await errorEvent
  return {
    globalError: String(globalError.error).includes('listener failed'),
    laterListeners,
    loggerErrors,
  }
}

async function observeCanceledListener(driver: TerminalDriver): Promise<{
  readonly globalErrors: number
  readonly laterListeners: number
}> {
  let globalErrors = 0
  let laterListeners = 0
  const handleError = (event: ErrorEvent): void => {
    globalErrors += 1
    event.preventDefault()
  }
  window.addEventListener('error', handleError)
  driver.onData(() => {
    const failure = new Error('Canceled')
    failure.name = 'Canceled'
    throw failure
  })
  driver.onData(() => {
    laterListeners += 1
  })

  driver.input('data', false)
  await nextTask()
  window.removeEventListener('error', handleError)
  return { globalErrors, laterListeners }
}

async function writeComplete(driver: TerminalDriver, data: string): Promise<void> {
  await new Promise<void>((resolve) => driver.write(data, resolve))
}

async function observeVisualClear(
  driver: TerminalDriver,
  setup: string,
  selectionRow: number,
  contentRow: number,
): Promise<VisualClearObservation> {
  await writeComplete(driver, setup)
  driver.select(0, selectionRow, 5)
  const scroll: number[] = []
  let selectionChanges = 0
  const subscriptions = [
    driver.onScroll((position) => scroll.push(position)),
    driver.onSelectionChange(() => {
      selectionChanges += 1
    }),
  ]
  driver.clear()
  for (const subscription of subscriptions) subscription.dispose()
  const observation = {
    hasSelection: driver.hasSelection(),
    position: driver.getSelectionPosition(),
    selection: driver.getSelection(),
    selectionChanges,
    scroll,
  }
  driver.clearSelection()
  driver.select(0, contentRow, 5)
  return { ...observation, content: driver.getSelection() }
}

describe.sequential('released xterm Terminal facade observables', () => {
  it('maps cursorAccent and omitted fallback through the browser renderer', async () => {
    const renderer = new NoopRenderer()
    let initialOptions: WebGpuTerminalRendererOptions | undefined
    const originalCreate = WebGpuTerminalRenderer.create
    WebGpuTerminalRenderer.create = ((options: WebGpuTerminalRendererOptions) => {
      initialOptions = options
      return Promise.resolve(renderer as unknown as WebGpuTerminalRenderer)
    }) as typeof WebGpuTerminalRenderer.create
    rendererRestores.push(() => {
      WebGpuTerminalRenderer.create = originalCreate
    })
    const driver = createGhosttyDriver({
      theme: { background: '#010203', cursorAccent: '#040506' },
    })
    drivers.push(driver)
    driver.open(trackedHost())
    await driver.ready

    expect(initialOptions?.theme?.cursorText).toEqual({ b: 6, g: 5, r: 4 })
    driver.setOptions({ theme: { background: '#070809' } })
    expect(renderer.themes.at(-1)?.cursorText).toEqual({ b: 9, g: 8, r: 7 })
  })

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

  it('matches selection command notifications and vertical resize ordering', async () => {
    const observations: Array<{
      readonly columnResize: readonly string[]
      readonly commandSelectionChanges: number
      readonly hasSelectionAfterRowResize: boolean
      readonly hasSelectionDuringRowResize: boolean
      readonly rowResize: readonly string[]
    }> = []
    for (const driver of trackedDrivers({ cols: 5, rows: 3 })) {
      driver.open(trackedHost())
      await driver.ready
      await writeComplete(driver, 'A')
      const timeline: string[] = []
      let captureRowResize = false
      let hasSelectionDuringRowResize = false
      const subscriptions = [
        driver.onResize(() => {
          timeline.push('resize')
          if (captureRowResize) hasSelectionDuringRowResize = driver.hasSelection()
        }),
        driver.onSelectionChange(() => timeline.push('selection')),
      ]

      driver.clearSelection()
      driver.clearSelection()
      driver.selectAll()
      driver.selectAll()
      driver.selectLines(0, 0)
      driver.selectLines(0, 0)
      const commandSelectionChanges = timeline.filter((event) => event === 'selection').length

      driver.clearSelection()
      timeline.length = 0
      driver.resize(6, 3)
      const columnResize = [...timeline]
      driver.select(0, 0, 1)
      expect(driver.hasSelection(), driver.name).toBe(true)
      timeline.length = 0
      captureRowResize = true
      driver.resize(6, 4)
      captureRowResize = false
      observations.push({
        columnResize,
        commandSelectionChanges,
        hasSelectionAfterRowResize: driver.hasSelection(),
        hasSelectionDuringRowResize,
        rowResize: [...timeline],
      })
      for (const subscription of subscriptions) subscription.dispose()
    }

    expect(observations[0]).toEqual({
      columnResize: ['resize'],
      commandSelectionChanges: 6,
      hasSelectionAfterRowResize: false,
      hasSelectionDuringRowResize: true,
      rowResize: ['resize', 'selection'],
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

  it('keeps direct and bulk options mutable after disposal', async () => {
    const observations: Array<{ cursorBlink: boolean | undefined; fontSize: number | undefined }> =
      []
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready
      driver.dispose()

      expect(() => {
        driver.options.fontSize = 17
        driver.setOptions({ cursorBlink: true })
      }, driver.name).not.toThrow()
      observations.push({
        cursorBlink: driver.options.cursorBlink,
        fontSize: driver.options.fontSize,
      })
    }

    expect(observations[0]).toEqual({ cursorBlink: true, fontSize: 17 })
    expect(observations[1]).toEqual(observations[0])
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

  it('matches focus-report timing inside pre-ready write callbacks', async () => {
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

  it('hands custom key and wheel ownership over exactly once after renderer creation', async () => {
    const renderer = deferRendererCreation()
    const driver = createGhosttyDriver()
    drivers.push(driver)
    driver.open(trackedHost())
    await renderer.requested.promise

    const calls: string[] = []
    driver.attachCustomKeyEventHandler(() => {
      calls.push('pending:key')
      return false
    })
    driver.attachCustomWheelEventHandler(() => {
      calls.push('pending:wheel')
      return false
    })
    dispatchKey(driver.textarea!)
    dispatchWheel(wheelTarget(driver))
    expect(calls).toEqual(['pending:key', 'pending:wheel'])

    const keyFailure = new Error('pending key failed')
    const wheelFailure = new Error('pending wheel failed')
    const errors: unknown[] = []
    const handleError = (event: ErrorEvent): void => {
      errors.push(event.error)
      event.preventDefault()
    }
    driver.attachCustomKeyEventHandler(() => {
      throw keyFailure
    })
    driver.attachCustomWheelEventHandler(() => {
      throw wheelFailure
    })
    window.addEventListener('error', handleError)
    dispatchKey(driver.textarea!)
    dispatchWheel(wheelTarget(driver))
    window.removeEventListener('error', handleError)
    expect(errors).toEqual([keyFailure, wheelFailure])

    calls.length = 0
    driver.attachCustomKeyEventHandler(() => {
      calls.push('ready:key')
      return false
    })
    driver.attachCustomWheelEventHandler(() => {
      calls.push('ready:wheel')
      return false
    })
    renderer.creation.resolve(noopRenderer())
    await driver.ready
    dispatchKey(driver.textarea!)
    dispatchWheel(wheelTarget(driver))
    expect(calls).toEqual(['ready:key', 'ready:wheel'])
  })

  it('keeps pre-ready callback failures in their write task and strands the remainder', async () => {
    const renderer = deferRendererCreation()
    const driver = createGhosttyDriver()
    drivers.push(driver)
    driver.open(trackedHost())
    await renderer.requested.promise

    const failure = new Error('pre-ready callback failed')
    const errorEvent = new Promise<ErrorEvent>((resolve) => {
      window.addEventListener(
        'error',
        (event) => {
          event.preventDefault()
          resolve(event)
        },
        { once: true },
      )
    })
    let laterCallbacks = 0
    let parsedEvents = 0
    driver.onWriteParsed(() => {
      parsedEvents += 1
    })
    driver.write('A', () => {
      throw failure
    })
    driver.write('B', () => {
      laterCallbacks += 1
    })
    await nextTask()

    renderer.creation.resolve(noopRenderer())
    await driver.ready
    expect((await errorEvent).error).toBe(failure)
    expect(() => driver.resize(81, 25)).not.toThrow()
    driver.write('C', () => {
      laterCallbacks += 1
    })
    await nextTask()
    expect(laterCallbacks).toBe(0)
    expect(parsedEvents).toBe(0)
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

  it('continues after listener failures and reports them outside the terminal logger', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready

      expect(await observeListenerFailure(driver), driver.name).toEqual({
        globalError: true,
        laterListeners: 1,
        loggerErrors: 0,
      })
    }
  })

  it('suppresses globally reporting listener-thrown Canceled errors', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready

      expect(await observeCanceledListener(driver), driver.name).toEqual({
        globalErrors: 0,
        laterListeners: 1,
      })
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

  it('matches next-task write and caller-microtask ordering', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready

      expect(await observeWriteTaskOrder(driver), driver.name).toEqual([
        'returned',
        'microtask',
        'callback',
        'onWriteParsed',
      ])
    }
  })

  it('matches caller-owned Uint8Array mutation through the parse task', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready

      expect(await observeMutableBytes(driver), driver.name).toBe('C')
    }
  })

  it('matches user-input synchronous writes and ordinary deferred writes', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready

      expect(await observeUserInputWrite(driver, true), driver.name).toEqual([
        'callback',
        'onWriteParsed',
        'returned',
      ])
      expect(await observeUserInputWrite(driver, false), driver.name).toEqual([
        'returned',
        'callback',
        'onWriteParsed',
      ])
    }
  })

  it('matches nested user-input writes from onWriteParsed', async () => {
    const expected = [
      'A',
      'parsed:1:start',
      'before',
      'B',
      'parsed:2:start',
      'parsed:2:end',
      'after',
      'parsed:1:end',
    ]
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready

      expect(await observeParsedUserInputWrite(driver), driver.name).toEqual(expected)
    }
  })

  it('matches reentrant callbacks and writeln CRLF event ordering', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready

      expect(await observeReentrantWrite(driver), driver.name).toEqual(['A', 'B', 'onWriteParsed'])
      expect(await observeWriteln(driver), driver.name).toEqual([
        'lineFeed',
        'callback',
        'onWriteParsed',
      ])
    }
  })

  it('documents the accepted pending-write disposal divergence', async () => {
    const observations: Array<readonly string[]> = []
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready
      observations.push(await observeDisposeWithPendingWrites(driver))
    }

    expect(observations[0]).toEqual(['disposed', 'A', 'B'])
    expect(observations[1]).toEqual(['disposed'])
  })

  it('tears down the core before addons and propagates the newest addon failure', async () => {
    for (const driver of trackedDrivers()) {
      driver.open(trackedHost())
      await driver.ready
      const failure = new Error('newest dispose failed')
      const timeline: string[] = []
      driver.loadAddon({
        activate() {},
        dispose() {
          timeline.push('older')
        },
      })
      driver.loadAddon({
        activate() {},
        dispose() {
          timeline.push(`newest:${driver.element?.isConnected === false}`)
          throw failure
        },
      })

      expect(() => driver.dispose(), driver.name).toThrow(failure)
      expect(timeline, driver.name).toEqual(['newest:true'])
    }
  })

  it('documents the visual clear retained-row divergence', async () => {
    const observations: VisualClearObservation[] = []
    for (const driver of trackedDrivers({ cols: 5, rows: 3 })) {
      driver.open(trackedHost())
      await driver.ready
      observations.push(await observeVisualClear(driver, 'top\r\nkeep!', 1, 0))
    }

    expect(observations[0]).toEqual({
      content: 'keep!',
      hasSelection: true,
      position: { end: { x: 5, y: 1 }, start: { x: 0, y: 1 } },
      selection: '',
      selectionChanges: 0,
      scroll: [0],
    })
    expect(observations[1]).toEqual({
      content: '',
      hasSelection: false,
      position: undefined,
      selection: '',
      selectionChanges: 1,
      scroll: [0],
    })
  })

  it('documents the visual clear divergence from released xterm true no-op', async () => {
    const observations: VisualClearObservation[] = []
    for (const driver of trackedDrivers({ cols: 5, rows: 3 })) {
      driver.open(trackedHost())
      await driver.ready
      observations.push(await observeVisualClear(driver, '\u001b[2;1Hlower\u001b[1;1H', 1, 1))
    }

    expect(observations[0]).toEqual({
      content: 'lower',
      hasSelection: true,
      position: { end: { x: 5, y: 1 }, start: { x: 0, y: 1 } },
      selection: 'lower',
      selectionChanges: 0,
      scroll: [],
    })
    expect(observations[1]).toEqual({
      content: '',
      hasSelection: false,
      position: undefined,
      selection: '',
      selectionChanges: 1,
      scroll: [],
    })
  })
})
