import { createGhosttyError } from '../core/error.js'
import type { SelectionIdentity } from '../term/selection-history.js'

type TerminalSelectionAutoscroll = 'down' | 'none' | 'up'

interface TerminalSelectionPoint {
  readonly x: number
  readonly y: number
}

export interface TerminalSelectionProjection {
  readonly client?: TerminalSelectionPoint
  readonly geometry: {
    readonly cellWidth: number
    readonly columns: number
    readonly paddingLeft: number
    readonly screenHeight: number
  }
  readonly position: TerminalSelectionPoint
  readonly viewport: TerminalSelectionPoint
}

interface TerminalSelectionUpdate {
  readonly autoscroll: TerminalSelectionAutoscroll
  readonly selectionChanged: boolean
  readonly selectionInstalled: boolean
}

interface TerminalSelectionRelease {
  readonly autoscroll: TerminalSelectionAutoscroll
  readonly dragged: boolean
}

type SelectionResult<T> = T | PromiseLike<T>

interface TerminalSelectionSession {
  resetSelectionGesture(): SelectionResult<void>
  selectionAutoscrollTick(
    input: {
      readonly geometry: TerminalSelectionProjection['geometry']
      readonly position: TerminalSelectionPoint
      readonly rectangle?: boolean
      readonly viewport: TerminalSelectionPoint
    },
    expected?: SelectionIdentity,
  ): SelectionResult<TerminalSelectionUpdate>
  selectionDrag(
    input: {
      readonly geometry: TerminalSelectionProjection['geometry']
      readonly position: TerminalSelectionPoint
      readonly rectangle?: boolean
      readonly viewport: TerminalSelectionPoint
    },
    expected?: SelectionIdentity,
  ): SelectionResult<TerminalSelectionUpdate>
  selectionPress(
    input: {
      readonly position: TerminalSelectionPoint
      readonly repeatDistance: number
      readonly repeatIntervalNanoseconds: bigint
      readonly timeNanoseconds: bigint
      readonly viewport: TerminalSelectionPoint
    },
    expected?: SelectionIdentity,
  ): SelectionResult<TerminalSelectionUpdate>
  selectionRelease(
    input?: TerminalSelectionPoint,
    expected?: SelectionIdentity,
  ): SelectionResult<TerminalSelectionRelease>
}

export interface TerminalSelectionClock {
  clearInterval(handle: number): void
  nowNanoseconds(): bigint
  setInterval(callback: () => void, milliseconds: number): number
}

export interface TerminalSelectionControllerOptions {
  readonly autoscrollIntervalMilliseconds?: number
  readonly getIdentity?: () => SelectionIdentity | undefined
  readonly getProjection?: (
    previous: TerminalSelectionProjection,
  ) => TerminalSelectionProjection | undefined
  readonly clock?: TerminalSelectionClock
  readonly onError?: (cause: unknown, operation: string) => void
  readonly onSelectionChange?: () => void
  readonly repeatIntervalMilliseconds?: number
  readonly session: TerminalSelectionSession
  readonly view?: Window
}

interface TerminalSelectionDragOptions {
  readonly captured: boolean
  readonly rectangle: boolean
}

export interface TerminalSelectionController {
  readonly active: boolean
  readonly hasPendingAutoscroll: boolean
  cancel(): void
  dispose(): void
  drag(
    projection: TerminalSelectionProjection,
    options: TerminalSelectionDragOptions,
  ): SelectionResult<TerminalSelectionUpdate> | undefined
  press(projection: TerminalSelectionProjection): SelectionResult<TerminalSelectionUpdate>
  release(
    projection?: TerminalSelectionProjection,
  ): SelectionResult<TerminalSelectionRelease> | undefined
}

interface ActiveDrag {
  readonly captured: boolean
  readonly projection: TerminalSelectionProjection
  readonly event: {
    readonly geometry: TerminalSelectionProjection['geometry']
    readonly position: TerminalSelectionPoint
    readonly rectangle: boolean
    readonly viewport: TerminalSelectionPoint
  }
}

const defaultAutoscrollIntervalMilliseconds = 50
const defaultRepeatIntervalMilliseconds = 500

function browserSelectionClock(view: Window): TerminalSelectionClock {
  return {
    clearInterval: (handle) => view.clearInterval(handle),
    nowNanoseconds: () => BigInt(Math.round(view.performance.now() * 1_000_000)),
    setInterval: (callback, milliseconds) => view.setInterval(callback, milliseconds),
  }
}

