import { afterEach, describe, expect, it } from 'vitest'
import {
  FocusEvent,
  KeyAction,
  KeyModifier,
  MouseAction,
  MouseButton,
  MouseEncoderOption,
  PhysicalKey,
} from '../abi.js'
import { assertGhosttyResult } from '../error.js'
import {
  encodeFocus as encodeTerminalFocus,
  encodePaste as encodeTerminalPaste,
  GhosttyKeyEncoder,
  GhosttyMouseEncoder,
  isPasteSafe,
} from '../input.js'
import type { MouseEncoderState, NormalizedKeyEvent, NormalizedMouseEvent } from '../input.js'
import { requireLayout } from '../memory.js'
import { GhosttyRuntime } from '../runtime.js'
import type { GhosttyTerminal } from '../terminal.js'

const requiredAbiComparison = [
  {
    header: 'key/event.h + key/encoder.h',
    exports: [
      'ghostty_key_event_new',
      'ghostty_key_event_free',
      'ghostty_key_event_set_action',
      'ghostty_key_event_set_key',
      'ghostty_key_event_set_mods',
      'ghostty_key_event_set_consumed_mods',
      'ghostty_key_event_set_composing',
      'ghostty_key_event_set_utf8',
      'ghostty_key_event_set_unshifted_codepoint',
      'ghostty_key_encoder_new',
      'ghostty_key_encoder_free',
      'ghostty_key_encoder_setopt',
      'ghostty_key_encoder_setopt_from_terminal',
      'ghostty_key_encoder_encode',
    ],
  },
  {
    header: 'mouse/event.h + mouse/encoder.h',
    exports: [
      'ghostty_mouse_event_new',
      'ghostty_mouse_event_free',
      'ghostty_mouse_event_set_action',
      'ghostty_mouse_event_set_button',
      'ghostty_mouse_event_clear_button',
      'ghostty_mouse_event_set_mods',
      'ghostty_mouse_event_set_position',
      'ghostty_mouse_encoder_new',
      'ghostty_mouse_encoder_free',
      'ghostty_mouse_encoder_setopt',
      'ghostty_mouse_encoder_setopt_from_terminal',
      'ghostty_mouse_encoder_reset',
      'ghostty_mouse_encoder_encode',
    ],
  },
  {
    header: 'paste.h + focus.h',
    exports: ['ghostty_paste_is_safe', 'ghostty_paste_encode', 'ghostty_focus_encode'],
  },
  {
    header: 'selection.h',
    exports: [
      'ghostty_selection_gesture_event_new',
      'ghostty_selection_gesture_event_free',
      'ghostty_selection_gesture_event_set',
      'ghostty_selection_gesture_new',
      'ghostty_selection_gesture_free',
      'ghostty_selection_gesture_reset',
      'ghostty_selection_gesture_event',
      'ghostty_selection_gesture_get',
      'ghostty_selection_gesture_get_multi',
      'ghostty_terminal_select_all',
      'ghostty_terminal_selection_equal',
      'ghostty_terminal_selection_format_buf',
      'ghostty_terminal_selection_ordered',
    ],
  },
  {
    header: 'grid_ref.h + point.h + terminal.h',
    exports: [
      'ghostty_terminal_grid_ref',
      'ghostty_terminal_point_from_grid_ref',
      'ghostty_grid_ref_hyperlink_uri',
      'ghostty_terminal_get',
      'ghostty_terminal_scroll_viewport',
    ],
  },
  { header: 'render.h', exports: ['ghostty_render_state_get_multi'] },
  { header: 'screen.h', exports: ['ghostty_cell_get'] },
] as const

