import {
  FocusEvent,
  GhosttyResult,
  KeyAction,
  MouseAction,
  MouseButton,
  MouseEncoderOption,
  PhysicalKey,
  TerminalMode,
} from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import { requireLayout } from './memory.js'
import type { WasmAllocation } from './memory.js'
import type { GhosttyRuntime } from './runtime.js'
import type { GhosttyTerminal } from './terminal.js'

const initialOutputCapacity = 64

export interface NormalizedKeyEvent {
  action: KeyAction
  composing: boolean
  consumedModifiers: number
  key: PhysicalKey
  modifiers: number
  text: string
  unshiftedCodepoint: number
}

export interface MouseGeometry {
  cellHeight: number
  cellWidth: number
  paddingBottom: number
  paddingLeft: number
  paddingRight: number
  paddingTop: number
  screenHeight: number
  screenWidth: number
}

export interface MouseEncoderState {
  anyButtonPressed: boolean
  geometry: MouseGeometry
}

export interface NormalizedMouseEvent {
  action: MouseAction
  button: MouseButton | null
  modifiers: number
  x: number
  y: number
}

type NativeEncoder = (buffer: number, capacity: number, outLength: number) => number

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

function readEncodedBytes(
  runtime: GhosttyRuntime,
  operation: string,
  pointer: number,
  capacity: number,
  outLength: number,
): Uint8Array {
  const length = runtime.memory.view.getUint32(outLength, true)
  if (length <= capacity) {
    return Uint8Array.from(runtime.memory.bytes.subarray(pointer, pointer + length))
  }
  throw createGhosttyError(
    operation,
    `${operation} reported ${length} bytes for capacity ${capacity}`,
  )
}

function encodeNative(
  runtime: GhosttyRuntime,
  operation: string,
  encode: NativeEncoder,
): Uint8Array {
  const outLength = runtime.memory.allocate(4)
  let capacity = initialOutputCapacity
  let buffer = 0
  try {
    buffer = runtime.memory.allocate(capacity)
    const result = encode(buffer, capacity, outLength)
    if (result === GhosttyResult.Success) {
      return readEncodedBytes(runtime, operation, buffer, capacity, outLength)
    }
    if (result !== GhosttyResult.OutOfSpace) {
      assertGhosttyResult(operation, result)
    }

    const required = runtime.memory.view.getUint32(outLength, true)
    if (required === 0) {
      throw createGhosttyError(operation, `${operation} reported an empty required capacity`)
    }
    runtime.memory.free(buffer, capacity)
    buffer = 0
    capacity = required
    buffer = runtime.memory.allocate(capacity)
    assertGhosttyResult(operation, encode(buffer, capacity, outLength))
    return readEncodedBytes(runtime, operation, buffer, capacity, outLength)
  } finally {
    if (buffer !== 0) runtime.memory.free(buffer, capacity)
    runtime.memory.free(outLength, 4)
  }
}

function validateUint32(operation: string, name: string, value: number, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1
  if (Number.isInteger(value) && value >= minimum && value <= 0xffffffff) return
  throw createGhosttyError(operation, `${name} must be an integer from ${minimum} to 4294967295`)
}

export class GhosttyKeyEncoder {
  private disposed = false
  private encoderHandle = 0
  private eventHandle = 0
  private readonly runtime: GhosttyRuntime
  private readonly terminal: GhosttyTerminal
  private text: WasmAllocation = { length: 0, pointer: 0 }

  constructor(terminal: GhosttyTerminal) {
    const runtime = terminal.runtime
    this.runtime = runtime
    this.terminal = terminal
    this.eventHandle = createHandle(runtime, 'ghostty_key_event_new', (out) =>
      runtime.exports.ghostty_key_event_new(0, out),
    )
    try {
      this.encoderHandle = createHandle(runtime, 'ghostty_key_encoder_new', (out) =>
        runtime.exports.ghostty_key_encoder_new(0, out),
      )
    } catch (cause) {
      runtime.exports.ghostty_key_event_free(this.eventHandle)
      this.eventHandle = 0
      throw cause
    }
  }

  encode(event: NormalizedKeyEvent): Uint8Array {
    this.ensureActive()
    this.setText(event.text)
    const exports = this.runtime.exports
    exports.ghostty_key_event_set_action(this.eventHandle, event.action)
    exports.ghostty_key_event_set_key(this.eventHandle, event.key)
    exports.ghostty_key_event_set_mods(this.eventHandle, event.modifiers)
    exports.ghostty_key_event_set_consumed_mods(this.eventHandle, event.consumedModifiers)
    exports.ghostty_key_event_set_composing(this.eventHandle, Number(event.composing))
    exports.ghostty_key_event_set_unshifted_codepoint(this.eventHandle, event.unshiftedCodepoint)
    exports.ghostty_key_encoder_setopt_from_terminal(this.encoderHandle, this.terminal.handle)
    return encodeNative(this.runtime, 'ghostty_key_encoder_encode', (buffer, capacity, out) =>
      exports.ghostty_key_encoder_encode(
        this.encoderHandle,
        this.eventHandle,
        buffer,
        capacity,
        out,
      ),
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.runtime.exports.ghostty_key_encoder_free(this.encoderHandle)
    this.runtime.exports.ghostty_key_event_free(this.eventHandle)
    this.runtime.memory.freeBytes(this.text)
    this.encoderHandle = 0
    this.eventHandle = 0
    this.text = { length: 0, pointer: 0 }
    this.disposed = true
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw createGhosttyError('key_encoder', 'The key encoder has been disposed')
    }
    this.runtime.ensureActive()
  }

