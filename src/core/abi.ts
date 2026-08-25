export const enum GhosttyResult {
  Success = 0,
  OutOfMemory = -1,
  InvalidValue = -2,
  OutOfSpace = -3,
  NoValue = -4,
  IoError = -5,
  LimitExceeded = -6,
}

export const enum CellData {
  Wide = 3,
}

export const enum CellWide {
  Narrow = 0,
  Wide = 1,
  SpacerTail = 2,
  SpacerHead = 3,
}

export const enum KeyAction {
  Release = 0,
  Press = 1,
  Repeat = 2,
}

export const enum KeyModifier {
  Shift = 1 << 0,
  Control = 1 << 1,
  Alt = 1 << 2,
  Super = 1 << 3,
  CapsLock = 1 << 4,
  NumLock = 1 << 5,
  ShiftSide = 1 << 6,
  ControlSide = 1 << 7,
  AltSide = 1 << 8,
  SuperSide = 1 << 9,
}

export const enum PhysicalKey {
  Unidentified = 0,
  Backquote = 1,
  Backslash = 2,
  BracketLeft = 3,
  BracketRight = 4,
  Comma = 5,
  Digit0 = 6,
  Digit1 = 7,
  Digit2 = 8,
  Digit3 = 9,
  Digit4 = 10,
  Digit5 = 11,
  Digit6 = 12,
  Digit7 = 13,
  Digit8 = 14,
  Digit9 = 15,
  Equal = 16,
  IntlBackslash = 17,
  IntlRo = 18,
  IntlYen = 19,
  A = 20,
  B = 21,
  C = 22,
  D = 23,
  E = 24,
  F = 25,
  G = 26,
  H = 27,
  I = 28,
  J = 29,
  K = 30,
  L = 31,
  M = 32,
  N = 33,
  O = 34,
  P = 35,
  Q = 36,
  R = 37,
  S = 38,
  T = 39,
  U = 40,
  V = 41,
  W = 42,
  X = 43,
  Y = 44,
  Z = 45,
  Minus = 46,
  Period = 47,
  Quote = 48,
  Semicolon = 49,
  Slash = 50,
  AltLeft = 51,
  AltRight = 52,
  Backspace = 53,
  CapsLock = 54,
  ContextMenu = 55,
  ControlLeft = 56,
  ControlRight = 57,
  Enter = 58,
  MetaLeft = 59,
  MetaRight = 60,
  ShiftLeft = 61,
  ShiftRight = 62,
  Space = 63,
  Tab = 64,
  Convert = 65,
  KanaMode = 66,
  NonConvert = 67,
  Delete = 68,
  End = 69,
  Help = 70,
  Home = 71,
  Insert = 72,
  PageDown = 73,
  PageUp = 74,
  ArrowDown = 75,
  ArrowLeft = 76,
  ArrowRight = 77,
  ArrowUp = 78,
  NumLock = 79,
  Numpad0 = 80,
  Numpad1 = 81,
  Numpad2 = 82,
  Numpad3 = 83,
  Numpad4 = 84,
  Numpad5 = 85,
  Numpad6 = 86,
  Numpad7 = 87,
  Numpad8 = 88,
  Numpad9 = 89,
  NumpadAdd = 90,
  NumpadBackspace = 91,
  NumpadClear = 92,
  NumpadClearEntry = 93,
  NumpadComma = 94,
  NumpadDecimal = 95,
  NumpadDivide = 96,
  NumpadEnter = 97,
  NumpadEqual = 98,
  NumpadMemoryAdd = 99,
  NumpadMemoryClear = 100,
  NumpadMemoryRecall = 101,
  NumpadMemoryStore = 102,
  NumpadMemorySubtract = 103,
  NumpadMultiply = 104,
  NumpadParenLeft = 105,
  NumpadParenRight = 106,
  NumpadSubtract = 107,
  NumpadSeparator = 108,
  NumpadUp = 109,
  NumpadDown = 110,
  NumpadRight = 111,
  NumpadLeft = 112,
  NumpadBegin = 113,
  NumpadHome = 114,
  NumpadEnd = 115,
  NumpadInsert = 116,
  NumpadDelete = 117,
  NumpadPageUp = 118,
  NumpadPageDown = 119,
  Escape = 120,
  F1 = 121,
  F2 = 122,
  F3 = 123,
  F4 = 124,
  F5 = 125,
  F6 = 126,
  F7 = 127,
  F8 = 128,
  F9 = 129,
  F10 = 130,
  F11 = 131,
  F12 = 132,
  F13 = 133,
  F14 = 134,
  F15 = 135,
  F16 = 136,
  F17 = 137,
  F18 = 138,
  F19 = 139,
  F20 = 140,
  F21 = 141,
  F22 = 142,
  F23 = 143,
  F24 = 144,
  F25 = 145,
  Fn = 146,
  FnLock = 147,
  PrintScreen = 148,
  ScrollLock = 149,
  Pause = 150,
  BrowserBack = 151,
  BrowserFavorites = 152,
  BrowserForward = 153,
  BrowserHome = 154,
  BrowserRefresh = 155,
  BrowserSearch = 156,
  BrowserStop = 157,
  Eject = 158,
  LaunchApp1 = 159,
  LaunchApp2 = 160,
  LaunchMail = 161,
  MediaPlayPause = 162,
  MediaSelect = 163,
  MediaStop = 164,
  MediaTrackNext = 165,
  MediaTrackPrevious = 166,
  Power = 167,
  Sleep = 168,
  AudioVolumeDown = 169,
  AudioVolumeMute = 170,
  AudioVolumeUp = 171,
  WakeUp = 172,
  Copy = 173,
  Cut = 174,
  Paste = 175,
}

