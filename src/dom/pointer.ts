import type {
  TerminalModifiers,
  TerminalMouseAction,
  TerminalMouseButton,
  TerminalMouseGeometry,
  TerminalMouseInput,
} from '../term/types.js'
import type { TerminalSelectionController, TerminalSelectionProjection } from './selection.js'

export interface CommittedPointerLayout {
  readonly canvas: HTMLCanvasElement
  readonly grid: {
    readonly cellHeight: number
    readonly cellWidth: number
    readonly columns: number
    readonly pixelRatio: number
    readonly rows: number
  }
  readonly physical: {
    readonly deviceCellHeight: number
    readonly deviceCellWidth: number
    readonly paddingBottom: number
    readonly paddingLeft: number
    readonly paddingRight: number
    readonly paddingTop: number
    readonly screenHeight: number
    readonly screenWidth: number
  }
}

export interface RawPhysicalPointerPosition {
  readonly x: number
  readonly y: number
}

export interface TerminalPointerProjection {
  readonly mouse: {
    readonly geometry: TerminalMouseGeometry
    readonly x: number
    readonly y: number
  }
  readonly raw: RawPhysicalPointerPosition
  readonly selection: TerminalSelectionProjection
}

export interface TerminalPointerSession {
  mouse(input: TerminalMouseInput): Uint8Array
  mouseTracking(): boolean
  resetMouseTracking(): void
  scrollBy(delta: number): unknown
}

export interface TerminalPointerControllerOptions {
  readonly canvas: HTMLCanvasElement
  readonly getLayout: () => CommittedPointerLayout | undefined
  readonly onError?: (cause: unknown, operation: string) => void
  readonly selection: TerminalSelectionController
  readonly session: TerminalPointerSession
  readonly signal?: AbortSignal
}

export type TerminalPointerOwner = 'mouse' | 'none' | 'selection'

export interface TerminalPointerController {
  readonly owner: TerminalPointerOwner
  readonly pressedButtonCount: number
  readonly wheelResidual: number
  cancel(): void
  dispose(): void
}

type WheelOwner = 'mouse' | 'viewport'

const buttonByDomButton: readonly TerminalMouseButton[] = [
  'left',
  'middle',
  'right',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
]

const heldButtonPriority: readonly TerminalMouseButton[] = [
  'left',
  'right',
  'middle',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'unknown',
]

const domButtonsMask: Readonly<Partial<Record<TerminalMouseButton, number>>> = Object.freeze({
  five: 16,
  four: 8,
  left: 1,
  middle: 4,
  right: 2,
})

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function viewportCoordinate(
  position: number,
  padding: number,
  cellSize: number,
  count: number,
): number {
  return clamp(Math.floor((position - padding) / cellSize), 0, count - 1)
}

function rawPhysicalPosition(
  point: Pick<MouseEvent, 'clientX' | 'clientY'>,
  layout: CommittedPointerLayout,
): RawPhysicalPointerPosition {
  const bounds = layout.canvas.getBoundingClientRect()
  return {
    x: (point.clientX - bounds.left) * layout.grid.pixelRatio,
    y: (point.clientY - bounds.top) * layout.grid.pixelRatio,
  }
}

function mouseGeometry(layout: CommittedPointerLayout): TerminalMouseGeometry {
  const physical = layout.physical
  return {
    cellHeight: physical.deviceCellHeight,
    cellWidth: physical.deviceCellWidth,
    paddingBottom: physical.paddingBottom,
    paddingLeft: physical.paddingLeft,
    paddingRight: physical.paddingRight,
    paddingTop: physical.paddingTop,
    screenHeight: physical.screenHeight,
    screenWidth: physical.screenWidth,
  }
}

export function projectPointerPosition(
  point: Pick<MouseEvent, 'clientX' | 'clientY'>,
  layout: CommittedPointerLayout,
): TerminalPointerProjection {
  const raw = rawPhysicalPosition(point, layout)
  const physical = layout.physical
  const viewport = {
    x: viewportCoordinate(
      raw.x,
      physical.paddingLeft,
      physical.deviceCellWidth,
      layout.grid.columns,
    ),
    y: viewportCoordinate(raw.y, physical.paddingTop, physical.deviceCellHeight, layout.grid.rows),
  }
  return {
    mouse: { geometry: mouseGeometry(layout), x: raw.x, y: raw.y },
    raw,
    selection: {
      geometry: {
        cellWidth: physical.deviceCellWidth,
        columns: layout.grid.columns,
        paddingLeft: physical.paddingLeft,
        screenHeight: physical.screenHeight,
      },
      position: raw,
      viewport,
    },
  }
}

