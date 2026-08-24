import {
  GhosttyResult,
  PointTag,
  SelectionGestureAutoscroll,
  SelectionGestureBehavior,
  SelectionGestureData,
  SelectionGestureEventOption,
  SelectionGestureEventType,
  SelectionOrder,
  TerminalData,
  TerminalOption,
} from './abi.js'
import type { AbiLayout } from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import { requireLayout } from './memory.js'
import type { GhosttyRuntime } from './runtime.js'
import type { GhosttyTerminal } from './terminal.js'
import type { TerminalSelectionFormatOptions } from './types.js'

const uint16Max = 0xffff
const uint32Max = 0xffffffff
const uint64Max = 0xffffffffffffffffn

export interface SelectionPoint {
  x: number
  y: number
}

export interface SelectionSurfacePosition {
  x: number
  y: number
}

export interface SelectionGestureGeometry {
  cellWidth: number
  columns: number
  paddingLeft: number
  screenHeight: number
}

export interface SelectionPressEvent {
  position: SelectionSurfacePosition
  repeatDistance: number
  repeatIntervalNanoseconds: bigint
  timeNanoseconds: bigint
  viewport: SelectionPoint
}

export interface SelectionDragEvent {
  geometry: SelectionGestureGeometry
  position: SelectionSurfacePosition
  rectangle?: boolean
  viewport: SelectionPoint
}

export type SelectionAutoscrollDirection = 'down' | 'none' | 'up'

export interface SelectionGestureUpdate {
  autoscroll: SelectionAutoscrollDirection
  selectionChanged: boolean
  selectionInstalled: boolean
}

export interface SelectionGestureRelease {
  autoscroll: SelectionAutoscrollDirection
  dragged: boolean
}

export interface SelectionCoordinates {
  end: SelectionPoint
  rectangle: boolean
  start: SelectionPoint
}

interface SelectionLayouts {
  behaviors: AbiLayout
  coordinate: AbiLayout
  geometry: AbiLayout
  point: AbiLayout
  pointValue: AbiLayout
  ref: AbiLayout
  selection: AbiLayout
  surfacePosition: AbiLayout
}

function fieldOffset(layout: AbiLayout, field: string): number {
  const value = layout.fields[field]
  if (value) return value.offset
  throw createGhosttyError('ghostty_type_json', `Required ABI field is missing: ${field}`)
}

function selectionLayouts(runtime: GhosttyRuntime): SelectionLayouts {
  return {
    behaviors: requireLayout(runtime.layouts, 'GhosttySelectionGestureBehaviors'),
    coordinate: requireLayout(runtime.layouts, 'GhosttyPointCoordinate'),
    geometry: requireLayout(runtime.layouts, 'GhosttySelectionGestureGeometry'),
    point: requireLayout(runtime.layouts, 'GhosttyPoint'),
    pointValue: requireLayout(runtime.layouts, 'GhosttyPointValue'),
    ref: requireLayout(runtime.layouts, 'GhosttyGridRef'),
    selection: requireLayout(runtime.layouts, 'GhosttySelection'),
    surfacePosition: requireLayout(runtime.layouts, 'GhosttySurfacePosition'),
  }
}

function createHandle(
  runtime: GhosttyRuntime,
  operation: string,
  create: (out: number) => number,
): number {
  const out = runtime.memory.allocateOpaque()
  try {
    assertGhosttyResult(operation, create(out))
    return runtime.memory.takeOpaque(out, operation)
  } finally {
    runtime.memory.freeOpaque(out)
  }
}

function validateUnsigned(
  operation: string,
  name: string,
  value: number,
  maximum: number,
  allowZero: boolean,
): number {
  const minimum = allowZero ? 0 : 1
  if (Number.isInteger(value) && value >= minimum && value <= maximum) return value
  throw createGhosttyError(operation, `${name} must be an integer from ${minimum} to ${maximum}`)
}

function validateUint64(operation: string, name: string, value: bigint): bigint {
  if (value >= 0n && value <= uint64Max) return value
  throw createGhosttyError(operation, `${name} must be an unsigned 64-bit integer`)
}

