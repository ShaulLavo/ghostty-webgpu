import {
  FormatterFormat,
  GhosttyResult,
  PointTag,
  ScrollViewportTag,
  TerminalCursorStyle as NativeTerminalCursorStyle,
  TerminalData,
  TerminalMode,
  TerminalOption,
  TerminalScreen,
} from './abi.js'
import type { AbiLayout } from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import { requireLayout } from './memory.js'
import type { GhosttyRuntime } from './runtime.js'
import type {
  RgbColor,
  TerminalColors,
  TerminalCursor,
  TerminalCursorStyle,
  TerminalEffects,
  TerminalOptions,
  TerminalPoint,
  TerminalScrollbar,
  TerminalSelectionFormatOptions,
  TerminalSize,
} from './types.js'

const decoder = new TextDecoder()
const paletteLength = 256
const uint16Max = 0xffff
const uint32Max = 0xffffffff
const int32Min = -0x80000000
const int32Max = 0x7fffffff

const defaultSize: TerminalSize = {
  cellHeight: 16,
  cellWidth: 8,
  columns: 80,
  rows: 24,
}

type NativeBufferReader = (buffer: number, length: number, outWritten: number) => number

function validateDimension(name: string, value: number, maximum: number): number {
  if (Number.isInteger(value) && value > 0 && value <= maximum) return value
  throw createGhosttyError('terminal.new', `${name} must be an integer between 1 and ${maximum}`)
}

function validateUnsigned(name: string, value: number, maximum: number, operation: string): number {
  if (Number.isSafeInteger(value) && value >= 0 && value <= maximum) return value
  throw createGhosttyError(operation, `${name} must be a safe integer between 0 and ${maximum}`)
}

function validateDelta(value: number): number {
  if (Number.isInteger(value) && value >= int32Min && value <= int32Max) return value
  throw createGhosttyError(
    'ghostty_terminal_scroll_viewport',
    `delta must be an integer between ${int32Min} and ${int32Max}`,
  )
}

function validateColorChannel(name: string, value: number): number {
  if (Number.isInteger(value) && value >= 0 && value <= 0xff) return value
  throw createGhosttyError(
    'ghostty_terminal_set(COLOR)',
    `${name} must be an integer from 0 to 255`,
  )
}

function validateColor(color: RgbColor): RgbColor {
  return {
    b: validateColorChannel('b', color.b),
    g: validateColorChannel('g', color.g),
    r: validateColorChannel('r', color.r),
  }
}

function normalizeSize(options: TerminalOptions): TerminalSize {
  return {
    cellHeight: validateDimension(
      'cellHeight',
      options.cellHeight ?? defaultSize.cellHeight,
      uint32Max,
    ),
    cellWidth: validateDimension(
      'cellWidth',
      options.cellWidth ?? defaultSize.cellWidth,
      uint32Max,
    ),
    columns: validateDimension('columns', options.columns ?? defaultSize.columns, uint16Max),
    rows: validateDimension('rows', options.rows ?? defaultSize.rows, uint16Max),
  }
}

function fieldOffset(layout: AbiLayout, field: string): number {
  const value = layout.fields[field]
  if (value) return value.offset
  throw createGhosttyError('ghostty_type_json', `Required ABI field is missing: ${field}`)
}

function decodeSafeUint64(view: DataView, pointer: number, name: string): number {
  const value = view.getBigUint64(pointer, true)
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  throw createGhosttyError(
    'ghostty_terminal_get(SCROLLBAR)',
    `${name} exceeds Number.MAX_SAFE_INTEGER`,
  )
}

function nativeCursorStyle(style: TerminalCursorStyle): NativeTerminalCursorStyle {
  if (style === 'bar') return NativeTerminalCursorStyle.Bar
  if (style === 'block') return NativeTerminalCursorStyle.Block
  if (style === 'underline') return NativeTerminalCursorStyle.Underline
  if (style === 'outline') return NativeTerminalCursorStyle.BlockHollow
  throw createGhosttyError(
    'ghostty_terminal_set(DEFAULT_CURSOR_STYLE)',
    `Unknown cursor style: ${String(style)}`,
  )
}

