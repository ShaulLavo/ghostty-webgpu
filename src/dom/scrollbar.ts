import type { TerminalScrollbar } from '../core/types.js'

export interface TerminalScrollbarActions {
  scrollBy(delta: number): unknown
  scrollToBottom(): unknown
  scrollToRow(row: number): unknown
  scrollToTop(): unknown
}

export interface TerminalScrollbarClock {
  clearTimeout(handle: number): void
  setTimeout(callback: () => void, delayMs: number): number
}

export interface TerminalScrollbarControllerOptions {
  readonly actions: TerminalScrollbarActions
  readonly clock?: TerminalScrollbarClock
  readonly fadeDelayMs?: number
  readonly minThumbSize?: number
  readonly onError?: (cause: unknown, operation: string) => void
  readonly root: HTMLElement
  readonly signal?: AbortSignal
  readonly snapshot: Readonly<TerminalScrollbar>
  readonly width?: number
}

export interface TerminalScrollbarController {
  readonly element: HTMLDivElement
  readonly hasPendingTimer: boolean
  readonly snapshot: Readonly<TerminalScrollbar>
  readonly thumb: HTMLDivElement
  readonly visible: boolean
  readonly width: number
  consumeKeyDown(event: KeyboardEvent): boolean
  consumePointerDown(event: PointerEvent): boolean
  consumePointerMove(event: PointerEvent): boolean
  consumePointerUp(event: PointerEvent): boolean
  consumeWheel(event: WheelEvent): boolean
  dispose(): void
  hitTest(event: Pick<MouseEvent, 'clientX' | 'clientY' | 'target'>): boolean
  notifyActivity(): void
  setWidth(width: number): boolean
  update(snapshot: Readonly<TerminalScrollbar>): boolean
}

interface ThumbGeometry {
  readonly height: number
  readonly top: number
  readonly trackHeight: number
  readonly travel: number
}

const defaultFadeDelayMs = 1_000
const defaultMinThumbSize = 20
const defaultWidth = 12

function nonNegativeFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value >= 0) return value
  throw new RangeError(`${name} must be a finite non-negative number`)
}

function positiveFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be a finite positive number`)
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (Number.isSafeInteger(value) && value >= 0) return value
  throw new RangeError(`${name} must be a non-negative safe integer`)
}

function validateSnapshot(snapshot: Readonly<TerminalScrollbar>): Readonly<TerminalScrollbar> {
  const length = nonNegativeSafeInteger('scrollbar length', snapshot.length)
  const offset = nonNegativeSafeInteger('scrollbar offset', snapshot.offset)
  const total = nonNegativeSafeInteger('scrollbar total', snapshot.total)
  if (length > total) throw new RangeError('scrollbar length must not exceed total')
  if (offset > total - length)
    throw new RangeError('scrollbar offset must not exceed the last viewport row')
  return Object.freeze({ length, offset, total })
}

function snapshotsEqual(
  left: Readonly<TerminalScrollbar>,
  right: Readonly<TerminalScrollbar>,
): boolean {
  return left.length === right.length && left.offset === right.offset && left.total === right.total
}

function maximumOffset(snapshot: Readonly<TerminalScrollbar>): number {
  return snapshot.total - snapshot.length
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function browserClock(view: Window): TerminalScrollbarClock {
  return {
    clearTimeout: (handle) => view.clearTimeout(handle),
    setTimeout: (callback, delayMs) => view.setTimeout(callback, delayMs),
  }
}

function requireView(root: HTMLElement): Window {
  const view = root.ownerDocument.defaultView
  if (view) return view
  throw new Error('Scrollbar root must belong to a document with a window')
}

function applyTrackStyles(element: HTMLDivElement, width: number): void {
  element.style.bottom = '0'
  element.style.opacity = '0'
  element.style.position = 'absolute'
  element.style.right = '0'
  element.style.top = '0'
  element.style.touchAction = 'none'
  element.style.userSelect = 'none'
  element.style.width = `${width}px`
  element.style.zIndex = '2'
}

function applyThumbStyles(thumb: HTMLDivElement, width: number): void {
  thumb.style.background = 'currentColor'
  thumb.style.borderRadius = `${width / 2}px`
  thumb.style.opacity = '0.45'
  thumb.style.position = 'absolute'
  thumb.style.right = `${Math.max(2, width / 4)}px`
  thumb.style.width = `${Math.max(2, width / 2)}px`
}

function applyWidth(element: HTMLDivElement, thumb: HTMLDivElement, width: number): void {
  element.style.width = `${width}px`
  thumb.style.borderRadius = `${width / 2}px`
  thumb.style.right = `${Math.max(2, width / 4)}px`
  thumb.style.width = `${Math.max(2, width / 2)}px`
}

function eventInsideElement(
  element: HTMLElement,
  event: Pick<MouseEvent, 'clientX' | 'clientY' | 'target'>,
): boolean {
  const target = event.target
  if (target && 'nodeType' in Object(target) && element.contains(target as Node)) return true
  const bounds = element.getBoundingClientRect()
  return (
    event.clientX >= bounds.left &&
    event.clientX <= bounds.right &&
    event.clientY >= bounds.top &&
    event.clientY <= bounds.bottom
  )
}

function consumeEvent(event: Event): void {
  if (event.cancelable) event.preventDefault()
  event.stopPropagation()
}

function safeWheelRows(rows: number): number {
  if (Number.isNaN(rows)) return 0
  if (!Number.isFinite(rows)) return Math.sign(rows) * Number.MAX_SAFE_INTEGER
  return clamp(Math.trunc(rows), -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
}

class OwnedTerminalScrollbar implements TerminalScrollbarController {
  private disposed = false
  private dragOffset = 0
  private dragPointer?: number
  private fadeTimer?: number
  private listenerCleanup?: () => void
  private snapshotValue: Readonly<TerminalScrollbar>
  private visibleValue = false
  private wheelResidual = 0

  constructor(
    readonly element: HTMLDivElement,
    readonly thumb: HTMLDivElement,
    snapshot: Readonly<TerminalScrollbar>,
    private readonly actions: TerminalScrollbarActions,
    private readonly clock: TerminalScrollbarClock,
    private readonly fadeDelayMs: number,
    private readonly minThumbSize: number,
    private readonly onError: (cause: unknown, operation: string) => void,
    private widthValue: number,
    private readonly signal: AbortSignal | undefined,
    private readonly abortListener: () => void,
  ) {
    this.snapshotValue = snapshot
    this.renderSnapshot()
  }

  get hasPendingTimer(): boolean {
    return this.fadeTimer !== undefined
  }

  get snapshot(): Readonly<TerminalScrollbar> {
    return this.snapshotValue
  }

  get visible(): boolean {
    return this.visibleValue
  }

  get width(): number {
    return this.widthValue
  }

  consumeKeyDown(event: KeyboardEvent): boolean {
    if (this.disposed) return false
    const key = event.key
    if (key === 'ArrowUp') this.runAction('keyboard.arrow-up', () => this.actions.scrollBy(-1))
    else if (key === 'ArrowDown')
      this.runAction('keyboard.arrow-down', () => this.actions.scrollBy(1))
    else if (key === 'PageUp')
      this.runAction('keyboard.page-up', () => this.actions.scrollBy(-this.snapshotValue.length))
    else if (key === 'PageDown')
      this.runAction('keyboard.page-down', () => this.actions.scrollBy(this.snapshotValue.length))
    else if (key === 'Home') this.runAction('keyboard.home', () => this.actions.scrollToTop())
    else if (key === 'End') this.runAction('keyboard.end', () => this.actions.scrollToBottom())
    else return false
    consumeEvent(event)
    this.notifyActivity()
    return true
  }

  consumePointerDown(event: PointerEvent): boolean {
    if (this.disposed || !this.hitTest(event)) return false
    consumeEvent(event)
    this.element.focus({ preventScroll: true })
    this.notifyActivity()
    const geometry = this.readThumbGeometry()
    const localY = event.clientY - this.element.getBoundingClientRect().top
    if (localY < geometry.top || localY > geometry.top + geometry.height) {
      const delta = localY < geometry.top ? -this.snapshotValue.length : this.snapshotValue.length
      this.runAction('pointer.page', () => this.actions.scrollBy(delta))
      return true
    }
    this.dragPointer = event.pointerId
    this.dragOffset = clamp(localY - geometry.top, 0, geometry.height)
    if (this.capturePointer(event.pointerId)) {
      this.notifyActivity()
      return true
    }
    this.dragPointer = undefined
    this.dragOffset = 0
    return true
  }

  consumePointerMove(event: PointerEvent): boolean {
    if (this.disposed || this.dragPointer !== event.pointerId) return false
    consumeEvent(event)
    this.notifyActivity()
    const bounds = this.element.getBoundingClientRect()
    const geometry = this.readThumbGeometry()
    const top = clamp(event.clientY - bounds.top - this.dragOffset, 0, geometry.travel)
    const row = this.rowFromThumbTop(top, geometry.travel)
    if (!this.runAction('pointer.drag', () => this.actions.scrollToRow(row))) {
      this.finishDrag(event.pointerId)
      this.notifyActivity()
    }
    return true
  }

  consumePointerUp(event: PointerEvent): boolean {
    if (this.disposed || this.dragPointer !== event.pointerId) return false
    consumeEvent(event)
    this.finishDrag(event.pointerId)
    this.notifyActivity()
    return true
  }

  consumeWheel(event: WheelEvent): boolean {
    if (this.disposed || !this.hitTest(event)) return false
    consumeEvent(event)
    this.notifyActivity()
    const rows = this.wheelRows(event)
    this.wheelResidual = clamp(
      this.wheelResidual + rows,
      -Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    )
    const wholeRows = safeWheelRows(this.wheelResidual)
    if (wholeRows === 0) return true
    this.wheelResidual -= wholeRows
    this.runAction('wheel', () => this.actions.scrollBy(wholeRows))
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.signal?.removeEventListener('abort', this.abortListener)
    this.listenerCleanup?.()
    this.listenerCleanup = undefined
    this.clearFadeTimer()
    const dragPointer = this.dragPointer
    this.dragPointer = undefined
    this.dragOffset = 0
    if (dragPointer !== undefined) this.releasePointerCapture(dragPointer)
    this.element.remove()
  }

  hitTest(event: Pick<MouseEvent, 'clientX' | 'clientY' | 'target'>): boolean {
    if (this.disposed) return false
    return eventInsideElement(this.element, event)
  }

  notifyActivity(): void {
    if (this.disposed) return
    this.setVisible(true)
    if (!this.clearFadeTimer()) return
    if (this.dragPointer !== undefined) return
    try {
      this.fadeTimer = this.clock.setTimeout(() => {
        this.fadeTimer = undefined
        if (this.dragPointer !== undefined) return
        this.setVisible(false)
      }, this.fadeDelayMs)
    } catch (cause) {
      this.setVisible(false)
      this.reportError(cause, 'fade.schedule')
    }
  }

  setWidth(width: number): boolean {
    if (this.disposed) return false
    const next = positiveFinite('width', width)
    if (this.widthValue === next) return false
    applyWidth(this.element, this.thumb, next)
    this.widthValue = next
    this.renderSnapshot()
    return true
  }

  update(snapshot: Readonly<TerminalScrollbar>): boolean {
    if (this.disposed) return false
    const next = validateSnapshot(snapshot)
    if (snapshotsEqual(this.snapshotValue, next)) {
      this.renderSnapshot()
      return false
    }
    this.snapshotValue = next
    this.renderSnapshot()
    return true
  }

  setListenerCleanup(cleanup: () => void): void {
    if (!this.disposed) {
      this.listenerCleanup = cleanup
      return
    }
    cleanup()
  }

  readonly cancelDragForWindowBlur = (): void => {
    if (this.disposed) return
    const pointerId = this.dragPointer
    if (pointerId !== undefined) this.finishDrag(pointerId)
    this.clearFadeTimer()
    this.setVisible(false)
  }

  private runAction(operation: string, action: () => unknown): boolean {
    try {
      action()
      return true
    } catch (cause) {
      this.reportError(cause, operation)
      return false
    }
  }

  private reportError(cause: unknown, operation: string): void {
    try {
      this.onError(cause, operation)
    } catch {
      return
    }
  }

  private capturePointer(pointerId: number): boolean {
    try {
      this.element.setPointerCapture(pointerId)
      return true
    } catch (cause) {
      this.reportError(cause, 'pointer.capture')
      return false
    }
  }

  private renderSnapshot(): void {
    const snapshot = this.snapshotValue
    this.element.setAttribute('aria-valuemax', maximumOffset(snapshot).toString())
    this.element.setAttribute('aria-valuemin', '0')
    this.element.setAttribute('aria-valuenow', snapshot.offset.toString())
    this.element.setAttribute(
      'aria-valuetext',
      `Row ${snapshot.offset} of ${maximumOffset(snapshot)}`,
    )
    const geometry = this.readThumbGeometry()
    const height = `${geometry.height}px`
    const transform = `translateY(${geometry.top}px)`
    if (this.thumb.style.height !== height) this.thumb.style.height = height
    if (this.thumb.style.transform !== transform) this.thumb.style.transform = transform
  }

  private readThumbGeometry(): ThumbGeometry {
    const trackHeight = this.element.getBoundingClientRect().height
    if (trackHeight <= 0) return { height: 0, top: 0, trackHeight: 0, travel: 0 }
    const snapshot = this.snapshotValue
    const ratio = snapshot.total === 0 ? 1 : snapshot.length / snapshot.total
    const height = clamp(trackHeight * ratio, Math.min(this.minThumbSize, trackHeight), trackHeight)
    const travel = trackHeight - height
    const maximum = maximumOffset(snapshot)
    const top = maximum === 0 ? 0 : (snapshot.offset / maximum) * travel
    return { height, top, trackHeight, travel }
  }

  private rowFromThumbTop(top: number, travel: number): number {
    const maximum = maximumOffset(this.snapshotValue)
    if (travel === 0 || maximum === 0) return 0
    return clamp(Math.round((top / travel) * maximum), 0, maximum)
  }

  private wheelRows(event: WheelEvent): number {
    if (event.deltaMode === 1) return event.deltaY
    if (event.deltaMode === 2) return event.deltaY * this.snapshotValue.length
    const geometry = this.readThumbGeometry()
    const rowHeight = geometry.trackHeight / Math.max(1, this.snapshotValue.length)
    if (rowHeight <= 0) return Math.sign(event.deltaY)
    return event.deltaY / rowHeight
  }

  private setVisible(visible: boolean): void {
    if (this.visibleValue === visible) return
    this.visibleValue = visible
    this.element.style.opacity = visible ? '1' : '0'
  }

  private clearFadeTimer(): boolean {
    const handle = this.fadeTimer
    if (handle === undefined) return true
    try {
      this.clock.clearTimeout(handle)
      this.fadeTimer = undefined
      return true
    } catch (cause) {
      this.reportError(cause, 'fade.cancel')
      return false
    }
  }

  private finishDrag(pointerId: number): void {
    this.dragPointer = undefined
    this.dragOffset = 0
    this.releasePointerCapture(pointerId)
  }

  private releasePointerCapture(pointerId: number): void {
    try {
      if (!this.element.hasPointerCapture(pointerId)) return
      this.element.releasePointerCapture(pointerId)
    } catch (cause) {
      this.reportError(cause, 'pointer.release')
    }
  }
}

function installScrollbarListeners(controller: OwnedTerminalScrollbar): () => void {
  const keydown = (event: KeyboardEvent) => controller.consumeKeyDown(event)
  const pointerdown = (event: PointerEvent) => controller.consumePointerDown(event)
  const pointermove = (event: PointerEvent) => controller.consumePointerMove(event)
  const pointerup = (event: PointerEvent) => controller.consumePointerUp(event)
  const wheel = (event: WheelEvent) => controller.consumeWheel(event)
  const focus = () => controller.notifyActivity()
  const element = controller.element
  const view = element.ownerDocument.defaultView
  element.addEventListener('keydown', keydown)
  element.addEventListener('pointerdown', pointerdown)
  element.addEventListener('pointermove', pointermove)
  element.addEventListener('pointerup', pointerup)
  element.addEventListener('pointercancel', pointerup)
  element.addEventListener('lostpointercapture', pointerup)
  element.addEventListener('wheel', wheel, { passive: false })
  element.addEventListener('focus', focus)
  view?.addEventListener('blur', controller.cancelDragForWindowBlur)
  return () => {
    element.removeEventListener('keydown', keydown)
    element.removeEventListener('pointerdown', pointerdown)
    element.removeEventListener('pointermove', pointermove)
    element.removeEventListener('pointerup', pointerup)
    element.removeEventListener('pointercancel', pointerup)
    element.removeEventListener('lostpointercapture', pointerup)
    element.removeEventListener('wheel', wheel)
    element.removeEventListener('focus', focus)
    view?.removeEventListener('blur', controller.cancelDragForWindowBlur)
  }
}

export function createTerminalScrollbar(
  options: TerminalScrollbarControllerOptions,
): TerminalScrollbarController {
  const clock = options.clock ?? browserClock(requireView(options.root))
  const width = positiveFinite('width', options.width ?? defaultWidth)
  const minThumbSize = positiveFinite('minThumbSize', options.minThumbSize ?? defaultMinThumbSize)
  const fadeDelayMs = nonNegativeFinite('fadeDelayMs', options.fadeDelayMs ?? defaultFadeDelayMs)
  const snapshot = validateSnapshot(options.snapshot)
  const document = options.root.ownerDocument
  const element = document.createElement('div')
  const thumb = document.createElement('div')
  element.className = 'ghostty-webgpu-scrollbar'
  element.setAttribute('aria-label', 'Terminal scrollback')
  element.setAttribute('aria-orientation', 'vertical')
  element.setAttribute('role', 'scrollbar')
  element.tabIndex = 0
  thumb.className = 'ghostty-webgpu-scrollbar-thumb'
  applyTrackStyles(element, width)
  applyThumbStyles(thumb, width)
  element.append(thumb)
  options.root.append(element)

  let controller: OwnedTerminalScrollbar
  const abortListener = () => controller.dispose()
  controller = new OwnedTerminalScrollbar(
    element,
    thumb,
    snapshot,
    options.actions,
    clock,
    fadeDelayMs,
    minThumbSize,
    options.onError ?? (() => {}),
    width,
    options.signal,
    abortListener,
  )
  controller.setListenerCleanup(installScrollbarListeners(controller))
  options.signal?.addEventListener('abort', abortListener, { once: true })
  if (options.signal?.aborted) controller.dispose()
  return controller
}