function validatePosition(position: SelectionSurfacePosition): void {
  if (Number.isFinite(position.x) && Number.isFinite(position.y)) return
  throw createGhosttyError('selection_gesture.position', 'Surface position must be finite')
}

function validateRepeatDistance(value: number): void {
  if (Number.isFinite(value) && value >= 0) return
  throw createGhosttyError(
    'selection_gesture.press',
    'repeatDistance must be a finite non-negative number',
  )
}

export class GhosttySelectionGesture {
  private behaviorsPointer = 0
  private coordinatePointer = 0
  private currentSelectionPointer = 0
  private disposed = false
  private dragEventHandle = 0
  private geometryPointer = 0
  private gestureHandle = 0
  private readonly layouts: SelectionLayouts
  private orderedSelectionPointer = 0
  private pointPointer = 0
  private positionPointer = 0
  private pressEventHandle = 0
  private refPointer = 0
  private releaseEventHandle = 0
  private readonly runtime: GhosttyRuntime
  private scalarPointer = 0
  private selectionPointer = 0
  private readonly terminal: GhosttyTerminal
  private tickEventHandle = 0

  constructor(terminal: GhosttyTerminal) {
    this.runtime = terminal.runtime
    this.terminal = terminal
    void terminal.handle
    this.layouts = selectionLayouts(this.runtime)
    try {
      this.createHandles()
      this.allocateBuffers()
      this.writeDefaultBehaviors()
    } catch (cause) {
      this.releaseCreatedResources()
      throw cause
    }
  }

  get autoscroll(): SelectionAutoscrollDirection {
    this.ensureActive()
    return this.readAutoscroll()
  }

  get dragged(): boolean {
    this.ensureActive()
    return this.readGestureBoolean(SelectionGestureData.Dragged, 'DRAGGED')
  }

  get hasSelection(): boolean {
    this.ensureActive()
    return this.terminal.hasSelection
  }

  press(event: SelectionPressEvent): SelectionGestureUpdate {
    this.ensureActive()
    validatePosition(event.position)
    validateRepeatDistance(event.repeatDistance)
    validateUint64('selection_gesture.press', 'timeNanoseconds', event.timeNanoseconds)
    validateUint64(
      'selection_gesture.press',
      'repeatIntervalNanoseconds',
      event.repeatIntervalNanoseconds,
    )

    this.setRefOption(this.pressEventHandle, event.viewport)
    this.setPositionOption(this.pressEventHandle, event.position)
    this.setFloat64Option(
      this.pressEventHandle,
      SelectionGestureEventOption.RepeatDistance,
      event.repeatDistance,
    )
    this.setUint64Option(
      this.pressEventHandle,
      SelectionGestureEventOption.TimeNanoseconds,
      event.timeNanoseconds,
    )
    this.setUint64Option(
      this.pressEventHandle,
      SelectionGestureEventOption.RepeatIntervalNanoseconds,
      event.repeatIntervalNanoseconds,
    )
    this.setEventOption(
      this.pressEventHandle,
      SelectionGestureEventOption.Behaviors,
      this.behaviorsPointer,
    )

    const selectionChanged = this.dispatchSelectionEvent(this.pressEventHandle, 'PRESS')
    if (selectionChanged !== undefined) return this.selectionUpdate(selectionChanged, true)
    const cleared = this.terminal.hasSelection
    this.terminal.clearSelection()
    return this.selectionUpdate(cleared, false)
  }

  drag(event: SelectionDragEvent): SelectionGestureUpdate {
    this.ensureActive()
    this.prepareDragEvent(this.dragEventHandle, event, true)
    const selectionChanged = this.dispatchSelectionEvent(this.dragEventHandle, 'DRAG')
    return this.selectionUpdate(selectionChanged ?? false, selectionChanged !== undefined)
  }