function nativeFormatterFormat(format: TerminalSelectionFormatOptions['format']): FormatterFormat {
  if (format === undefined || format === 'plain') return FormatterFormat.Plain
  if (format === 'vt') return FormatterFormat.Vt
  if (format === 'html') return FormatterFormat.Html
  throw createGhosttyError(
    'ghostty_terminal_selection_format_buf',
    `Unknown format: ${String(format)}`,
  )
}

function nativePointTag(point: TerminalPoint): PointTag {
  if (point.tag === 'active') return PointTag.Active
  if (point.tag === 'viewport') return PointTag.Viewport
  if (point.tag === 'screen') return PointTag.Screen
  if (point.tag === 'history') return PointTag.History
  throw createGhosttyError('ghostty_terminal_grid_ref', `Unknown point tag: ${String(point.tag)}`)
}

function assertOutOfSpace(operation: string, result: number): void {
  if (result === GhosttyResult.OutOfSpace) return
  assertGhosttyResult(operation, result)
}

export class GhosttyTerminal {
  readonly runtime: GhosttyRuntime
  private readonly effects: TerminalEffects
  private defaultCursorBlinkValue = false
  private defaultCursorStyleValue: TerminalCursorStyle = 'block'
  private disposed = false
  private handleValue: number
  private sizeValue: TerminalSize

  constructor(runtime: GhosttyRuntime, options: TerminalOptions) {
    this.runtime = runtime
    this.effects = options.effects ?? {}
    this.sizeValue = normalizeSize(options)
    this.handleValue = this.createHandle()
    try {
      this.runtime.bridge.registerTerminal(this.handleValue, this.effects, this.sizeValue)
      this.resize(this.sizeValue)
    } catch (cause) {
      this.runtime.bridge.unregisterTerminal(this.handleValue)
      this.runtime.exports.ghostty_terminal_free(this.handleValue)
      throw cause
    }
  }

  get handle(): number {
    this.ensureActive()
    return this.handleValue
  }

  get size(): TerminalSize {
    return { ...this.sizeValue }
  }

  get title(): string {
    const layout = requireLayout(this.runtime.layouts, 'GhosttyString')
    return this.readRequiredData(TerminalData.Title, layout.size, 'TITLE', (pointer) => {
      const data = this.runtime.memory.view.getUint32(pointer + fieldOffset(layout, 'ptr'), true)
      const length = this.runtime.memory.view.getUint32(pointer + fieldOffset(layout, 'len'), true)
      return decoder.decode(this.runtime.memory.bytes.subarray(data, data + length))
    })
  }

  get cursor(): TerminalCursor {
    return {
      pendingWrap: this.readBoolean(TerminalData.CursorPendingWrap, 'CURSOR_PENDING_WRAP'),
      visible: this.readBoolean(TerminalData.CursorVisible, 'CURSOR_VISIBLE'),
      x: this.readUint16(TerminalData.CursorX, 'CURSOR_X'),
      y: this.readUint16(TerminalData.CursorY, 'CURSOR_Y'),
    }
  }

  get activeScreen(): TerminalScreen {
    return this.readInt32(TerminalData.ActiveScreen, 'ACTIVE_SCREEN') as TerminalScreen
  }

  get kittyKeyboardFlags(): number {
    return this.readUint8(TerminalData.KittyKeyboardFlags, 'KITTY_KEYBOARD_FLAGS')
  }

  get mouseTracking(): boolean {
    return this.readBoolean(TerminalData.MouseTracking, 'MOUSE_TRACKING')
  }