function terminalButton(button: number): TerminalMouseButton {
  return buttonByDomButton[button] ?? 'unknown'
}

function modifierState(event: MouseEvent, name: string): boolean {
  return event.getModifierState(name)
}

function terminalModifiers(event: MouseEvent): TerminalModifiers | undefined {
  const modifiers: {
    alt?: 'unknown'
    capsLock?: boolean
    control?: 'unknown'
    numLock?: boolean
    shift?: 'unknown'
    super?: 'unknown'
  } = {}
  if (event.altKey) modifiers.alt = 'unknown'
  if (event.ctrlKey) modifiers.control = 'unknown'
  if (event.shiftKey) modifiers.shift = 'unknown'
  if (event.metaKey) modifiers.super = 'unknown'
  if (modifierState(event, 'CapsLock')) modifiers.capsLock = true
  if (modifierState(event, 'NumLock')) modifiers.numLock = true
  if (Object.keys(modifiers).length === 0) return undefined
  return modifiers
}

function isMacPlatform(view: Window): boolean {
  return /Mac|iPhone|iPad/u.test(view.navigator.platform)
}

function isRectangleSelection(event: MouseEvent, view: Window): boolean {
  if (!event.altKey) return false
  if (isMacPlatform(view)) return true
  return event.ctrlKey || event.metaKey
}

function pressedInButtons(button: TerminalMouseButton, buttons: number): boolean | undefined {
  const mask = domButtonsMask[button]
  if (mask === undefined) return undefined
  return (buttons & mask) !== 0
}

function heldButton(buttons: ReadonlySet<TerminalMouseButton>): TerminalMouseButton | null {
  for (const button of heldButtonPriority) {
    if (buttons.has(button)) return button
  }
  return null
}

function wholeWheelLines(value: number): number {
  if (value < 0) return Math.ceil(value)
  return Math.floor(value)
}

function wheelLineDelta(event: WheelEvent, layout: CommittedPointerLayout): number {
  const axis = event.deltaY !== 0 ? event.deltaY : event.deltaX
  if (event.deltaMode === 1) return axis
  if (event.deltaMode === 2) return axis * layout.grid.rows
  return axis / layout.grid.cellHeight
}

function wheelLayoutSignature(layout: CommittedPointerLayout): string {
  return `${layout.grid.cellHeight}:${layout.grid.rows}`
}

class PointerRoutingController implements TerminalPointerController {
  private activePointerId: number | undefined
  private readonly canvas: HTMLCanvasElement
  private disposed = false
  private readonly getLayout: () => CommittedPointerLayout | undefined
  private lastModifiers: TerminalModifiers | undefined
  private lastProjection: TerminalPointerProjection | undefined
  private readonly onError?: (cause: unknown, operation: string) => void
  private ownerValue: TerminalPointerOwner = 'none'
  private readonly pressedButtons = new Set<TerminalMouseButton>()
  private readonly selection: TerminalSelectionController
  private readonly session: TerminalPointerSession
  private readonly signal?: AbortSignal
  private readonly view: Window
  private wheelLayout = ''
  private wheelOwner: WheelOwner | undefined
  private wheelResidualValue = 0

  constructor(options: TerminalPointerControllerOptions) {
    this.canvas = options.canvas
    const view = options.canvas.ownerDocument.defaultView
    if (!view) throw new TypeError('Terminal pointer canvas must belong to a Window')
    this.view = view
    this.getLayout = options.getLayout
    this.onError = options.onError
    this.selection = options.selection
    this.session = options.session
    this.signal = options.signal
    if (options.signal?.aborted) {
      this.disposed = true
      this.disposeSelectionSafely()
      return
    }
    this.attach()
  }

  get owner(): TerminalPointerOwner {
    return this.ownerValue
  }

  get pressedButtonCount(): number {
    return this.pressedButtons.size
  }

  get wheelResidual(): number {
    return this.wheelResidualValue
  }

  cancel(): void {
    if (this.disposed) return
    this.cancelSafely('pointer.cancel')
  }