  autoscrollTick(event: SelectionDragEvent): SelectionGestureUpdate {
    this.ensureActive()
    this.prepareDragEvent(this.tickEventHandle, event, false)
    const selectionChanged = this.dispatchSelectionEvent(this.tickEventHandle, 'AUTOSCROLL_TICK')
    return this.selectionUpdate(selectionChanged ?? false, selectionChanged !== undefined)
  }

  release(viewport?: SelectionPoint): SelectionGestureRelease {
    this.ensureActive()
    if (viewport) this.setRefOption(this.releaseEventHandle, viewport)
    if (!viewport) {
      this.setEventOption(this.releaseEventHandle, SelectionGestureEventOption.Ref, 0)
    }

    const result = this.runtime.exports.ghostty_selection_gesture_event(
      this.gestureHandle,
      this.terminal.handle,
      this.releaseEventHandle,
      0,
    )
    if (result !== GhosttyResult.NoValue) {
      assertGhosttyResult('ghostty_selection_gesture_event(RELEASE)', result)
    }
    return { autoscroll: this.readAutoscroll(), dragged: this.dragged }
  }

  reset(): void {
    this.ensureActive()
    this.runtime.exports.ghostty_selection_gesture_reset(this.gestureHandle, this.terminal.handle)
  }

  clear(): boolean {
    this.ensureActive()
    const changed = this.terminal.hasSelection
    this.terminal.clearSelection()
    return changed
  }

  selectAll(): SelectionGestureUpdate {
    this.ensureActive()
    this.initializeSized(this.selectionPointer, this.layouts.selection)
    const result = this.runtime.exports.ghostty_terminal_select_all(
      this.terminal.handle,
      this.selectionPointer,
    )
    if (result === GhosttyResult.NoValue) return this.selectionUpdate(false, false)
    assertGhosttyResult('ghostty_terminal_select_all', result)
    return this.selectionUpdate(this.installCandidate(), true)
  }

  selectRange(start: SelectionPoint, end: SelectionPoint): SelectionGestureUpdate {
    this.ensureActive()
    this.reset()
    this.initializeSized(this.selectionPointer, this.layouts.selection)
    const startRef = this.selectionPointer + fieldOffset(this.layouts.selection, 'start')
    const endRef = this.selectionPointer + fieldOffset(this.layouts.selection, 'end')
    this.writeScreenRef(startRef, start)
    this.writeScreenRef(endRef, end)
    this.runtime.memory.view.setUint8(
      this.selectionPointer + fieldOffset(this.layouts.selection, 'rectangle'),
      0,
    )
    return this.selectionUpdate(this.installCandidate(), true)
  }

  selectLines(startRow: number, endRow: number): SelectionGestureUpdate {
    validateUnsigned('selection.selectLines', 'startRow', startRow, uint32Max, true)
    validateUnsigned('selection.selectLines', 'endRow', endRow, uint32Max, true)
    if (startRow > endRow) throw new RangeError('startRow must not exceed endRow')
    const endColumn = this.terminal.size.columns - 1
    return this.selectRange({ x: 0, y: startRow }, { x: endColumn, y: endRow })
  }

  getSelection(options: TerminalSelectionFormatOptions = {}): string | undefined {
    this.ensureActive()
    return this.terminal.getSelection(options)
  }

  coordinates(): SelectionCoordinates | undefined {
    this.ensureActive()
    this.initializeSized(this.selectionPointer, this.layouts.selection)
    const result = this.runtime.exports.ghostty_terminal_get(
      this.terminal.handle,
      TerminalData.Selection,
      this.selectionPointer,
    )
    if (result === GhosttyResult.NoValue) return undefined
    assertGhosttyResult('ghostty_terminal_get(SELECTION)', result)

    this.initializeSized(this.orderedSelectionPointer, this.layouts.selection)
    assertGhosttyResult(
      'ghostty_terminal_selection_ordered',
      this.runtime.exports.ghostty_terminal_selection_ordered(
        this.terminal.handle,
        this.selectionPointer,
        SelectionOrder.Forward,
        this.orderedSelectionPointer,
      ),
    )

    const startRef = this.orderedSelectionPointer + fieldOffset(this.layouts.selection, 'start')
    const endRef = this.orderedSelectionPointer + fieldOffset(this.layouts.selection, 'end')
    const start = this.readScreenPoint(startRef)
    if (!start) return undefined
    const end = this.readScreenPoint(endRef)
    if (!end) return undefined
    const rectangle =
      this.runtime.memory.view.getUint8(
        this.orderedSelectionPointer + fieldOffset(this.layouts.selection, 'rectangle'),
      ) !== 0
    return { end, rectangle, start }
  }