  get scrollbar(): TerminalScrollbar {
    const layout = requireLayout(this.runtime.layouts, 'GhosttyTerminalScrollbar')
    return this.readRequiredData(TerminalData.Scrollbar, layout.size, 'SCROLLBAR', (pointer) => ({
      length: decodeSafeUint64(
        this.runtime.memory.view,
        pointer + fieldOffset(layout, 'len'),
        'scrollbar length',
      ),
      offset: decodeSafeUint64(
        this.runtime.memory.view,
        pointer + fieldOffset(layout, 'offset'),
        'scrollbar offset',
      ),
      total: decodeSafeUint64(
        this.runtime.memory.view,
        pointer + fieldOffset(layout, 'total'),
        'scrollbar total',
      ),
    }))
  }

  get totalRows(): number {
    return this.readUint32(TerminalData.TotalRows, 'TOTAL_ROWS')
  }

  get scrollbackLength(): number {
    return this.readUint32(TerminalData.ScrollbackRows, 'SCROLLBACK_ROWS')
  }

  get scrollbackLimit(): number | undefined {
    return this.readOptionalData(
      TerminalData.ScrollbackMaxLines,
      4,
      'SCROLLBACK_MAX_LINES',
      (pointer) => this.runtime.memory.view.getUint32(pointer, true),
    )
  }

  get viewportActive(): boolean {
    return this.readBoolean(TerminalData.ViewportActive, 'VIEWPORT_ACTIVE')
  }

  get hasSelection(): boolean {
    this.ensureActive()
    const layout = requireLayout(this.runtime.layouts, 'GhosttySelection')
    const pointer = this.runtime.memory.allocate(layout.size)
    try {
      this.runtime.memory.view.setUint32(pointer + fieldOffset(layout, 'size'), layout.size, true)
      const result = this.runtime.exports.ghostty_terminal_get(
        this.handleValue,
        TerminalData.Selection,
        pointer,
      )
      if (result === GhosttyResult.NoValue) return false
      assertGhosttyResult('ghostty_terminal_get(SELECTION)', result)
      return true
    } finally {
      this.runtime.memory.free(pointer, layout.size)
    }
  }

  get foregroundColor(): RgbColor | undefined {
    return this.readColor(TerminalData.ColorForeground, 'COLOR_FOREGROUND')
  }

  get backgroundColor(): RgbColor | undefined {
    return this.readColor(TerminalData.ColorBackground, 'COLOR_BACKGROUND')
  }

  get cursorColor(): RgbColor | undefined {
    return this.readColor(TerminalData.ColorCursor, 'COLOR_CURSOR')
  }

  get palette(): readonly RgbColor[] {
    return this.readPalette(TerminalData.ColorPalette, 'COLOR_PALETTE')
  }

  get defaultForegroundColor(): RgbColor | undefined {
    return this.readColor(TerminalData.ColorForegroundDefault, 'COLOR_FOREGROUND_DEFAULT')
  }

  get defaultBackgroundColor(): RgbColor | undefined {
    return this.readColor(TerminalData.ColorBackgroundDefault, 'COLOR_BACKGROUND_DEFAULT')
  }

  get defaultCursorColor(): RgbColor | undefined {
    return this.readColor(TerminalData.ColorCursorDefault, 'COLOR_CURSOR_DEFAULT')
  }

  get defaultPalette(): readonly RgbColor[] {
    return this.readPalette(TerminalData.ColorPaletteDefault, 'COLOR_PALETTE_DEFAULT')
  }

  get colors(): TerminalColors {
    return {
      background: this.backgroundColor,
      cursor: this.cursorColor,
      foreground: this.foregroundColor,
      palette: this.palette,
    }
  }

  get defaultColors(): TerminalColors {
    return {
      background: this.defaultBackgroundColor,
      cursor: this.defaultCursorColor,
      foreground: this.defaultForegroundColor,
      palette: this.defaultPalette,
    }
  }