const requiredLayouts = [
  'GhosttyClipboardContent',
  'GhosttyClipboardWrite',
  'GhosttyClipboardWriteReply',
  'GhosttyGridRef',
  'GhosttyMouseEncoderSize',
  'GhosttyMousePosition',
  'GhosttyPoint',
  'GhosttyPointCoordinate',
  'GhosttyPointValue',
  'GhosttySelection',
  'GhosttySelectionGestureBehaviors',
  'GhosttySelectionGestureGeometry',
  'GhosttySurfacePosition',
  'GhosttyTerminalModeConfig',
  'GhosttyTerminalScrollViewport',
  'GhosttyTerminalScrollbar',
  'GhosttyTerminalSelectionFormatOptions',
] as const

const decoder = new TextDecoder()
let keyEncoder: GhosttyKeyEncoder | undefined
let mouseEncoder: GhosttyMouseEncoder | undefined
let runtime: GhosttyRuntime | undefined

afterEach(() => {
  keyEncoder?.dispose()
  keyEncoder = undefined
  mouseEncoder?.dispose()
  mouseEncoder = undefined
  runtime?.dispose()
  runtime = undefined
})

function keyEvent(overrides: Partial<NormalizedKeyEvent> = {}): NormalizedKeyEvent {
  return {
    action: KeyAction.Press,
    composing: false,
    consumedModifiers: 0,
    key: PhysicalKey.A,
    modifiers: 0,
    text: 'a',
    unshiftedCodepoint: 97,
    ...overrides,
  }
}

function mouseState(overrides: Partial<MouseEncoderState> = {}): MouseEncoderState {
  return {
    anyButtonPressed: false,
    geometry: {
      cellHeight: 16,
      cellWidth: 8,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      screenHeight: 384,
      screenWidth: 640,
    },
    ...overrides,
  }
}

function mouseEvent(overrides: Partial<NormalizedMouseEvent> = {}): NormalizedMouseEvent {
  return {
    action: MouseAction.Press,
    button: MouseButton.Left,
    modifiers: 0,
    x: 0,
    y: 0,
    ...overrides,
  }
}

function createHandle(
  activeRuntime: GhosttyRuntime,
  operation: string,
  create: (out: number) => number,
): number {
  const out = activeRuntime.memory.allocateOpaque()
  try {
    assertGhosttyResult(operation, create(out))
    return activeRuntime.memory.takeOpaque(out, operation)
  } finally {
    activeRuntime.memory.freeOpaque(out)
  }
}

function encodeOutput(
  activeRuntime: GhosttyRuntime,
  operation: string,
  encode: (buffer: number, capacity: number, outLength: number) => number,
): Uint8Array {
  const capacity = 64
  const buffer = activeRuntime.memory.allocate(capacity)
  const outLength = activeRuntime.memory.allocate(4)
  try {
    assertGhosttyResult(operation, encode(buffer, capacity, outLength))
    const length = activeRuntime.memory.view.getUint32(outLength, true)
    return Uint8Array.from(activeRuntime.memory.bytes.subarray(buffer, buffer + length))
  } finally {
    activeRuntime.memory.free(outLength, 4)
    activeRuntime.memory.free(buffer, capacity)
  }
}

function encodeKey(activeRuntime: GhosttyRuntime, terminal: GhosttyTerminal): Uint8Array {
  const event = createHandle(activeRuntime, 'ghostty_key_event_new', (out) =>
    activeRuntime.exports.ghostty_key_event_new(0, out),
  )
  const encoder = createHandle(activeRuntime, 'ghostty_key_encoder_new', (out) =>
    activeRuntime.exports.ghostty_key_encoder_new(0, out),
  )
  const utf8 = activeRuntime.memory.allocateBytes('a')
  try {
    activeRuntime.exports.ghostty_key_event_set_action(event, KeyAction.Press)
    activeRuntime.exports.ghostty_key_event_set_key(event, PhysicalKey.A)
    activeRuntime.exports.ghostty_key_event_set_mods(event, 0)
    activeRuntime.exports.ghostty_key_event_set_consumed_mods(event, 0)
    activeRuntime.exports.ghostty_key_event_set_composing(event, 0)
    activeRuntime.exports.ghostty_key_event_set_utf8(event, utf8.pointer, utf8.length)
    activeRuntime.exports.ghostty_key_event_set_unshifted_codepoint(event, 97)
    activeRuntime.exports.ghostty_key_encoder_setopt_from_terminal(encoder, terminal.handle)
    return encodeOutput(activeRuntime, 'ghostty_key_encoder_encode', (buffer, length, out) =>
      activeRuntime.exports.ghostty_key_encoder_encode(encoder, event, buffer, length, out),
    )
  } finally {
    activeRuntime.memory.freeBytes(utf8)
    activeRuntime.exports.ghostty_key_encoder_free(encoder)
    activeRuntime.exports.ghostty_key_event_free(event)
  }
}