  linkAt(viewport: SelectionPoint): string | undefined {
    this.ensureActive()
    return this.terminal.linkAt({ ...viewport, tag: 'viewport' })
  }

  dispose(): void {
    if (this.disposed) return
    this.releaseCreatedResources()
    this.disposed = true
  }

  private createHandles(): void {
    this.gestureHandle = createHandle(this.runtime, 'ghostty_selection_gesture_new', (out) =>
      this.runtime.exports.ghostty_selection_gesture_new(0, out),
    )
    this.pressEventHandle = this.createEvent(SelectionGestureEventType.Press, 'PRESS')
    this.releaseEventHandle = this.createEvent(SelectionGestureEventType.Release, 'RELEASE')
    this.dragEventHandle = this.createEvent(SelectionGestureEventType.Drag, 'DRAG')
    this.tickEventHandle = this.createEvent(
      SelectionGestureEventType.AutoscrollTick,
      'AUTOSCROLL_TICK',
    )
  }

  private createEvent(type: SelectionGestureEventType, name: string): number {
    return createHandle(this.runtime, `ghostty_selection_gesture_event_new(${name})`, (out) =>
      this.runtime.exports.ghostty_selection_gesture_event_new(0, out, type),
    )
  }

  private allocateBuffers(): void {
    const memory = this.runtime.memory
    this.pointPointer = memory.allocate(this.layouts.point.size)
    this.refPointer = memory.allocate(this.layouts.ref.size)
    this.selectionPointer = memory.allocate(this.layouts.selection.size)
    this.currentSelectionPointer = memory.allocate(this.layouts.selection.size)
    this.orderedSelectionPointer = memory.allocate(this.layouts.selection.size)
    this.coordinatePointer = memory.allocate(this.layouts.coordinate.size)
    this.positionPointer = memory.allocate(this.layouts.surfacePosition.size)
    this.geometryPointer = memory.allocate(this.layouts.geometry.size)
    this.behaviorsPointer = memory.allocate(this.layouts.behaviors.size)
    this.scalarPointer = memory.allocate(8)
  }

  private writeDefaultBehaviors(): void {
    const layout = this.layouts.behaviors
    const view = this.runtime.memory.view
    view.setInt32(
      this.behaviorsPointer + fieldOffset(layout, 'single_click'),
      SelectionGestureBehavior.Cell,
      true,
    )
    view.setInt32(
      this.behaviorsPointer + fieldOffset(layout, 'double_click'),
      SelectionGestureBehavior.Word,
      true,
    )
    view.setInt32(
      this.behaviorsPointer + fieldOffset(layout, 'triple_click'),
      SelectionGestureBehavior.Line,
      true,
    )
  }

  private prepareDragEvent(eventHandle: number, event: SelectionDragEvent, useRef: boolean): void {
    validatePosition(event.position)
    this.writeGeometry(event.geometry)
    if (useRef) this.setRefOption(eventHandle, event.viewport)
    if (!useRef) this.setViewportOption(eventHandle, event.viewport)
    this.setPositionOption(eventHandle, event.position)
    this.setBooleanOption(
      eventHandle,
      SelectionGestureEventOption.Rectangle,
      event.rectangle ?? false,
    )
    this.setEventOption(eventHandle, SelectionGestureEventOption.Geometry, this.geometryPointer)
  }