  get defaultCursorStyle(): TerminalCursorStyle {
    this.ensureActive()
    return this.defaultCursorStyleValue
  }

  get defaultCursorBlink(): boolean {
    this.ensureActive()
    return this.defaultCursorBlinkValue
  }

  isModeEnabled(mode: TerminalMode): boolean {
    this.ensureActive()
    const layout = requireLayout(this.runtime.layouts, 'GhosttyTerminalModeConfig')
    const pointer = this.runtime.memory.allocate(layout.size)
    try {
      this.runtime.memory.view.setUint16(pointer + fieldOffset(layout, 'mode'), mode, true)
      assertGhosttyResult(
        'ghostty_terminal_get(MODE)',
        this.runtime.exports.ghostty_terminal_get(this.handleValue, TerminalData.Mode, pointer),
      )
      return this.runtime.memory.view.getUint8(pointer + fieldOffset(layout, 'value')) !== 0
    } finally {
      this.runtime.memory.free(pointer, layout.size)
    }
  }

  setMode(mode: TerminalMode, enabled: boolean): void {
    this.ensureActive()
    const layout = requireLayout(this.runtime.layouts, 'GhosttyTerminalModeConfig')
    this.setAllocatedOption(TerminalOption.Mode, layout.size, 'MODE', (pointer) => {
      this.runtime.memory.view.setUint16(pointer + fieldOffset(layout, 'mode'), mode, true)
      this.runtime.memory.view.setUint8(pointer + fieldOffset(layout, 'value'), Number(enabled))
    })
  }

  setScrollbackLimit(limit?: number): void {
    this.ensureActive()
    if (limit === undefined) {
      this.setNullOption(TerminalOption.ScrollbackMaxLines, 'SCROLLBACK_MAX_LINES')
      return
    }
    const value = validateUnsigned(
      'limit',
      limit,
      uint32Max,
      'ghostty_terminal_set(SCROLLBACK_MAX_LINES)',
    )
    this.setAllocatedOption(
      TerminalOption.ScrollbackMaxLines,
      4,
      'SCROLLBACK_MAX_LINES',
      (pointer) => {
        this.runtime.memory.view.setUint32(pointer, value, true)
      },
    )
  }

  scrollToTop(): void {
    this.scrollViewport(ScrollViewportTag.Top)
  }

  scrollToBottom(): void {
    this.scrollViewport(ScrollViewportTag.Bottom)
  }

  scrollBy(delta: number): void {
    this.scrollViewport(ScrollViewportTag.Delta, validateDelta(delta))
  }

  scrollToRow(row: number): void {
    const value = validateUnsigned('row', row, uint32Max, 'ghostty_terminal_scroll_viewport')
    this.scrollViewport(ScrollViewportTag.Row, value)
  }

  clearSelection(): void {
    this.ensureActive()
    this.setNullOption(TerminalOption.Selection, 'SELECTION')
  }

  selectAll(): boolean {
    this.ensureActive()
    const layout = requireLayout(this.runtime.layouts, 'GhosttySelection')
    const pointer = this.runtime.memory.allocate(layout.size)
    try {
      this.runtime.memory.view.setUint32(pointer + fieldOffset(layout, 'size'), layout.size, true)
      const result = this.runtime.exports.ghostty_terminal_select_all(this.handleValue, pointer)
      if (result === GhosttyResult.NoValue) return false
      assertGhosttyResult('ghostty_terminal_select_all', result)
      assertGhosttyResult(
        'ghostty_terminal_set(SELECTION)',
        this.runtime.exports.ghostty_terminal_set(
          this.handleValue,
          TerminalOption.Selection,
          pointer,
        ),
      )
      return true
    } finally {
      this.runtime.memory.free(pointer, layout.size)
    }
  }