function encodeMouse(activeRuntime: GhosttyRuntime, terminal: GhosttyTerminal): Uint8Array {
  const event = createHandle(activeRuntime, 'ghostty_mouse_event_new', (out) =>
    activeRuntime.exports.ghostty_mouse_event_new(0, out),
  )
  const encoder = createHandle(activeRuntime, 'ghostty_mouse_encoder_new', (out) =>
    activeRuntime.exports.ghostty_mouse_encoder_new(0, out),
  )
  const positionLayout = requireLayout(activeRuntime.layouts, 'GhosttyMousePosition')
  const sizeLayout = requireLayout(activeRuntime.layouts, 'GhosttyMouseEncoderSize')
  const position = activeRuntime.memory.allocate(positionLayout.size)
  const size = activeRuntime.memory.allocate(sizeLayout.size)
  try {
    const sizeFields = sizeLayout.fields
    activeRuntime.memory.view.setUint32(size + sizeFields.size!.offset, sizeLayout.size, true)
    activeRuntime.memory.view.setUint32(size + sizeFields.screen_width!.offset, 640, true)
    activeRuntime.memory.view.setUint32(size + sizeFields.screen_height!.offset, 384, true)
    activeRuntime.memory.view.setUint32(size + sizeFields.cell_width!.offset, 8, true)
    activeRuntime.memory.view.setUint32(size + sizeFields.cell_height!.offset, 16, true)
    activeRuntime.memory.view.setFloat32(position + positionLayout.fields.x!.offset, 0, true)
    activeRuntime.memory.view.setFloat32(position + positionLayout.fields.y!.offset, 0, true)
    activeRuntime.exports.ghostty_mouse_event_set_action(event, MouseAction.Press)
    activeRuntime.exports.ghostty_mouse_event_set_button(event, MouseButton.Left)
    activeRuntime.exports.ghostty_mouse_event_set_mods(event, 0)
    activeRuntime.exports.ghostty_mouse_event_set_position(event, position)
    activeRuntime.exports.ghostty_mouse_encoder_setopt_from_terminal(encoder, terminal.handle)
    activeRuntime.exports.ghostty_mouse_encoder_setopt(encoder, MouseEncoderOption.Size, size)
    return encodeOutput(activeRuntime, 'ghostty_mouse_encoder_encode', (buffer, length, out) =>
      activeRuntime.exports.ghostty_mouse_encoder_encode(encoder, event, buffer, length, out),
    )
  } finally {
    activeRuntime.memory.free(size, sizeLayout.size)
    activeRuntime.memory.free(position, positionLayout.size)
    activeRuntime.exports.ghostty_mouse_encoder_free(encoder)
    activeRuntime.exports.ghostty_mouse_event_free(event)
  }
}

function encodePaste(activeRuntime: GhosttyRuntime): Uint8Array {
  const input = activeRuntime.memory.allocateBytes('a\nb')
  try {
    return encodeOutput(activeRuntime, 'ghostty_paste_encode', (buffer, length, out) =>
      activeRuntime.exports.ghostty_paste_encode(
        input.pointer,
        input.length,
        0,
        buffer,
        length,
        out,
      ),
    )
  } finally {
    activeRuntime.memory.freeBytes(input)
  }
}