export const enum KeyEncoderOption {
  CursorKeyApplication = 0,
  KeypadKeyApplication = 1,
  IgnoreKeypadWithNumLock = 2,
  AltEscapePrefix = 3,
  ModifyOtherKeysState2 = 4,
  KittyFlags = 5,
  MacOsOptionAsAlt = 6,
  BackarrowKeyMode = 7,
}

export const enum OptionAsAlt {
  False = 0,
  True = 1,
  Left = 2,
  Right = 3,
}

export const enum MouseAction {
  Press = 0,
  Release = 1,
  Motion = 2,
}

export const enum MouseButton {
  Unknown = 0,
  Left = 1,
  Right = 2,
  Middle = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
  Ten = 10,
  Eleven = 11,
}

export const enum MouseTrackingMode {
  None = 0,
  X10 = 1,
  Normal = 2,
  Button = 3,
  Any = 4,
}

export const enum MouseFormat {
  X10 = 0,
  Utf8 = 1,
  Sgr = 2,
  Urxvt = 3,
  SgrPixels = 4,
}

export const enum MouseEncoderOption {
  Event = 0,
  Format = 1,
  Size = 2,
  AnyButtonPressed = 3,
  TrackLastCell = 4,
}

export const enum FocusEvent {
  Gained = 0,
  Lost = 1,
}

export const enum TerminalMode {
  Origin = 6,
  LeftRightMargin = 69,
  FocusEvent = 1004,
  BracketedPaste = 2004,
  ColorSchemeReport = 2031,
}

export const enum PointTag {
  Active = 0,
  Viewport = 1,
  Screen = 2,
  History = 3,
}

export const enum ScrollViewportTag {
  Top = 0,
  Bottom = 1,
  Delta = 2,
  Row = 3,
}

export const enum TerminalCursorStyle {
  Bar = 0,
  Block = 1,
  Underline = 2,
  BlockHollow = 3,
}

export const enum TerminalScreen {
  Primary = 0,
  Alternate = 1,
}

export const enum FormatterFormat {
  Plain = 0,
  Vt = 1,
  Html = 2,
}

export const enum SelectionOrder {
  Forward = 0,
  Reverse = 1,
  MirroredForward = 2,
  MirroredReverse = 3,
}

export const enum SelectionGestureBehavior {
  Cell = 0,
  Word = 1,
  Line = 2,
  Output = 3,
}

export const enum SelectionGestureAutoscroll {
  None = 0,
  Up = 1,
  Down = 2,
}

export const enum SelectionGestureData {
  ClickCount = 0,
  Dragged = 1,
  Autoscroll = 2,
  Behavior = 3,
  Anchor = 4,
}