  private writeGeometry(geometry: SelectionGestureGeometry): void {
    const operation = 'selection_gesture.geometry'
    validateUnsigned(operation, 'columns', geometry.columns, uint32Max, false)
    validateUnsigned(operation, 'cellWidth', geometry.cellWidth, uint32Max, false)
    validateUnsigned(operation, 'paddingLeft', geometry.paddingLeft, uint32Max, true)
    validateUnsigned(operation, 'screenHeight', geometry.screenHeight, uint32Max, false)
    const layout = this.layouts.geometry
    const view = this.runtime.memory.view
    view.setUint32(this.geometryPointer + fieldOffset(layout, 'columns'), geometry.columns, true)
    view.setUint32(
      this.geometryPointer + fieldOffset(layout, 'cell_width'),
      geometry.cellWidth,
      true,
    )
    view.setUint32(
      this.geometryPointer + fieldOffset(layout, 'padding_left'),
      geometry.paddingLeft,
      true,
    )
    view.setUint32(
      this.geometryPointer + fieldOffset(layout, 'screen_height'),
      geometry.screenHeight,
      true,
    )
  }

  private setRefOption(eventHandle: number, viewport: SelectionPoint): void {
    this.writePoint(viewport, PointTag.Viewport)
    this.initializeSized(this.refPointer, this.layouts.ref)
    assertGhosttyResult(
      'ghostty_terminal_grid_ref',
      this.runtime.exports.ghostty_terminal_grid_ref(
        this.terminal.handle,
        this.pointPointer,
        this.refPointer,
      ),
    )
    this.setEventOption(eventHandle, SelectionGestureEventOption.Ref, this.refPointer)
  }

  private writeScreenRef(pointer: number, point: SelectionPoint): void {
    this.writePoint(point, PointTag.Screen)
    this.initializeSized(pointer, this.layouts.ref)
    assertGhosttyResult(
      'ghostty_terminal_grid_ref(SCREEN)',
      this.runtime.exports.ghostty_terminal_grid_ref(
        this.terminal.handle,
        this.pointPointer,
        pointer,
      ),
    )
  }

  private setViewportOption(eventHandle: number, viewport: SelectionPoint): void {
    this.writeCoordinate(this.coordinatePointer, viewport)
    this.setEventOption(eventHandle, SelectionGestureEventOption.Viewport, this.coordinatePointer)
  }

  private setPositionOption(eventHandle: number, position: SelectionSurfacePosition): void {
    const layout = this.layouts.surfacePosition
    const view = this.runtime.memory.view
    view.setFloat64(this.positionPointer + fieldOffset(layout, 'x'), position.x, true)
    view.setFloat64(this.positionPointer + fieldOffset(layout, 'y'), position.y, true)
    this.setEventOption(eventHandle, SelectionGestureEventOption.Position, this.positionPointer)
  }

  private setFloat64Option(
    eventHandle: number,
    option: SelectionGestureEventOption,
    value: number,
  ): void {
    this.runtime.memory.view.setFloat64(this.scalarPointer, value, true)
    this.setEventOption(eventHandle, option, this.scalarPointer)
  }

  private setUint64Option(
    eventHandle: number,
    option: SelectionGestureEventOption,
    value: bigint,
  ): void {
    this.runtime.memory.view.setBigUint64(this.scalarPointer, value, true)
    this.setEventOption(eventHandle, option, this.scalarPointer)
  }

  private setBooleanOption(
    eventHandle: number,
    option: SelectionGestureEventOption,
    value: boolean,
  ): void {
    this.runtime.memory.view.setUint8(this.scalarPointer, Number(value))
    this.setEventOption(eventHandle, option, this.scalarPointer)
  }

  private setEventOption(
    eventHandle: number,
    option: SelectionGestureEventOption,
    pointer: number,
  ): void {
    assertGhosttyResult(
      'ghostty_selection_gesture_event_set',
      this.runtime.exports.ghostty_selection_gesture_event_set(eventHandle, option, pointer),
    )
  }