function encodeFocus(activeRuntime: GhosttyRuntime): Uint8Array {
  return encodeOutput(activeRuntime, 'ghostty_focus_encode', (buffer, length, out) =>
    activeRuntime.exports.ghostty_focus_encode(FocusEvent.Gained, buffer, length, out),
  )
}

describe('pinned Ghostty ABI', () => {
  it('matches the required header export table and layouts', async () => {
    runtime = await GhosttyRuntime.create()

    for (const comparison of requiredAbiComparison) {
      expect(comparison.exports, comparison.header).not.toHaveLength(0)
      for (const name of comparison.exports) {
        expect(typeof runtime.exports[name], `${comparison.header}: ${name}`).toBe('function')
      }
    }
    for (const name of requiredLayouts) expect(requireLayout(runtime.layouts, name)).toBeDefined()
  })

  it('crosses key, mouse, paste, and focus calls through the real wasm', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 80, rows: 24 })
    terminal.write('\u001b[?1000h\u001b[?1006h')

    expect(decoder.decode(encodeKey(runtime, terminal))).toBe('a')
    expect(decoder.decode(encodeMouse(runtime, terminal))).toBe('\u001b[<0;1;1M')
    expect(decoder.decode(encodePaste(runtime))).toBe('a\rb')
    expect(decoder.decode(encodeFocus(runtime))).toBe('\u001b[I')
  })
})

