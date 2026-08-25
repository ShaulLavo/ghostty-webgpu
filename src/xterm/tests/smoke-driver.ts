import type { Terminal as XtermBrowserTerminal } from '@xterm/xterm'
import type { Terminal as XtermHeadlessTerminal } from '@xterm/headless'
import type { Terminal as NativeTerminal } from '../../dom/terminal.js'
import type { TerminalSession } from '../../term/session.js'

export interface SmokeSize {
  readonly columns: number
  readonly rows: number
}

export interface EventSubscriptionObservation {
  readonly events: readonly unknown[]
  readonly operationReturns: readonly unknown[]
}

export interface WriteObservation {
  readonly returnValue: unknown
  readonly timeline: readonly string[]
}

export interface TerminalSmokeDriver {
  readonly name: string
  dispose(): void
  size(): SmokeSize
}

export interface TerminalBehaviorDriver extends TerminalSmokeDriver {
  observeDataSubscription(first: string, second: string): EventSubscriptionObservation
  observeResizeSubscription(first: SmokeSize, second: SmokeSize): EventSubscriptionObservation
  observeWrite(data: string): Promise<WriteObservation>
}

export interface DomObservation {
  readonly element: HTMLElement | undefined
  readonly textarea: HTMLTextAreaElement | undefined
}

export interface BrowserLifecycleDriver extends TerminalSmokeDriver {
  dom(): DomObservation
  open(parent: HTMLElement): Promise<void> | void
}

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolvePromise = (): void => {}
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function xtermSize(terminal: XtermHeadlessTerminal | XtermBrowserTerminal): SmokeSize {
  return { columns: terminal.cols, rows: terminal.rows }
}

function observeXtermData(
  terminal: XtermHeadlessTerminal,
  first: string,
  second: string,
): EventSubscriptionObservation {
  const events: unknown[] = []
  const subscription = terminal.onData((event) => events.push(event))
  const firstReturn = terminal.input(first)
  subscription.dispose()
  const secondReturn = terminal.input(second)
  return { events, operationReturns: [firstReturn, secondReturn] }
}

function observeXtermResize(
  terminal: XtermHeadlessTerminal,
  first: SmokeSize,
  second: SmokeSize,
): EventSubscriptionObservation {
  const events: unknown[] = []
  const subscription = terminal.onResize((event) => events.push(event))
  const firstReturn = terminal.resize(first.columns, first.rows)
  subscription.dispose()
  const secondReturn = terminal.resize(second.columns, second.rows)
  return { events, operationReturns: [firstReturn, secondReturn] }
}

async function observeXtermWrite(
  terminal: XtermHeadlessTerminal,
  data: string,
): Promise<WriteObservation> {
  const callback = deferred()
  const parsed = deferred()
  const timeline: string[] = []
  const subscription = terminal.onWriteParsed(() => {
    timeline.push('onWriteParsed')
    parsed.resolve()
  })
  const returnValue = terminal.write(data, () => {
    timeline.push('callback')
    callback.resolve()
  })
  timeline.push('returned')
  await Promise.all([callback.promise, parsed.promise])
  subscription.dispose()
  return { returnValue, timeline }
}

function sessionSize(session: TerminalSession): SmokeSize {
  const grid = session.grid
  return { columns: grid.columns, rows: grid.rows }
}

function observeSessionData(
  session: TerminalSession,
  first: string,
  second: string,
): EventSubscriptionObservation {
  const events: unknown[] = []
  const subscription = session.on('data', (event) => events.push(event))
  const firstReturn = session.sendInput(first)
  subscription.dispose()
  const secondReturn = session.sendInput(second)
  return { events, operationReturns: [firstReturn, secondReturn] }
}

function observeSessionResize(
  session: TerminalSession,
  first: SmokeSize,
  second: SmokeSize,
): EventSubscriptionObservation {
  const events: unknown[] = []
  const subscription = session.on('resize', (event) => events.push(event))
  const firstReturn = session.resize({ columns: first.columns, rows: first.rows })
  subscription.dispose()
  const secondReturn = session.resize({ columns: second.columns, rows: second.rows })
  return { events, operationReturns: [firstReturn, secondReturn] }
}

function observeSessionWrite(session: TerminalSession, data: string): WriteObservation {
  const timeline: string[] = []
  const subscription = session.on('renderRequest', () => timeline.push('renderRequest'))
  const returnValue = session.write(data)
  timeline.push('returned')
  subscription.dispose()
  return { returnValue, timeline }
}

export function createXtermBehaviorDriver(terminal: XtermHeadlessTerminal): TerminalBehaviorDriver {
  return {
    dispose: () => terminal.dispose(),
    name: '@xterm/headless@6.0.0',
    observeDataSubscription: (first, second) => observeXtermData(terminal, first, second),
    observeResizeSubscription: (first, second) => observeXtermResize(terminal, first, second),
    observeWrite: (data) => observeXtermWrite(terminal, data),
    size: () => xtermSize(terminal),
  }
}

export function createSessionBehaviorDriver(session: TerminalSession): TerminalBehaviorDriver {
  return {
    dispose: () => session.dispose(),
    name: 'TerminalSession',
    observeDataSubscription: (first, second) => observeSessionData(session, first, second),
    observeResizeSubscription: (first, second) => observeSessionResize(session, first, second),
    observeWrite: (data) => Promise.resolve(observeSessionWrite(session, data)),
    size: () => sessionSize(session),
  }
}

export function createXtermBrowserLifecycleDriver(
  terminal: XtermBrowserTerminal,
): BrowserLifecycleDriver {
  return {
    dispose: () => terminal.dispose(),
    dom: () => ({ element: terminal.element, textarea: terminal.textarea }),
    name: '@xterm/xterm@6.0.0',
    open: (parent) => terminal.open(parent),
    size: () => xtermSize(terminal),
  }
}

export function createGhosttyBrowserLifecycleDriver(
  terminal: NativeTerminal,
): BrowserLifecycleDriver {
  return {
    dispose: () => terminal.dispose(),
    dom: () => ({ element: terminal.element, textarea: terminal.textarea }),
    name: 'Terminal',
    open: (parent) => terminal.open(parent),
    size: () => ({
      columns: terminal.appearance.grid.columns,
      rows: terminal.appearance.grid.rows,
    }),
  }
}