export const enum SelectionGestureEventType {
  Press = 0,
  Release = 1,
  Drag = 2,
  AutoscrollTick = 3,
  DeepPress = 4,
}

export const enum SelectionGestureEventOption {
  Ref = 0,
  Position = 1,
  RepeatDistance = 2,
  TimeNanoseconds = 3,
  RepeatIntervalNanoseconds = 4,
  WordBoundaryCodepoints = 5,
  Behaviors = 6,
  Rectangle = 7,
  Geometry = 8,
  Viewport = 9,
}

export const enum ColorScheme {
  Light = 0,
  Dark = 1,
}

export const enum ClipboardLocation {
  Standard = 0,
  Selection = 1,
  Primary = 2,
}

export const enum ClipboardWriteResult {
  Success = 0,
  Denied = 1,
  Unsupported = 2,
  Busy = 3,
  InvalidData = 4,
  IoError = 5,
}

export const enum TerminalOption {
  Userdata = 0,
  WritePty = 1,
  Bell = 2,
  Enquiry = 3,
  Xtversion = 4,
  TitleChanged = 5,
  Size = 6,
  ColorScheme = 7,
  DeviceAttributes = 8,
  Title = 9,
  Pwd = 10,
  ColorForeground = 11,
  ColorBackground = 12,
  ColorCursor = 13,
  ColorPalette = 14,
  KittyImageStorageLimit = 15,
  KittyImageMediumFile = 16,
  KittyImageMediumTempFile = 17,
  KittyImageMediumSharedMemory = 18,
  ApcMaxBytes = 19,
  ApcMaxBytesKitty = 20,
  Selection = 21,
  DefaultCursorStyle = 22,
  DefaultCursorBlink = 23,
  GlyphProtocol = 24,
  PwdChanged = 25,
  ClipboardWrite = 26,
  ScrollbackMaxBytes = 27,
  ScrollbackMaxLines = 28,
  DesktopNotification = 29,
  ProgressReport = 30,
  ContinuationMaxBytes = 31,
  TitleReport = 32,
  ModeDefault = 33,
  Mode = 34,
  UnknownSequence = 35,
  UnknownMaxBytes = 36,
  TerminfoName = 37,
}

export const enum TerminalData {
  Columns = 1,
  Rows = 2,
  CursorX = 3,
  CursorY = 4,
  CursorPendingWrap = 5,
  ActiveScreen = 6,
  CursorVisible = 7,
  KittyKeyboardFlags = 8,
  Scrollbar = 9,
  CursorStyle = 10,
  MouseTracking = 11,
  Title = 12,
  Pwd = 13,
  TotalRows = 14,
  ScrollbackRows = 15,
  WidthPixels = 16,
  HeightPixels = 17,
  ColorForeground = 18,
  ColorBackground = 19,
  ColorCursor = 20,
  ColorPalette = 21,
  ColorForegroundDefault = 22,
  ColorBackgroundDefault = 23,
  ColorCursorDefault = 24,
  ColorPaletteDefault = 25,
  Selection = 31,
  ViewportActive = 32,
  VtProcessingError = 33,
  ScrollbackMaxBytes = 34,
  ScrollbackMaxLines = 35,
  ContinuationMaxBytes = 36,
  Mode = 37,
  VtGround = 38,
  CursorAtPrompt = 39,
}

export const enum RenderStateData {
  Columns = 1,
  Rows = 2,
  Dirty = 3,
  RowIterator = 4,
  ColorBackground = 5,
  ColorForeground = 6,
  ColorCursor = 7,
  ColorCursorHasValue = 8,
  ColorPalette = 9,
  CursorVisualStyle = 10,
  CursorVisible = 11,
  CursorBlinking = 12,
  CursorPasswordInput = 13,
  CursorViewportHasValue = 14,
  CursorViewportX = 15,
  CursorViewportY = 16,
  CursorViewportWideTail = 17,
  Cursor = 18,
  Colors = 19,
}

export const enum RenderStateCursorVisualStyle {
  Bar = 0,
  Block = 1,
  Underline = 2,
  BlockHollow = 3,
}

export const enum RenderStateOption {
  Dirty = 0,
}