  getSelection(options: TerminalSelectionFormatOptions = {}): string | undefined {
    this.ensureActive()
    const layout = requireLayout(this.runtime.layouts, 'GhosttyTerminalSelectionFormatOptions')
    const pointer = this.runtime.memory.allocate(layout.size)
    try {
      this.initializeSelectionFormatOptions(pointer, layout, options)
      const bytes = this.readNativeBuffer(
        'ghostty_terminal_selection_format_buf',
        (buffer, length, out) =>
          this.runtime.exports.ghostty_terminal_selection_format_buf(
            this.handleValue,
            pointer,
            buffer,
            length,
            out,
          ),
      )
      if (!bytes) return undefined
      return decoder.decode(bytes)
    } finally {
      this.runtime.memory.free(pointer, layout.size)
    }
  }

  linkAt(point: TerminalPoint): string | undefined {
    this.ensureActive()
    const pointLayout = requireLayout(this.runtime.layouts, 'GhosttyPoint')
    const refLayout = requireLayout(this.runtime.layouts, 'GhosttyGridRef')
    const pointPointer = this.runtime.memory.allocate(pointLayout.size)
    const refPointer = this.runtime.memory.allocate(refLayout.size)
    try {
      this.initializePoint(pointPointer, pointLayout, point)
      this.runtime.memory.view.setUint32(
        refPointer + fieldOffset(refLayout, 'size'),
        refLayout.size,
        true,
      )
      const result = this.runtime.exports.ghostty_terminal_grid_ref(
        this.handleValue,
        pointPointer,
        refPointer,
      )
      if (result === GhosttyResult.NoValue) return undefined
      assertGhosttyResult('ghostty_terminal_grid_ref', result)
      const bytes = this.readNativeBuffer('ghostty_grid_ref_hyperlink_uri', (buffer, length, out) =>
        this.runtime.exports.ghostty_grid_ref_hyperlink_uri(refPointer, buffer, length, out),
      )
      if (!bytes || bytes.length === 0) return undefined
      return decoder.decode(bytes)
    } finally {
      this.runtime.memory.free(refPointer, refLayout.size)
      this.runtime.memory.free(pointPointer, pointLayout.size)
    }
  }

  setDefaultForegroundColor(color?: RgbColor): void {
    this.setColor(TerminalOption.ColorForeground, color, 'COLOR_FOREGROUND')
  }

  setDefaultBackgroundColor(color?: RgbColor): void {
    this.setColor(TerminalOption.ColorBackground, color, 'COLOR_BACKGROUND')
  }

  setDefaultCursorColor(color?: RgbColor): void {
    this.setColor(TerminalOption.ColorCursor, color, 'COLOR_CURSOR')
  }

  setDefaultPalette(palette?: readonly RgbColor[]): void {
    this.ensureActive()
    if (palette === undefined) {
      this.setNullOption(TerminalOption.ColorPalette, 'COLOR_PALETTE')
      return
    }
    if (palette.length !== paletteLength) {
      throw createGhosttyError(
        'ghostty_terminal_set(COLOR_PALETTE)',
        `palette must contain exactly ${paletteLength} colors`,
      )
    }
    const layout = requireLayout(this.runtime.layouts, 'GhosttyColorRgb')
    const size = layout.size * paletteLength
    this.setAllocatedOption(TerminalOption.ColorPalette, size, 'COLOR_PALETTE', (pointer) => {
      for (let index = 0; index < palette.length; index += 1) {
        this.writeColor(pointer + index * layout.size, layout, validateColor(palette[index]!))
      }
    })
  }

  setDefaultCursorStyle(style?: TerminalCursorStyle): void {
    this.ensureActive()
    if (style === undefined) {
      this.setNullOption(TerminalOption.DefaultCursorStyle, 'DEFAULT_CURSOR_STYLE')
      this.defaultCursorStyleValue = 'block'
      return
    }
    const value = nativeCursorStyle(style)
    this.setAllocatedOption(
      TerminalOption.DefaultCursorStyle,
      4,
      'DEFAULT_CURSOR_STYLE',
      (pointer) => {
        this.runtime.memory.view.setInt32(pointer, value, true)
      },
    )
    this.defaultCursorStyleValue = style
  }