  private setText(value: string): void {
    const next = this.runtime.memory.allocateBytes(value)
    try {
      this.runtime.exports.ghostty_key_event_set_utf8(this.eventHandle, next.pointer, next.length)
    } catch (cause) {
      this.runtime.memory.freeBytes(next)
      throw cause
    }
    const previous = this.text
    this.text = next
    this.runtime.memory.freeBytes(previous)
  }
}

export class GhosttyMouseEncoder {
  private boolPointer = 0
  private disposed = false
  private encoderHandle = 0
  private eventHandle = 0
  private geometry: MouseGeometry | undefined
  private readonly geometryLayout
  private geometryPointer = 0
  private readonly positionLayout
  private positionPointer = 0
  private readonly runtime: GhosttyRuntime
  private readonly terminal: GhosttyTerminal

  constructor(terminal: GhosttyTerminal) {
    const runtime = terminal.runtime
    this.runtime = runtime
    this.terminal = terminal
    this.positionLayout = requireLayout(runtime.layouts, 'GhosttyMousePosition')
    this.geometryLayout = requireLayout(runtime.layouts, 'GhosttyMouseEncoderSize')
    try {
      this.eventHandle = createHandle(runtime, 'ghostty_mouse_event_new', (out) =>
        runtime.exports.ghostty_mouse_event_new(0, out),
      )
      this.encoderHandle = createHandle(runtime, 'ghostty_mouse_encoder_new', (out) =>
        runtime.exports.ghostty_mouse_encoder_new(0, out),
      )
      this.positionPointer = runtime.memory.allocate(this.positionLayout.size)
      this.geometryPointer = runtime.memory.allocate(this.geometryLayout.size)
      this.boolPointer = runtime.memory.allocate(1)
      this.syncFromTerminal()
    } catch (cause) {
      this.releaseCreatedResources()
      throw cause
    }
  }

  encode(event: NormalizedMouseEvent, state: MouseEncoderState): Uint8Array {
    this.ensureActive()
    const exports = this.runtime.exports
    this.setGeometry(state.geometry)
    this.setBooleanOption(MouseEncoderOption.AnyButtonPressed, state.anyButtonPressed)
    this.setBooleanOption(MouseEncoderOption.TrackLastCell, true)
    exports.ghostty_mouse_event_set_action(this.eventHandle, event.action)
    this.setButton(event.button)
    exports.ghostty_mouse_event_set_mods(this.eventHandle, event.modifiers)
    this.setPosition(event.x, event.y)
    return encodeNative(this.runtime, 'ghostty_mouse_encoder_encode', (buffer, capacity, out) =>
      exports.ghostty_mouse_encoder_encode(
        this.encoderHandle,
        this.eventHandle,
        buffer,
        capacity,
        out,
      ),
    )
  }

  syncFromTerminal(): void {
    this.ensureActive()
    this.runtime.exports.ghostty_mouse_encoder_setopt_from_terminal(
      this.encoderHandle,
      this.terminal.handle,
    )
  }

  reset(): void {
    this.ensureActive()
    this.runtime.exports.ghostty_mouse_encoder_reset(this.encoderHandle)
  }