export const enum RenderStateRowData {
  Dirty = 1,
  Raw = 2,
  Cells = 3,
  Selection = 4,
}

export const enum RenderStateRowOption {
  Dirty = 0,
}

export const enum RenderStateCellData {
  Raw = 1,
  Style = 2,
  GraphemesLength = 3,
  GraphemesBuffer = 4,
  BackgroundColor = 5,
  ForegroundColor = 6,
  Selected = 7,
  HasStyling = 8,
  GraphemesUtf8 = 9,
}

export const enum RenderStateDirty {
  False = 0,
  Partial = 1,
  Full = 2,
}

export const enum SystemOption {
  Userdata = 0,
  DecodePng = 1,
  Log = 2,
}

export interface GhosttyWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  __indirect_function_table: WebAssembly.Table
  ghostty_alloc(allocator: number, length: number): number
  ghostty_free(allocator: number, pointer: number, length: number): void
  ghostty_type_json(): number
  ghostty_wasm_alloc_opaque(): number
  ghostty_wasm_free_opaque(pointer: number): void
  ghostty_wasm_alloc(length: number): number
  ghostty_wasm_free(pointer: number, length: number): void
  ghostty_wasm_take_opaque(pointer: number): number
  ghostty_cell_get(cell: bigint, data: number, out: number): number
  ghostty_terminal_new(
    allocator: number,
    outTerminal: number,
    columns: number,
    rows: number,
  ): number
  ghostty_terminal_free(terminal: number): void
  ghostty_terminal_reset(terminal: number): void
  ghostty_terminal_resize(
    terminal: number,
    columns: number,
    rows: number,
    cellWidth: number,
    cellHeight: number,
  ): number
  ghostty_terminal_set(terminal: number, option: number, value: number): number
  ghostty_terminal_get(terminal: number, data: number, out: number): number
  ghostty_terminal_get_multi(
    terminal: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number,
  ): number
  ghostty_terminal_vt_write(terminal: number, data: number, length: number): void
  ghostty_terminal_scroll_viewport(terminal: number, viewport: number): void
  ghostty_terminal_grid_ref(terminal: number, point: number, outRef: number): number
  ghostty_terminal_point_from_grid_ref(
    terminal: number,
    ref: number,
    tag: number,
    outPoint: number,
  ): number
  ghostty_terminal_select_all(terminal: number, outSelection: number): number
  ghostty_terminal_selection_format_buf(
    terminal: number,
    options: number,
    buffer: number,
    bufferLength: number,
    outWritten: number,
  ): number
  ghostty_terminal_selection_ordered(
    terminal: number,
    selection: number,
    desiredOrder: number,
    outSelection: number,
  ): number
  ghostty_terminal_selection_equal(
    terminal: number,
    firstSelection: number,
    secondSelection: number,
    outEqual: number,
  ): number
  ghostty_grid_ref_hyperlink_uri(
    ref: number,
    buffer: number,
    bufferLength: number,
    outLength: number,
  ): number
  ghostty_key_event_new(allocator: number, outEvent: number): number
  ghostty_key_event_free(event: number): void
  ghostty_key_event_set_action(event: number, action: number): void
  ghostty_key_event_set_key(event: number, key: number): void
  ghostty_key_event_set_mods(event: number, modifiers: number): void
  ghostty_key_event_set_consumed_mods(event: number, modifiers: number): void
  ghostty_key_event_set_composing(event: number, composing: number): void
  ghostty_key_event_set_utf8(event: number, utf8: number, length: number): void
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void
  ghostty_key_encoder_new(allocator: number, outEncoder: number): number
  ghostty_key_encoder_free(encoder: number): void
  ghostty_key_encoder_setopt(encoder: number, option: number, value: number): void
  ghostty_key_encoder_setopt_from_terminal(encoder: number, terminal: number): void
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    buffer: number,
    bufferLength: number,
    outLength: number,
  ): number
  ghostty_mouse_event_new(allocator: number, outEvent: number): number
  ghostty_mouse_event_free(event: number): void
  ghostty_mouse_event_set_action(event: number, action: number): void
  ghostty_mouse_event_set_button(event: number, button: number): void
  ghostty_mouse_event_clear_button(event: number): void
  ghostty_mouse_event_set_mods(event: number, modifiers: number): void
  ghostty_mouse_event_set_position(event: number, position: number): void
  ghostty_mouse_encoder_new(allocator: number, outEncoder: number): number
  ghostty_mouse_encoder_free(encoder: number): void
  ghostty_mouse_encoder_setopt(encoder: number, option: number, value: number): void
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, terminal: number): void
  ghostty_mouse_encoder_reset(encoder: number): void
  ghostty_mouse_encoder_encode(
    encoder: number,
    event: number,
    buffer: number,
    bufferLength: number,
    outLength: number,
  ): number
  ghostty_paste_is_safe(data: number, length: number): number
  ghostty_paste_encode(
    data: number,
    dataLength: number,
    bracketed: number,
    buffer: number,
    bufferLength: number,
    outWritten: number,
  ): number
  ghostty_focus_encode(
    event: number,
    buffer: number,
    bufferLength: number,
    outWritten: number,
  ): number
  ghostty_selection_gesture_event_new(allocator: number, outEvent: number, type: number): number
  ghostty_selection_gesture_event_free(event: number): void
  ghostty_selection_gesture_event_set(event: number, option: number, value: number): number
  ghostty_selection_gesture_new(allocator: number, outGesture: number): number
  ghostty_selection_gesture_free(gesture: number, terminal: number): void
  ghostty_selection_gesture_reset(gesture: number, terminal: number): void
  ghostty_selection_gesture_event(
    gesture: number,
    terminal: number,
    event: number,
    outSelection: number,
  ): number
  ghostty_selection_gesture_get(
    gesture: number,
    terminal: number,
    data: number,
    outValue: number,
  ): number
  ghostty_selection_gesture_get_multi(
    gesture: number,
    terminal: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number,
  ): number
  ghostty_render_state_new(allocator: number, outState: number): number
  ghostty_render_state_free(state: number): void
  ghostty_render_state_update(state: number, terminal: number): number
  ghostty_render_state_get(state: number, data: number, out: number): number
  ghostty_render_state_get_multi(
    state: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number,
  ): number
  ghostty_render_state_set(state: number, option: number, value: number): number
  ghostty_render_state_row_iterator_new(allocator: number, outIterator: number): number
  ghostty_render_state_row_iterator_free(iterator: number): void
  ghostty_render_state_row_iterator_next(iterator: number): number
  ghostty_render_state_row_get(iterator: number, data: number, out: number): number
  ghostty_render_state_row_set(iterator: number, option: number, value: number): number
  ghostty_render_state_row_cells_new(allocator: number, outCells: number): number
  ghostty_render_state_row_cells_free(cells: number): void
  ghostty_render_state_row_cells_next(cells: number): number
  ghostty_render_state_row_cells_get(cells: number, data: number, out: number): number
  ghostty_sys_set(option: number, value: number): number
}

