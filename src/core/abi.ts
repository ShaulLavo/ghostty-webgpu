export const enum GhosttyResult {
  Success = 0,
  OutOfMemory = -1,
  InvalidValue = -2,
  OutOfSpace = -3,
  NoValue = -4,
  IoError = -5,
  LimitExceeded = -6,
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
  Title = 12,
  Pwd = 13,
  TotalRows = 14,
  ScrollbackRows = 15,
}

export const enum RenderStateData {
  Columns = 1,
  Rows = 2,
  Dirty = 3,
  RowIterator = 4,
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
  ghostty_wasm_alloc_u8_array(length: number): number
  ghostty_wasm_free_u8_array(pointer: number, length: number): void
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
  ghostty_terminal_vt_write(terminal: number, data: number, length: number): void
  ghostty_render_state_new(allocator: number, outState: number): number
  ghostty_render_state_free(state: number): void
  ghostty_render_state_update(state: number, terminal: number): number
  ghostty_render_state_get(state: number, data: number, out: number): number
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

export interface AbiLayout {
  align: number
  fields: Record<string, AbiField>
  size: number
}

export type AbiLayouts = Record<string, AbiLayout>