  private dispatchSelectionEvent(eventHandle: number, name: string): boolean | undefined {
    this.initializeSized(this.selectionPointer, this.layouts.selection)
    const result = this.runtime.exports.ghostty_selection_gesture_event(
      this.gestureHandle,
      this.terminal.handle,
      eventHandle,
      this.selectionPointer,
    )
    if (result === GhosttyResult.NoValue) return undefined
    assertGhosttyResult(`ghostty_selection_gesture_event(${name})`, result)
    return this.installCandidate()
  }

  private installCandidate(): boolean {
    const selectionChanged = !this.candidateEqualsCurrentSelection()
    assertGhosttyResult(
      'ghostty_terminal_set(SELECTION)',
      this.runtime.exports.ghostty_terminal_set(
        this.terminal.handle,
        TerminalOption.Selection,
        this.selectionPointer,
      ),
    )
    return selectionChanged
  }

  private candidateEqualsCurrentSelection(): boolean {
    this.initializeSized(this.currentSelectionPointer, this.layouts.selection)
    const currentResult = this.runtime.exports.ghostty_terminal_get(
      this.terminal.handle,
      TerminalData.Selection,
      this.currentSelectionPointer,
    )
    if (currentResult === GhosttyResult.NoValue) return false
    assertGhosttyResult('ghostty_terminal_get(SELECTION)', currentResult)
    assertGhosttyResult(
      'ghostty_terminal_selection_equal',
      this.runtime.exports.ghostty_terminal_selection_equal(
        this.terminal.handle,
        this.selectionPointer,
        this.currentSelectionPointer,
        this.scalarPointer,
      ),
    )
    return this.runtime.memory.view.getUint8(this.scalarPointer) !== 0
  }

  private writePoint(pointValue: SelectionPoint, tag: PointTag): void {
    this.validatePoint(pointValue)
    const point = this.layouts.point
    this.runtime.memory.view.setInt32(this.pointPointer + fieldOffset(point, 'tag'), tag, true)
    const coordinatePointer =
      this.pointPointer +
      fieldOffset(point, 'value') +
      fieldOffset(this.layouts.pointValue, 'coordinate')
    this.writeCoordinate(coordinatePointer, pointValue)
  }

  private writeCoordinate(pointer: number, point: SelectionPoint): void {
    this.validatePoint(point)
    const coordinate = this.layouts.coordinate
    this.runtime.memory.view.setUint16(pointer + fieldOffset(coordinate, 'x'), point.x, true)
    this.runtime.memory.view.setUint32(pointer + fieldOffset(coordinate, 'y'), point.y, true)
  }

  private validatePoint(point: SelectionPoint): void {
    validateUnsigned('selection_gesture.viewport', 'x', point.x, uint16Max, true)
    validateUnsigned('selection_gesture.viewport', 'y', point.y, uint32Max, true)
  }

  private initializeSized(pointer: number, layout: AbiLayout): void {
    this.runtime.memory.view.setUint32(pointer + fieldOffset(layout, 'size'), layout.size, true)
  }

  private readAutoscroll(): SelectionAutoscrollDirection {
    const value = this.readGestureInt32(SelectionGestureData.Autoscroll, 'AUTOSCROLL')
    if (value === SelectionGestureAutoscroll.None) return 'none'
    if (value === SelectionGestureAutoscroll.Up) return 'up'
    if (value === SelectionGestureAutoscroll.Down) return 'down'
    throw createGhosttyError(
      'ghostty_selection_gesture_get(AUTOSCROLL)',
      `Unknown autoscroll direction: ${value}`,
    )
  }

  private selectionUpdate(
    selectionChanged: boolean,
    selectionInstalled: boolean,
  ): SelectionGestureUpdate {
    return {
      autoscroll: this.readAutoscroll(),
      selectionChanged,
      selectionInstalled,
    }
  }

  private readGestureBoolean(data: SelectionGestureData, name: string): boolean {
    this.readGestureData(data, name)
    return this.runtime.memory.view.getUint8(this.scalarPointer) !== 0
  }

  private readGestureInt32(data: SelectionGestureData, name: string): number {
    this.readGestureData(data, name)
    return this.runtime.memory.view.getInt32(this.scalarPointer, true)
  }