export interface BridgeWasmExports extends WebAssembly.Exports {
  bridge_bell: WebAssembly.ExportValue
  bridge_clipboard_write: WebAssembly.ExportValue
  bridge_color_scheme: WebAssembly.ExportValue
  bridge_write_pty: WebAssembly.ExportValue
  bridge_device_attributes: WebAssembly.ExportValue
  bridge_size: WebAssembly.ExportValue
  bridge_xtversion: WebAssembly.ExportValue
  bridge_title_changed: WebAssembly.ExportValue
  bridge_decode_png: WebAssembly.ExportValue
}

export interface AbiField {
  offset: number
  size: number
  type: string
}

export interface AbiTypeDescriptor {
  align: number
  kind: string
  size: number
}

export interface AbiLayout extends AbiTypeDescriptor {
  fields: Record<string, AbiField>
  kind: 'struct' | 'union'
}

export type AbiLayouts = Record<string, AbiTypeDescriptor>

/** Schema version of `ghostty_type_json` this binding layer understands. */
export const ABI_SCHEMA_VERSION = 1

export interface AbiTarget {
  endian: string
  environment: string
  max_alignment: number
  os: string
  pointer_size: number
  target: string
  usize_size: number
}

export interface AbiManifest {
  abi: AbiTarget
  schema: number
  types: AbiLayouts
}