  setDefaultCursorBlink(blink?: boolean): void {
    this.ensureActive()
    if (blink === undefined) {
      this.setNullOption(TerminalOption.DefaultCursorBlink, 'DEFAULT_CURSOR_BLINK')
      this.defaultCursorBlinkValue = false
      return
    }
    this.setAllocatedOption(
      TerminalOption.DefaultCursorBlink,
      1,
      'DEFAULT_CURSOR_BLINK',
      (pointer) => {
        this.runtime.memory.view.setUint8(pointer, Number(blink))
      },
    )
    this.defaultCursorBlinkValue = blink
  }

  write(value: string | Uint8Array): void {
    this.ensureActive()
    const input = this.runtime.memory.allocateBytes(value)
    try {
      this.runtime.exports.ghostty_terminal_vt_write(this.handleValue, input.pointer, input.length)
    } finally {
      this.runtime.memory.freeBytes(input)
    }
  }

  resize(size: Partial<TerminalSize>): void {
    this.ensureActive()
    const next = normalizeSize({ ...this.sizeValue, ...size })
    assertGhosttyResult(
      'ghostty_terminal_resize',
      this.runtime.exports.ghostty_terminal_resize(
        this.handleValue,
        next.columns,
        next.rows,
        next.cellWidth,
        next.cellHeight,
      ),
    )
    this.sizeValue = next
    this.runtime.bridge.updateTerminalSize(this.handleValue, next)
  }

  reset(): void {
    this.ensureActive()
    this.runtime.exports.ghostty_terminal_reset(this.handleValue)
  }

  dispose(): void {
    if (this.disposed) return
    this.runtime.bridge.unregisterTerminal(this.handleValue)
    this.runtime.exports.ghostty_terminal_free(this.handleValue)
    this.runtime.releaseTerminal(this)
    this.disposed = true
    this.handleValue = 0
  }

  private createHandle(): number {
    const out = this.runtime.memory.allocateOpaque()
    try {
      assertGhosttyResult(
        'ghostty_terminal_new',
        this.runtime.exports.ghostty_terminal_new(
          0,
          out,
          this.sizeValue.columns,
          this.sizeValue.rows,
        ),
      )
      return this.runtime.memory.takeOpaque(out, 'ghostty_terminal_new')
    } finally {
      this.runtime.memory.freeOpaque(out)
    }
  }

  private readRequiredData<T>(
    data: TerminalData,
    size: number,
    name: string,
    read: (pointer: number) => T,
  ): T {
    this.ensureActive()
    const pointer = this.runtime.memory.allocate(size)
    try {
      assertGhosttyResult(
        `ghostty_terminal_get(${name})`,
        this.runtime.exports.ghostty_terminal_get(this.handleValue, data, pointer),
      )
      return read(pointer)
    } finally {
      this.runtime.memory.free(pointer, size)
    }
  }

  private readOptionalData<T>(
    data: TerminalData,
    size: number,
    name: string,
    read: (pointer: number) => T,
  ): T | undefined {
    this.ensureActive()
    const pointer = this.runtime.memory.allocate(size)
    try {
      const result = this.runtime.exports.ghostty_terminal_get(this.handleValue, data, pointer)
      if (result === GhosttyResult.NoValue) return undefined
      assertGhosttyResult(`ghostty_terminal_get(${name})`, result)
      return read(pointer)
    } finally {
      this.runtime.memory.free(pointer, size)
    }
  }

  private readBoolean(data: TerminalData, name: string): boolean {
    return this.readRequiredData(
      data,
      1,
      name,
      (pointer) => this.runtime.memory.view.getUint8(pointer) !== 0,
    )
  }