  dispose(): void {
    if (this.disposed) return
    this.releaseCreatedResources()
    this.disposed = true
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw createGhosttyError('mouse_encoder', 'The mouse encoder has been disposed')
    }
    this.runtime.ensureActive()
  }

  private releaseCreatedResources(): void {
    const exports = this.runtime.exports
    if (this.encoderHandle !== 0) exports.ghostty_mouse_encoder_free(this.encoderHandle)
    if (this.eventHandle !== 0) exports.ghostty_mouse_event_free(this.eventHandle)
    if (this.positionPointer !== 0) {
      this.runtime.memory.free(this.positionPointer, this.positionLayout.size)
    }
    if (this.geometryPointer !== 0) {
      this.runtime.memory.free(this.geometryPointer, this.geometryLayout.size)
    }
    if (this.boolPointer !== 0) this.runtime.memory.free(this.boolPointer, 1)
    this.encoderHandle = 0
    this.eventHandle = 0
    this.positionPointer = 0
    this.geometryPointer = 0
    this.boolPointer = 0
    this.geometry = undefined
  }

  private setBooleanOption(option: MouseEncoderOption, value: boolean): void {
    this.runtime.memory.view.setUint8(this.boolPointer, Number(value))
    this.runtime.exports.ghostty_mouse_encoder_setopt(this.encoderHandle, option, this.boolPointer)
  }

  private setButton(button: MouseButton | null): void {
    if (button === null) {
      this.runtime.exports.ghostty_mouse_event_clear_button(this.eventHandle)
      return
    }
    this.runtime.exports.ghostty_mouse_event_set_button(this.eventHandle, button)
  }

  private setGeometry(geometry: MouseGeometry): void {
    const operation = 'mouse_encoder.geometry'
    validateUint32(operation, 'screenWidth', geometry.screenWidth, true)
    validateUint32(operation, 'screenHeight', geometry.screenHeight, true)
    validateUint32(operation, 'cellWidth', geometry.cellWidth, false)
    validateUint32(operation, 'cellHeight', geometry.cellHeight, false)
    validateUint32(operation, 'paddingTop', geometry.paddingTop, true)
    validateUint32(operation, 'paddingBottom', geometry.paddingBottom, true)
    validateUint32(operation, 'paddingRight', geometry.paddingRight, true)
    validateUint32(operation, 'paddingLeft', geometry.paddingLeft, true)
    // Native size updates reset motion history, even when the geometry is unchanged.
    if (this.geometryMatches(geometry)) return
    const fields = this.geometryLayout.fields
    const view = this.runtime.memory.view
    view.setUint32(this.geometryPointer + fields.size!.offset, this.geometryLayout.size, true)
    view.setUint32(this.geometryPointer + fields.screen_width!.offset, geometry.screenWidth, true)
    view.setUint32(this.geometryPointer + fields.screen_height!.offset, geometry.screenHeight, true)
    view.setUint32(this.geometryPointer + fields.cell_width!.offset, geometry.cellWidth, true)
    view.setUint32(this.geometryPointer + fields.cell_height!.offset, geometry.cellHeight, true)
    view.setUint32(this.geometryPointer + fields.padding_top!.offset, geometry.paddingTop, true)
    view.setUint32(
      this.geometryPointer + fields.padding_bottom!.offset,
      geometry.paddingBottom,
      true,
    )
    view.setUint32(this.geometryPointer + fields.padding_right!.offset, geometry.paddingRight, true)
    view.setUint32(this.geometryPointer + fields.padding_left!.offset, geometry.paddingLeft, true)
    this.runtime.exports.ghostty_mouse_encoder_setopt(
      this.encoderHandle,
      MouseEncoderOption.Size,
      this.geometryPointer,
    )
    this.geometry = { ...geometry }
  }

  private geometryMatches(geometry: MouseGeometry): boolean {
    const current = this.geometry
    if (!current) return false
    return (
      current.screenWidth === geometry.screenWidth &&
      current.screenHeight === geometry.screenHeight &&
      current.cellWidth === geometry.cellWidth &&
      current.cellHeight === geometry.cellHeight &&
      current.paddingTop === geometry.paddingTop &&
      current.paddingBottom === geometry.paddingBottom &&
      current.paddingRight === geometry.paddingRight &&
      current.paddingLeft === geometry.paddingLeft
    )
  }

  private setPosition(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw createGhosttyError('mouse_event.position', 'Mouse position must be finite')
    }
    const fields = this.positionLayout.fields
    this.runtime.memory.view.setFloat32(this.positionPointer + fields.x!.offset, x, true)
    this.runtime.memory.view.setFloat32(this.positionPointer + fields.y!.offset, y, true)
    this.runtime.exports.ghostty_mouse_event_set_position(this.eventHandle, this.positionPointer)
  }
}

export function isPasteSafe(runtime: GhosttyRuntime, value: string | Uint8Array): boolean {
  runtime.ensureActive()
  const input = runtime.memory.allocateBytes(value)
  try {
    return runtime.exports.ghostty_paste_is_safe(input.pointer, input.length) !== 0
  } finally {
    runtime.memory.freeBytes(input)
  }
}

export function encodePaste(terminal: GhosttyTerminal, value: string | Uint8Array): Uint8Array {
  const runtime = terminal.runtime
  const bracketed = terminal.isModeEnabled(TerminalMode.BracketedPaste)
  const input = runtime.memory.allocateBytes(value)
  try {
    return encodeNative(runtime, 'ghostty_paste_encode', (buffer, capacity, out) =>
      runtime.exports.ghostty_paste_encode(
        input.pointer,
        input.length,
        Number(bracketed),
        buffer,
        capacity,
        out,
      ),
    )
  } finally {
    runtime.memory.freeBytes(input)
  }
}

export function encodeFocus(terminal: GhosttyTerminal, focused: boolean): Uint8Array {
  if (!terminal.isModeEnabled(TerminalMode.FocusEvent)) return new Uint8Array()
  const runtime = terminal.runtime
  const event = focused ? FocusEvent.Gained : FocusEvent.Lost
  return encodeNative(runtime, 'ghostty_focus_encode', (buffer, capacity, out) =>
    runtime.exports.ghostty_focus_encode(event, buffer, capacity, out),
  )
}