function selectionClock(options: TerminalSelectionControllerOptions): TerminalSelectionClock {
  if (options.clock) return options.clock
  if (options.view) return browserSelectionClock(options.view)
  throw new TypeError('Terminal selection requires an injected clock or owning Window')
}

function positiveMilliseconds(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be a finite positive number`)
}

function repeatIntervalNanoseconds(milliseconds: number): bigint {
  return BigInt(Math.round(milliseconds * 1_000_000))
}

function dragEvent(
  projection: TerminalSelectionProjection,
  rectangle: boolean,
): ActiveDrag['event'] {
  return {
    geometry: Object.freeze({ ...projection.geometry }),
    position: Object.freeze({ ...projection.position }),
    rectangle,
    viewport: Object.freeze({ ...projection.viewport }),
  }
}

function outsideVerticalSurface(event: ActiveDrag['event']): boolean {
  if (event.position.y < 0) return true
  return event.position.y >= event.geometry.screenHeight
}

function isPending<T>(value: SelectionResult<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

class NativeSelectionController implements TerminalSelectionController {
  private activeValue = false
  private intent = 0
  private pendingRelease: number | undefined
  private tickPending = false
  private readonly getIdentity?: TerminalSelectionControllerOptions['getIdentity']
  private readonly getProjection?: TerminalSelectionControllerOptions['getProjection']
  private readonly autoscrollIntervalMilliseconds: number
  private autoscrollTimer: number | undefined
  private readonly clock: TerminalSelectionClock
  private disposed = false
  private lastDrag: ActiveDrag | undefined
  private readonly onError?: (cause: unknown, operation: string) => void
  private readonly onSelectionChange?: () => void
  private readonly repeatIntervalNanoseconds: bigint
  private readonly session: TerminalSelectionSession

  constructor(options: TerminalSelectionControllerOptions) {
    this.session = options.session
    this.getIdentity = options.getIdentity
    this.getProjection = options.getProjection
    this.clock = selectionClock(options)
    this.onError = options.onError
    this.onSelectionChange = options.onSelectionChange
    this.autoscrollIntervalMilliseconds = positiveMilliseconds(
      'autoscrollIntervalMilliseconds',
      options.autoscrollIntervalMilliseconds ?? defaultAutoscrollIntervalMilliseconds,
    )
    const repeatMilliseconds = positiveMilliseconds(
      'repeatIntervalMilliseconds',
      options.repeatIntervalMilliseconds ?? defaultRepeatIntervalMilliseconds,
    )
    this.repeatIntervalNanoseconds = repeatIntervalNanoseconds(repeatMilliseconds)
  }

  get active(): boolean {
    return this.activeValue
  }

  get hasPendingAutoscroll(): boolean {
    return this.autoscrollTimer !== undefined
  }

  press(projection: TerminalSelectionProjection): SelectionResult<TerminalSelectionUpdate> {
    this.ensureActive()
    if (this.activeValue) this.cancel()
    this.activeValue = true
    this.pendingRelease = undefined
    this.lastDrag = undefined
    return this.update('selection.press', () =>
      this.session.selectionPress(
        {
          position: projection.position,
          repeatDistance: projection.geometry.cellWidth,
          repeatIntervalNanoseconds: this.repeatIntervalNanoseconds,
          timeNanoseconds: this.clock.nowNanoseconds(),
          viewport: projection.viewport,
        },
        this.getIdentity?.(),
      ),
    )
  }

  drag(
    projection: TerminalSelectionProjection,
    options: TerminalSelectionDragOptions,
  ): SelectionResult<TerminalSelectionUpdate> | undefined {
    this.ensureActive()
    if (!this.activeValue) return undefined
    const event = dragEvent(projection, options.rectangle)
    this.lastDrag = { captured: options.captured, event, projection }
    if (!options.captured || !outsideVerticalSurface(event)) this.stopAutoscroll()
    return this.update('selection.drag', () =>
      this.session.selectionDrag(event, this.getIdentity?.()),
    )
  }

  release(
    projection?: TerminalSelectionProjection,
  ): SelectionResult<TerminalSelectionRelease> | undefined {
    this.ensureActive()
    if (!this.activeValue) return undefined
    this.stopAutoscroll()
    this.activeValue = false
    this.lastDrag = undefined
    const intent = ++this.intent
    try {
      const result = this.session.selectionRelease(projection?.viewport, this.getIdentity?.())
      if (!isPending(result)) return result
      this.pendingRelease = intent
      const pending = Promise.resolve(result).then((release) => {
        if (this.pendingRelease === intent) this.pendingRelease = undefined
        return release
      })
      void pending.catch((cause: unknown) => {
        if (this.intent === intent) this.cancel()
        this.reportError(cause, 'selection.release')
      })
      return pending
    } catch (cause) {
      this.resetGesture()
      throw cause
    }
  }

  cancel(): void {
    if (this.disposed) return
    this.stopAutoscroll()
    this.lastDrag = undefined
    ++this.intent
    if (!this.activeValue && this.pendingRelease === undefined) return
    this.activeValue = false
    this.pendingRelease = undefined
    this.resetGesture()
  }

  private resetGesture(): void {
    try {
      this.observeFailure(this.session.resetSelectionGesture(), 'selection.reset')
    } catch (cause) {
      this.reportError(cause, 'selection.reset')
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.cancel()
    this.disposed = true
  }

  private readonly handleAutoscrollTick = (): void => {
    const drag = this.lastDrag
    if (!this.activeValue || !drag?.captured || !outsideVerticalSurface(drag.event)) {
      this.stopAutoscroll()
      return
    }
    if (this.tickPending) return
    try {
      const projection = this.getProjection ? this.getProjection(drag.projection) : drag.projection
      if (!projection) {
        this.cancel()
        return
      }
      const event = dragEvent(projection, drag.event.rectangle)
      this.lastDrag = { ...drag, event, projection }
      const result = this.observe(
        this.session.selectionAutoscrollTick(event, this.getIdentity?.()),
        ++this.intent,
        'selection.autoscrollTick',
      )
      if (!isPending(result)) return
      this.tickPending = true
      void Promise.resolve(result).then(
        () => {
          this.tickPending = false
        },
        () => {
          this.tickPending = false
        },
      )
    } catch (cause) {
      this.stopAutoscroll()
      this.reportError(cause, 'selection.autoscrollTick')
    }
  }

  private update(
    operation: string,
    invoke: () => SelectionResult<TerminalSelectionUpdate>,
  ): SelectionResult<TerminalSelectionUpdate> {
    const intent = ++this.intent
    try {
      return this.observe(invoke(), intent, operation)
    } catch (cause) {
      this.cancel()
      throw cause
    }
  }

  private observe(
    result: SelectionResult<TerminalSelectionUpdate>,
    intent: number,
    operation: string,
  ): SelectionResult<TerminalSelectionUpdate> {
    const accept = (update: TerminalSelectionUpdate): TerminalSelectionUpdate => {
      if (this.disposed || !this.activeValue || this.intent !== intent) return update
      this.notifySelectionChange(update)
      this.synchronizeAutoscroll(update.autoscroll)
      return update
    }
    if (!isPending(result)) return accept(result)
    const pending = Promise.resolve(result).then(accept)
    void pending.catch((cause: unknown) => {
      if (this.intent === intent) this.cancel()
      this.reportError(cause, operation)
    })
    return pending
  }

  private observeFailure<T>(result: SelectionResult<T>, operation: string): void {
    if (!isPending(result)) return
    void Promise.resolve(result).catch((cause: unknown) => this.reportError(cause, operation))
  }

  private synchronizeAutoscroll(direction: TerminalSelectionAutoscroll): void {
    const drag = this.lastDrag
    const shouldRun = direction !== 'none' && drag?.captured && outsideVerticalSurface(drag.event)
    if (!shouldRun) {
      this.stopAutoscroll()
      return
    }
    if (this.autoscrollTimer !== undefined) return
    this.autoscrollTimer = this.clock.setInterval(
      this.handleAutoscrollTick,
      this.autoscrollIntervalMilliseconds,
    )
  }

  private stopAutoscroll(): void {
    const timer = this.autoscrollTimer
    if (timer === undefined) return
    this.autoscrollTimer = undefined
    this.clock.clearInterval(timer)
  }

  private notifySelectionChange(update: TerminalSelectionUpdate): void {
    if (!update.selectionChanged) return
    this.onSelectionChange?.()
  }

  private reportError(cause: unknown, operation: string): void {
    try {
      this.onError?.(cause, operation)
    } catch {
      return
    }
  }

  private ensureActive(): void {
    if (!this.disposed) return
    throw createGhosttyError(
      'selection.controller',
      'Terminal selection controller has been disposed',
    )
  }
}

export function createTerminalSelectionController(
  options: TerminalSelectionControllerOptions,
): TerminalSelectionController {
  return new NativeSelectionController(options)
}