  private readUint8(data: TerminalData, name: string): number {
    return this.readRequiredData(data, 1, name, (pointer) =>
      this.runtime.memory.view.getUint8(pointer),
    )
  }

  private readUint16(data: TerminalData, name: string): number {
    return this.readRequiredData(data, 2, name, (pointer) =>
      this.runtime.memory.view.getUint16(pointer, true),
    )
  }

  private readUint32(data: TerminalData, name: string): number {
    return this.readRequiredData(data, 4, name, (pointer) =>
      this.runtime.memory.view.getUint32(pointer, true),
    )
  }

  private readInt32(data: TerminalData, name: string): number {
    return this.readRequiredData(data, 4, name, (pointer) =>
      this.runtime.memory.view.getInt32(pointer, true),
    )
  }

  private setAllocatedOption(
    option: TerminalOption,
    size: number,
    name: string,
    write: (pointer: number) => void,
  ): void {
    const pointer = this.runtime.memory.allocate(size)
    try {
      write(pointer)
      assertGhosttyResult(
        `ghostty_terminal_set(${name})`,
        this.runtime.exports.ghostty_terminal_set(this.handleValue, option, pointer),
      )
    } finally {
      this.runtime.memory.free(pointer, size)
    }
  }

  private setNullOption(option: TerminalOption, name: string): void {
    assertGhosttyResult(
      `ghostty_terminal_set(${name})`,
      this.runtime.exports.ghostty_terminal_set(this.handleValue, option, 0),
    )
  }

  private scrollViewport(tag: ScrollViewportTag, value = 0): void {
    this.ensureActive()
    const layout = requireLayout(this.runtime.layouts, 'GhosttyTerminalScrollViewport')
    const union = requireLayout(this.runtime.layouts, 'GhosttyTerminalScrollViewportValue')
    const pointer = this.runtime.memory.allocate(layout.size)
    try {
      this.runtime.memory.view.setInt32(pointer + fieldOffset(layout, 'tag'), tag, true)
      const valuePointer = pointer + fieldOffset(layout, 'value')
      if (tag === ScrollViewportTag.Delta) {
        this.runtime.memory.view.setInt32(valuePointer + fieldOffset(union, 'delta'), value, true)
      }
      if (tag === ScrollViewportTag.Row) {
        this.runtime.memory.view.setUint32(valuePointer + fieldOffset(union, 'row'), value, true)
      }
      this.runtime.exports.ghostty_terminal_scroll_viewport(this.handleValue, pointer)
    } finally {
      this.runtime.memory.free(pointer, layout.size)
    }
  }

  private initializeSelectionFormatOptions(
    pointer: number,
    layout: AbiLayout,
    options: TerminalSelectionFormatOptions,
  ): void {
    this.runtime.memory.view.setUint32(pointer + fieldOffset(layout, 'size'), layout.size, true)
    this.runtime.memory.view.setInt32(
      pointer + fieldOffset(layout, 'emit'),
      nativeFormatterFormat(options.format),
      true,
    )
    this.runtime.memory.view.setUint8(
      pointer + fieldOffset(layout, 'unwrap'),
      Number(options.unwrap ?? true),
    )
    this.runtime.memory.view.setUint8(
      pointer + fieldOffset(layout, 'trim'),
      Number(options.trim ?? true),
    )
  }

  private readNativeBuffer(operation: string, read: NativeBufferReader): Uint8Array | undefined {
    const outWritten = this.runtime.memory.allocate(4)
    try {
      const result = read(0, 0, outWritten)
      if (result === GhosttyResult.NoValue) return undefined
      if (result === GhosttyResult.Success) return new Uint8Array()
      assertOutOfSpace(operation, result)
      const required = this.runtime.memory.view.getUint32(outWritten, true)
      return this.readAllocatedBuffer(operation, required, outWritten, read)
    } finally {
      this.runtime.memory.free(outWritten, 4)
    }
  }