  private readGestureData(data: SelectionGestureData, name: string): void {
    assertGhosttyResult(
      `ghostty_selection_gesture_get(${name})`,
      this.runtime.exports.ghostty_selection_gesture_get(
        this.gestureHandle,
        this.terminal.handle,
        data,
        this.scalarPointer,
      ),
    )
  }

  private readScreenPoint(refPointer: number): SelectionPoint | undefined {
    const result = this.runtime.exports.ghostty_terminal_point_from_grid_ref(
      this.terminal.handle,
      refPointer,
      PointTag.Screen,
      this.coordinatePointer,
    )
    if (result === GhosttyResult.NoValue) return undefined
    assertGhosttyResult('ghostty_terminal_point_from_grid_ref(SCREEN)', result)
    const coordinate = this.layouts.coordinate
    return {
      x: this.runtime.memory.view.getUint16(
        this.coordinatePointer + fieldOffset(coordinate, 'x'),
        true,
      ),
      y: this.runtime.memory.view.getUint32(
        this.coordinatePointer + fieldOffset(coordinate, 'y'),
        true,
      ),
    }
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw createGhosttyError('selection_gesture', 'The selection gesture has been disposed')
    }
    this.runtime.ensureActive()
    void this.terminal.handle
  }

  private releaseCreatedResources(): void {
    const exports = this.runtime.exports
    if (this.pressEventHandle !== 0) {
      exports.ghostty_selection_gesture_event_free(this.pressEventHandle)
    }
    if (this.releaseEventHandle !== 0) {
      exports.ghostty_selection_gesture_event_free(this.releaseEventHandle)
    }
    if (this.dragEventHandle !== 0) {
      exports.ghostty_selection_gesture_event_free(this.dragEventHandle)
    }
    if (this.tickEventHandle !== 0) {
      exports.ghostty_selection_gesture_event_free(this.tickEventHandle)
    }
    if (this.gestureHandle !== 0) {
      exports.ghostty_selection_gesture_free(this.gestureHandle, this.liveTerminalHandle())
    }
    this.freeBuffers()
    this.pressEventHandle = 0
    this.releaseEventHandle = 0
    this.dragEventHandle = 0
    this.tickEventHandle = 0
    this.gestureHandle = 0
  }

  private liveTerminalHandle(): number {
    try {
      return this.terminal.handle
    } catch {
      return 0
    }
  }

  private freeBuffers(): void {
    const memory = this.runtime.memory
    if (this.pointPointer !== 0) memory.free(this.pointPointer, this.layouts.point.size)
    if (this.refPointer !== 0) memory.free(this.refPointer, this.layouts.ref.size)
    if (this.selectionPointer !== 0) {
      memory.free(this.selectionPointer, this.layouts.selection.size)
    }
    if (this.currentSelectionPointer !== 0) {
      memory.free(this.currentSelectionPointer, this.layouts.selection.size)
    }
    if (this.orderedSelectionPointer !== 0) {
      memory.free(this.orderedSelectionPointer, this.layouts.selection.size)
    }
    if (this.coordinatePointer !== 0) {
      memory.free(this.coordinatePointer, this.layouts.coordinate.size)
    }
    if (this.positionPointer !== 0) {
      memory.free(this.positionPointer, this.layouts.surfacePosition.size)
    }
    if (this.geometryPointer !== 0) {
      memory.free(this.geometryPointer, this.layouts.geometry.size)
    }
    if (this.behaviorsPointer !== 0) {
      memory.free(this.behaviorsPointer, this.layouts.behaviors.size)
    }
    if (this.scalarPointer !== 0) memory.free(this.scalarPointer, 8)
    this.pointPointer = 0
    this.refPointer = 0
    this.selectionPointer = 0
    this.currentSelectionPointer = 0
    this.orderedSelectionPointer = 0
    this.coordinatePointer = 0
    this.positionPointer = 0
    this.geometryPointer = 0
    this.behaviorsPointer = 0
    this.scalarPointer = 0
  }
}
