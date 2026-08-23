export type TerminalSelectionAutoscroll = 'down' | 'none' | 'up'

export interface TerminalSelectionPoint {
  readonly x: number
  readonly y: number
}

export interface TerminalSelectionProjection {
  readonly geometry: {
    readonly cellWidth: number
    readonly columns: number
    readonly paddingLeft: number
    readonly screenHeight: number
  }
  readonly position: TerminalSelectionPoint
  readonly viewport: TerminalSelectionPoint
}

export interface TerminalSelectionUpdate {
  readonly autoscroll: TerminalSelectionAutoscroll
  readonly selectionChanged: boolean
  readonly selectionInstalled: boolean
}

export interface TerminalSelectionRelease {
  readonly autoscroll: TerminalSelectionAutoscroll
  readonly dragged: boolean
}

export interface TerminalSelectionSession {
  resetSelectionGesture(): void
  selectionAutoscrollTick(input: {
    readonly geometry: TerminalSelectionProjection['geometry']
    readonly position: TerminalSelectionPoint
    readonly rectangle?: boolean
    readonly viewport: TerminalSelectionPoint
  }): TerminalSelectionUpdate
  selectionDrag(input: {
    readonly geometry: TerminalSelectionProjection['geometry']
    readonly position: TerminalSelectionPoint
    readonly rectangle?: boolean
    readonly viewport: TerminalSelectionPoint
  }): TerminalSelectionUpdate
  selectionPress(input: {
    readonly position: TerminalSelectionPoint
    readonly repeatDistance: number
    readonly repeatIntervalNanoseconds: bigint
    readonly timeNanoseconds: bigint
    readonly viewport: TerminalSelectionPoint
  }): TerminalSelectionUpdate
  selectionRelease(input?: TerminalSelectionPoint): TerminalSelectionRelease
}

export interface TerminalSelectionClock {
  clearInterval(handle: number): void
  nowNanoseconds(): bigint
  setInterval(callback: () => void, milliseconds: number): number
}

export interface TerminalSelectionControllerOptions {
  readonly autoscrollIntervalMilliseconds?: number
  readonly clock?: TerminalSelectionClock
  readonly onError?: (cause: unknown, operation: string) => void
  readonly onSelectionChange?: () => void
  readonly repeatIntervalMilliseconds?: number
  readonly session: TerminalSelectionSession
  readonly view?: Window
}

export interface TerminalSelectionDragOptions {
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
  ): TerminalSelectionUpdate | undefined
  press(projection: TerminalSelectionProjection): TerminalSelectionUpdate
  release(projection?: TerminalSelectionProjection): TerminalSelectionRelease | undefined
}

interface ActiveDrag {
  readonly captured: boolean
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
    geometry: projection.geometry,
    position: projection.position,
    rectangle,
    viewport: projection.viewport,
  }
}

function outsideVerticalSurface(event: ActiveDrag['event']): boolean {
  if (event.position.y < 0) return true
  return event.position.y >= event.geometry.screenHeight
}

class NativeSelectionController implements TerminalSelectionController {
  private activeValue = false
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

  press(projection: TerminalSelectionProjection): TerminalSelectionUpdate {
    this.ensureActive()
    if (this.activeValue) this.cancel()
    const update = this.session.selectionPress({
      position: projection.position,
      repeatDistance: projection.geometry.cellWidth,
      repeatIntervalNanoseconds: this.repeatIntervalNanoseconds,
      timeNanoseconds: this.clock.nowNanoseconds(),
      viewport: projection.viewport,
    })
    this.activeValue = true
    this.lastDrag = undefined
    this.notifySelectionChange(update)
    return update
  }

  drag(
    projection: TerminalSelectionProjection,
    options: TerminalSelectionDragOptions,
  ): TerminalSelectionUpdate | undefined {
    this.ensureActive()
    if (!this.activeValue) return undefined
    const event = dragEvent(projection, options.rectangle)
    const update = this.session.selectionDrag(event)
    this.lastDrag = { captured: options.captured, event }
    this.notifySelectionChange(update)
    this.synchronizeAutoscroll(update.autoscroll)
    return update
  }

  release(projection?: TerminalSelectionProjection): TerminalSelectionRelease | undefined {
    this.ensureActive()
    if (!this.activeValue) return undefined
    this.stopAutoscroll()
    this.activeValue = false
    this.lastDrag = undefined
    return this.session.selectionRelease(projection?.viewport)
  }

  cancel(): void {
    if (this.disposed) return
    this.stopAutoscroll()
    this.lastDrag = undefined
    if (!this.activeValue) return
    this.activeValue = false
    this.session.resetSelectionGesture()
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
    try {
      const update = this.session.selectionAutoscrollTick(drag.event)
      this.notifySelectionChange(update)
      this.synchronizeAutoscroll(update.autoscroll)
    } catch (cause) {
      this.stopAutoscroll()
      this.reportError(cause, 'selection.autoscrollTick')
    }
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
    throw new Error('Terminal selection controller has been disposed')
  }
}

export function createTerminalSelectionController(
  options: TerminalSelectionControllerOptions,
): TerminalSelectionController {
  return new NativeSelectionController(options)
}