  dispose(): void {
    if (this.disposed) return
    this.detach()
    this.cancelSafely('pointer.dispose')
    this.disposeSelectionSafely()
    this.disposed = true
  }

  private readonly handleAbort = (): void => this.dispose()

  private readonly handleBlur = (): void => this.cancel()

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return
    this.cancelSafely('pointer.lostpointercapture')
  }

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return
    this.cancelSafely('pointer.pointercancel')
  }

  private readonly handlePointerDown = (event: PointerEvent): void =>
    this.runDomHandler('pointer.pointerdown', () => this.pointerDown(event))

  private readonly handlePointerMove = (event: PointerEvent): void =>
    this.runDomHandler('pointer.pointermove', () => this.pointerMove(event))

  private readonly handlePointerUp = (event: PointerEvent): void =>
    this.runDomHandler('pointer.pointerup', () => this.pointerUp(event))

  private readonly handleWheel = (event: WheelEvent): void =>
    this.runDomHandler('pointer.wheel', () => this.wheel(event))

  private pointerDown(event: PointerEvent): void {
    const projection = this.projectionFor(event)
    if (!projection || !this.canUsePointer(event.pointerId)) return
    if (this.routesToMouse(event)) {
      this.beginMousePress(event, projection)
      event.preventDefault()
      return
    }
    if (event.button !== 0) return
    this.beginSelection(event, projection)
    event.preventDefault()
  }

  private pointerMove(event: PointerEvent): void {
    const projection = this.projectionFor(event)
    if (!projection || !this.canUsePointer(event.pointerId)) return
    if (this.ownerValue === 'mouse') {
      this.moveMouseOwner(event, projection)
      event.preventDefault()
      return
    }
    if (this.ownerValue === 'selection') {
      this.moveSelectionOwner(event, projection)
      event.preventDefault()
      return
    }
    if (!this.routesToMouse(event)) return
    this.emitMouse('motion', null, projection, terminalModifiers(event))
    event.preventDefault()
  }

  private pointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.activePointerId) return
    const projection = this.projectionFor(event)
    if (!projection) {
      this.cancel()
      return
    }
    if (this.ownerValue === 'mouse') this.releaseMouseButton(event, projection)
    if (this.ownerValue === 'selection') this.releaseSelection(projection)
    event.preventDefault()
  }

  private wheel(event: WheelEvent): void {
    const layout = this.getLayout()
    if (!layout) return
    const projection = projectPointerPosition(event, layout)
    const owner: WheelOwner = this.routesToMouse(event) ? 'mouse' : 'viewport'
    this.alignActiveOwnerForWheel(owner)
    this.prepareWheelOwner(owner, layout)
    const total = this.wheelResidualValue + wheelLineDelta(event, layout)
    const lines = wholeWheelLines(total)
    this.wheelResidualValue = total - lines
    if (lines !== 0) this.routeWheelLines(lines, owner, projection, terminalModifiers(event))
    event.preventDefault()
  }

  private attach(): void {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown)
    this.canvas.addEventListener('pointermove', this.handlePointerMove)
    this.canvas.addEventListener('pointerup', this.handlePointerUp)
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel)
    this.canvas.addEventListener('lostpointercapture', this.handleLostPointerCapture)
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false })
    this.view.addEventListener('blur', this.handleBlur)
    this.signal?.addEventListener('abort', this.handleAbort, { once: true })
  }

  private detach(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel)
    this.canvas.removeEventListener('lostpointercapture', this.handleLostPointerCapture)
    this.canvas.removeEventListener('wheel', this.handleWheel)
    this.view.removeEventListener('blur', this.handleBlur)
    this.signal?.removeEventListener('abort', this.handleAbort)
  }

  private projectionFor(event: PointerEvent): TerminalPointerProjection | undefined {
    const layout = this.getLayout()
    if (layout) {
      const projection = projectPointerPosition(event, layout)
      this.lastProjection = projection
      this.lastModifiers = terminalModifiers(event)
      return projection
    }
    if (this.ownerValue !== 'none') this.cancel()
    return undefined
  }

  private canUsePointer(pointerId: number): boolean {
    return this.activePointerId === undefined || this.activePointerId === pointerId
  }

  private routesToMouse(event: MouseEvent): boolean {
    return this.session.mouseTracking() && !event.shiftKey
  }

  private beginMousePress(event: PointerEvent, projection: TerminalPointerProjection): void {
    if (this.ownerValue === 'selection') this.endSelectionForOwnerChange()
    this.ownerValue = 'mouse'
    this.activePointerId = event.pointerId
    const button = terminalButton(event.button)
    this.pressedButtons.add(button)
    this.capture(event.pointerId)
    this.emitMouse('press', button, projection, terminalModifiers(event))
  }

  private beginSelection(event: PointerEvent, projection: TerminalPointerProjection): void {
    if (this.ownerValue === 'mouse') {
      this.endMouseForOwnerChange(projection, terminalModifiers(event))
    }
    this.ownerValue = 'selection'
    this.activePointerId = event.pointerId
    this.capture(event.pointerId)
    this.selection.press(projection.selection)
  }

  private moveMouseOwner(event: PointerEvent, projection: TerminalPointerProjection): void {
    if (!this.routesToMouse(event)) {
      this.changeMouseToSelection(event, projection)
      return
    }
    if (this.releaseMissingMouseButtons(event, projection)) return
    const modifiers = terminalModifiers(event)
    this.emitMouse('motion', heldButton(this.pressedButtons), projection, modifiers)
  }

  private moveSelectionOwner(event: PointerEvent, projection: TerminalPointerProjection): void {
    if (!pressedInButtons('left', event.buttons)) {
      this.releaseSelection(projection)
      return
    }
    if (this.routesToMouse(event)) {
      this.changeSelectionToMouse(event, projection)
      return
    }
    this.selection.drag(projection.selection, {
      captured: this.hasCapture(event.pointerId),
      rectangle: isRectangleSelection(event, this.view),
    })
  }

  private changeMouseToSelection(event: PointerEvent, projection: TerminalPointerProjection): void {
    const leftPressed =
      this.pressedButtons.has('left') || pressedInButtons('left', event.buttons) === true
    this.endMouseForOwnerChange(projection, terminalModifiers(event))
    if (!leftPressed) {
      this.finishPointer(event.pointerId)
      return
    }
    this.ownerValue = 'selection'
    this.selection.press(projection.selection)
  }

  private changeSelectionToMouse(event: PointerEvent, projection: TerminalPointerProjection): void {
    this.endSelectionForOwnerChange()
    this.ownerValue = 'mouse'
    this.pressedButtons.add('left')
    this.emitMouse('press', 'left', projection, terminalModifiers(event))
  }

  private endMouseForOwnerChange(
    projection: TerminalPointerProjection,
    modifiers: TerminalModifiers | undefined,
  ): void {
    this.synthesizeMouseReleases(projection, modifiers)
    this.session.resetMouseTracking()
    this.ownerValue = 'none'
  }

  private endSelectionForOwnerChange(): void {
    this.selection.cancel()
    this.session.resetMouseTracking()
    this.ownerValue = 'none'
  }

  private releaseMissingMouseButtons(
    event: PointerEvent,
    projection: TerminalPointerProjection,
  ): boolean {
    const missing = [...this.pressedButtons].filter(
      (button) => pressedInButtons(button, event.buttons) === false,
    )
    if (missing.length === 0) return false
    const modifiers = terminalModifiers(event)
    for (const button of missing) this.releaseTrackedButton(button, projection, modifiers)
    if (this.pressedButtons.size > 0) return false
    this.finishPointer(event.pointerId)
    return true
  }

  private releaseMouseButton(event: PointerEvent, projection: TerminalPointerProjection): void {
    const button = terminalButton(event.button)
    if (this.pressedButtons.has(button)) {
      this.releaseTrackedButton(button, projection, terminalModifiers(event))
    }
    if (this.pressedButtons.size > 0) return
    this.finishPointer(event.pointerId)
  }

  private releaseTrackedButton(
    button: TerminalMouseButton,
    projection: TerminalPointerProjection,
    modifiers: TerminalModifiers | undefined,
  ): void {
    this.pressedButtons.delete(button)
    this.emitMouse('release', button, projection, modifiers)
  }

  private releaseSelection(projection: TerminalPointerProjection): void {
    const pointerId = this.activePointerId
    this.selection.release(projection.selection)
    this.finishPointer(pointerId)
  }

  private synthesizeMouseReleases(
    projection: TerminalPointerProjection | undefined,
    modifiers: TerminalModifiers | undefined,
  ): void {
    const remaining = new Set(this.pressedButtons)
    this.pressedButtons.clear()
    if (!projection) return
    for (const button of remaining) {
      remaining.delete(button)
      this.emitMouse('release', button, projection, modifiers, remaining.size > 0)
    }
  }

  private runDomHandler(operation: string, handler: () => void): void {
    try {
      handler()
    } catch (cause) {
      this.reportError(cause, operation)
      this.cancelSafely(`${operation}.cleanup`)
    }
  }

  private cancelSafely(operation: string): void {
    const pointerId = this.activePointerId
    const projection = this.lastProjection
    const modifiers = this.lastModifiers
    this.activePointerId = undefined
    this.ownerValue = 'none'
    this.resetWheelState()
    try {
      this.synthesizeMouseReleases(projection, modifiers)
    } catch (cause) {
      this.reportError(cause, `${operation}.mouseRelease`)
    }
    try {
      this.selection.cancel()
    } catch (cause) {
      this.reportError(cause, `${operation}.selectionReset`)
    }
    try {
      this.session.resetMouseTracking()
    } catch (cause) {
      this.reportError(cause, `${operation}.mouseReset`)
    }
    this.releaseCapture(pointerId)
  }

  private disposeSelectionSafely(): void {
    try {
      this.selection.dispose()
    } catch (cause) {
      this.reportError(cause, 'pointer.dispose.selection')
    }
  }

  private reportError(cause: unknown, operation: string): void {
    try {
      this.onError?.(cause, operation)
    } catch {
      return
    }
  }

  private emitMouse(
    action: TerminalMouseAction,
    button: TerminalMouseButton | null,
    projection: TerminalPointerProjection,
    modifiers: TerminalModifiers | undefined,
    anyButtonPressed = this.pressedButtons.size > 0,
  ): void {
    this.session.mouse({
      event: {
        action,
        button,
        modifiers,
        x: projection.mouse.x,
        y: projection.mouse.y,
      },
      state: { anyButtonPressed, geometry: projection.mouse.geometry },
    })
  }

  private prepareWheelOwner(owner: WheelOwner, layout: CommittedPointerLayout): void {
    const signature = wheelLayoutSignature(layout)
    if (this.wheelLayout !== signature) {
      this.wheelLayout = signature
      this.wheelResidualValue = 0
    }
    if (this.wheelOwner === owner) return
    if (this.wheelOwner !== undefined) this.session.resetMouseTracking()
    this.wheelOwner = owner
    this.wheelResidualValue = 0
  }

  private alignActiveOwnerForWheel(owner: WheelOwner): void {
    if (owner === 'mouse' && this.ownerValue === 'selection') this.cancel()
    if (owner === 'viewport' && this.ownerValue === 'mouse') this.cancel()
  }

  private routeWheelLines(
    lines: number,
    owner: WheelOwner,
    projection: TerminalPointerProjection,
    modifiers: TerminalModifiers | undefined,
  ): void {
    if (owner === 'viewport') {
      this.session.scrollBy(lines)
      return
    }
    const button: TerminalMouseButton = lines < 0 ? 'four' : 'five'
    for (let index = 0; index < Math.abs(lines); index += 1) {
      this.emitMouse('press', button, projection, modifiers)
      this.emitMouse('release', button, projection, modifiers)
    }
  }

  private finishPointer(pointerId: number | undefined): void {
    this.ownerValue = 'none'
    this.activePointerId = undefined
    this.releaseCapture(pointerId)
  }

  private resetWheelState(): void {
    this.wheelLayout = ''
    this.wheelOwner = undefined
    this.wheelResidualValue = 0
  }

  private capture(pointerId: number): void {
    try {
      this.canvas.setPointerCapture(pointerId)
    } catch {
      return
    }
  }

  private hasCapture(pointerId: number): boolean {
    try {
      return this.canvas.hasPointerCapture(pointerId)
    } catch {
      return false
    }
  }

  private releaseCapture(pointerId: number | undefined): void {
    if (pointerId === undefined || !this.hasCapture(pointerId)) return
    try {
      this.canvas.releasePointerCapture(pointerId)
    } catch {
      return
    }
  }
}

export function createTerminalPointerController(
  options: TerminalPointerControllerOptions,
): TerminalPointerController {
  return new PointerRoutingController(options)
}