describe('native input wrappers', () => {
  it('encodes legacy keys and synchronizes live terminal modes before each key', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()
    keyEncoder = new GhosttyKeyEncoder(terminal)

    expect(decoder.decode(keyEncoder.encode(keyEvent()))).toBe('a')
    expect(keyEncoder.encode(keyEvent({ composing: true }))).toEqual(new Uint8Array())
    expect(
      keyEncoder.encode(
        keyEvent({
          key: PhysicalKey.C,
          modifiers: KeyModifier.Control,
          text: 'c',
          unshiftedCodepoint: 99,
        }),
      ),
    ).toEqual(Uint8Array.of(3))

    const longText = 'x'.repeat(128)
    expect(
      decoder.decode(
        keyEncoder.encode(
          keyEvent({ key: PhysicalKey.X, text: longText, unshiftedCodepoint: 120 }),
        ),
      ),
    ).toBe(longText)

    const arrowUp = keyEvent({ key: PhysicalKey.ArrowUp, text: '', unshiftedCodepoint: 0 })
    expect(decoder.decode(keyEncoder.encode(arrowUp))).toBe('\u001b[A')
    terminal.write('\u001b[?1h')
    expect(decoder.decode(keyEncoder.encode(arrowUp))).toBe('\u001bOA')
  })

  it('encodes Kitty press, repeat, and release events', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()
    keyEncoder = new GhosttyKeyEncoder(terminal)
    terminal.write('\u001b[>11u')

    expect(decoder.decode(keyEncoder.encode(keyEvent()))).toBe('\u001b[97u')
    expect(decoder.decode(keyEncoder.encode(keyEvent({ action: KeyAction.Repeat })))).toBe(
      '\u001b[97;1:2u',
    )
    expect(decoder.decode(keyEncoder.encode(keyEvent({ action: KeyAction.Release })))).toBe(
      '\u001b[97;1:3u',
    )
  })

  it('uses explicit mouse synchronization and native SGR geometry', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()
    mouseEncoder = new GhosttyMouseEncoder(terminal)
    const state = mouseState({
      geometry: {
        ...mouseState().geometry,
        paddingLeft: 8,
        paddingTop: 16,
      },
    })
    const event = mouseEvent({ x: 8, y: 16 })

    expect(mouseEncoder.encode(event, state)).toEqual(new Uint8Array())
    terminal.write('\u001b[?1000h\u001b[?1006h')
    mouseEncoder.syncFromTerminal()
    expect(decoder.decode(mouseEncoder.encode(event, state))).toBe('\u001b[<0;1;1M')
    expect(
      decoder.decode(mouseEncoder.encode({ ...event, action: MouseAction.Release }, state)),
    ).toBe('\u001b[<0;1;1m')

    terminal.write('\u001b[?1000l')
    expect(decoder.decode(mouseEncoder.encode(event, state))).toBe('\u001b[<0;1;1M')
    mouseEncoder.syncFromTerminal()
    expect(mouseEncoder.encode(event, state)).toEqual(new Uint8Array())
  })

  it('leaves motion deduplication and write-batch resets to the native mouse encoder', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()
    terminal.write('\u001b[?1003h\u001b[?1006h')
    mouseEncoder = new GhosttyMouseEncoder(terminal)
    const state = mouseState({ anyButtonPressed: true })
    const event = mouseEvent({ action: MouseAction.Motion })

    expect(
      mouseEncoder.encode(mouseEvent({ action: MouseAction.Motion, x: 700 }), mouseState()),
    ).toEqual(new Uint8Array())
    expect(
      mouseEncoder.encode(
        mouseEvent({ action: MouseAction.Motion, x: 700 }),
        mouseState({ anyButtonPressed: true }),
      ),
    ).not.toHaveLength(0)

    expect(decoder.decode(mouseEncoder.encode(event, state))).toBe('\u001b[<32;1;1M')
    expect(mouseEncoder.encode(event, state)).toEqual(new Uint8Array())

    terminal.write('x')
    mouseEncoder.syncFromTerminal()
    mouseEncoder.syncFromTerminal()
    expect(decoder.decode(mouseEncoder.encode(event, state))).toBe('\u001b[<32;1;1M')
    expect(mouseEncoder.encode(event, state)).toEqual(new Uint8Array())
  })

  it('uses native paste safety, sanitization, mode gating, and output resizing', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()

    expect(isPasteSafe(runtime, 'safe')).toBe(true)
    expect(isPasteSafe(runtime, 'a\nb')).toBe(false)
    expect(isPasteSafe(runtime, '\u001b[201~')).toBe(false)
    expect(decoder.decode(encodeTerminalPaste(terminal, 'a\nb\0\u001b[31m\u007f'))).toBe(
      'a\rb  [31m ',
    )

    const largePaste = 'x'.repeat(128)
    expect(decoder.decode(encodeTerminalPaste(terminal, largePaste))).toBe(largePaste)
    terminal.write('\u001b[?2004h')
    expect(decoder.decode(encodeTerminalPaste(terminal, 'a\nb'))).toBe('\u001b[200~a\nb\u001b[201~')
  })

  it('gates native focus encoding on terminal mode 1004', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()

    expect(encodeTerminalFocus(terminal, true)).toEqual(new Uint8Array())
    terminal.write('\u001b[?1004h')
    expect(decoder.decode(encodeTerminalFocus(terminal, true))).toBe('\u001b[I')
    expect(decoder.decode(encodeTerminalFocus(terminal, false))).toBe('\u001b[O')
    terminal.write('\u001b[?1004l')
    expect(encodeTerminalFocus(terminal, false)).toEqual(new Uint8Array())
  })

  it('disposes owned native input resources exactly once and rejects later use', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()
    keyEncoder = new GhosttyKeyEncoder(terminal)
    mouseEncoder = new GhosttyMouseEncoder(terminal)

    keyEncoder.dispose()
    mouseEncoder.dispose()
    expect(() => keyEncoder?.dispose()).not.toThrow()
    expect(() => mouseEncoder?.dispose()).not.toThrow()
    expect(() => keyEncoder?.encode(keyEvent())).toThrow(/disposed/)
    expect(() => mouseEncoder?.encode(mouseEvent(), mouseState())).toThrow(/disposed/)
    expect(() => mouseEncoder?.syncFromTerminal()).toThrow(/disposed/)
    expect(() => mouseEncoder?.reset()).toThrow(/disposed/)
  })
})