  private readAllocatedBuffer(
    operation: string,
    required: number,
    outWritten: number,
    read: NativeBufferReader,
  ): Uint8Array {
    if (required === 0) return new Uint8Array()
    const buffer = this.runtime.memory.allocate(required)
    try {
      assertGhosttyResult(operation, read(buffer, required, outWritten))
      const written = this.runtime.memory.view.getUint32(outWritten, true)
      if (written <= required) {
        return Uint8Array.from(this.runtime.memory.bytes.subarray(buffer, buffer + written))
      }
      throw createGhosttyError(operation, `Native call wrote ${written} bytes into ${required}`)
    } finally {
      this.runtime.memory.free(buffer, required)
    }
  }

  private initializePoint(pointer: number, layout: AbiLayout, point: TerminalPoint): void {
    validateUnsigned('x', point.x, uint16Max, 'ghostty_terminal_grid_ref')
    validateUnsigned('y', point.y, uint32Max, 'ghostty_terminal_grid_ref')
    const tag = nativePointTag(point)
    const union = requireLayout(this.runtime.layouts, 'GhosttyPointValue')
    const coordinate = requireLayout(this.runtime.layouts, 'GhosttyPointCoordinate')
    this.runtime.memory.view.setInt32(pointer + fieldOffset(layout, 'tag'), tag, true)
    const coordinatePointer =
      pointer + fieldOffset(layout, 'value') + fieldOffset(union, 'coordinate')
    this.runtime.memory.view.setUint16(
      coordinatePointer + fieldOffset(coordinate, 'x'),
      point.x,
      true,
    )
    this.runtime.memory.view.setUint32(
      coordinatePointer + fieldOffset(coordinate, 'y'),
      point.y,
      true,
    )
  }

  private readColor(data: TerminalData, name: string): RgbColor | undefined {
    const layout = requireLayout(this.runtime.layouts, 'GhosttyColorRgb')
    return this.readOptionalData(data, layout.size, name, (pointer) =>
      this.decodeColor(pointer, layout),
    )
  }

  private readPalette(data: TerminalData, name: string): readonly RgbColor[] {
    const layout = requireLayout(this.runtime.layouts, 'GhosttyColorRgb')
    const size = layout.size * paletteLength
    return this.readRequiredData(data, size, name, (pointer) => {
      const colors: RgbColor[] = []
      for (let index = 0; index < paletteLength; index += 1) {
        colors.push(this.decodeColor(pointer + index * layout.size, layout))
      }
      return colors
    })
  }

  private decodeColor(pointer: number, layout: AbiLayout): RgbColor {
    return {
      b: this.runtime.memory.view.getUint8(pointer + fieldOffset(layout, 'b')),
      g: this.runtime.memory.view.getUint8(pointer + fieldOffset(layout, 'g')),
      r: this.runtime.memory.view.getUint8(pointer + fieldOffset(layout, 'r')),
    }
  }

  private setColor(option: TerminalOption, color: RgbColor | undefined, name: string): void {
    this.ensureActive()
    if (color === undefined) {
      this.setNullOption(option, name)
      return
    }
    const layout = requireLayout(this.runtime.layouts, 'GhosttyColorRgb')
    this.setAllocatedOption(option, layout.size, name, (pointer) => {
      this.writeColor(pointer, layout, validateColor(color))
    })
  }

  private writeColor(pointer: number, layout: AbiLayout, color: RgbColor): void {
    this.runtime.memory.view.setUint8(pointer + fieldOffset(layout, 'r'), color.r)
    this.runtime.memory.view.setUint8(pointer + fieldOffset(layout, 'g'), color.g)
    this.runtime.memory.view.setUint8(pointer + fieldOffset(layout, 'b'), color.b)
  }

  private ensureActive(): void {
    this.runtime.ensureActive()
    if (!this.disposed) return
    throw createGhosttyError('terminal', 'The terminal has been disposed')
  }
}
