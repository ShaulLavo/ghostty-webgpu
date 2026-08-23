import type {
  ClipboardLocation,
  ClipboardWriteResult,
  ColorScheme,
  RenderStateDirty,
} from './abi.js'

export type WasmSource =
  | ArrayBuffer
  | ArrayBufferView<ArrayBufferLike>
  | WebAssembly.Module
  | URL
  | string

export interface AbiFieldLayout {
  offset: number
  size: number
  type: string
}

export interface DeviceAttributes {
  primary: {
    conformanceLevel: number
    features: readonly number[]
  }
  secondary: {
    deviceType: number
    firmwareVersion: number
    romCartridge: number
  }
  tertiary: {
    unitId: number
  }
}

export interface TerminalSize {
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
}

export interface CellGeometryInput {
  readonly cellHeight: number
  readonly cellWidth: number
  readonly pixelRatio: number
}

export interface NormalizedCellGeometry extends CellGeometryInput {
  readonly deviceCellHeight: number
  readonly deviceCellWidth: number
}

function positiveFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be a finite positive number`)
}

function deviceDimension(name: string, value: number, pixelRatio: number): number {
  const scaled = Math.round(value * pixelRatio)
  if (Number.isSafeInteger(scaled) && scaled > 0) return scaled
  throw new RangeError(`${name} multiplied by pixelRatio must produce a positive safe integer`)
}

export function normalizeCellGeometry(input: CellGeometryInput): NormalizedCellGeometry {
  const pixelRatio = positiveFinite('pixelRatio', input.pixelRatio)
  const cellHeight = positiveFinite('cellHeight', input.cellHeight)
  const cellWidth = positiveFinite('cellWidth', input.cellWidth)
  const deviceCellHeight = deviceDimension('cellHeight', cellHeight, pixelRatio)
  const deviceCellWidth = deviceDimension('cellWidth', cellWidth, pixelRatio)
  return Object.freeze({
    cellHeight: deviceCellHeight / pixelRatio,
    cellWidth: deviceCellWidth / pixelRatio,
    deviceCellHeight,
    deviceCellWidth,
    pixelRatio,
  })
}

export interface DecodedPng {
  width: number
  height: number
  pixels: Uint8Array
}

export interface ClipboardRepresentation {
  data: Uint8Array
  mime: string
}

export interface ClipboardWrite {
  contents: readonly ClipboardRepresentation[]
  location: ClipboardLocation
}

export interface TerminalEffects {
  bell?: () => void
  clipboardWrite?: (write: ClipboardWrite) => ClipboardWriteResult
  colorScheme?: ColorScheme
  deviceAttributes?: DeviceAttributes
  titleChanged?: () => void
  writePty?: (bytes: Uint8Array) => void
  xtversion?: string
}

export interface RuntimeOptions {
  bridge?: WasmSource
  decodePng?: (bytes: Uint8Array) => DecodedPng | undefined
  log?: (message: string) => void
  wasm?: WasmSource
}

export interface TerminalOptions {
  cellHeight?: number
  cellWidth?: number
  columns?: number
  effects?: TerminalEffects
  rows?: number
}

export interface RgbColor {
  b: number
  g: number
  r: number
}

export interface TerminalCursor {
  pendingWrap: boolean
  visible: boolean
  x: number
  y: number
}

export interface TerminalScrollbar {
  length: number
  offset: number
  total: number
}

export interface TerminalColors {
  background?: RgbColor
  cursor?: RgbColor
  foreground?: RgbColor
  palette: readonly RgbColor[]
}

export type TerminalCursorStyle = 'bar' | 'block' | 'outline' | 'underline'

export type TerminalPointTag = 'active' | 'history' | 'screen' | 'viewport'

export interface TerminalPoint {
  tag: TerminalPointTag
  x: number
  y: number
}

export interface TerminalSelectionFormatOptions {
  format?: 'html' | 'plain' | 'vt'
  trim?: boolean
  unwrap?: boolean
}

export interface CellStyle {
  blink: boolean
  bold: boolean
  faint: boolean
  invisible: boolean
  inverse: boolean
  italic: boolean
  overline: boolean
  strikethrough: boolean
  underline: number
}

export interface RenderCell {
  background?: RgbColor
  continuation: boolean
  foreground?: RgbColor
  selected: boolean
  style?: CellStyle
  text: string
  x: number
}

export interface RenderRow {
  cells: readonly RenderCell[]
  dirty: boolean
  y: number
}

export interface ReadRowsOptions {
  dirtyOnly?: boolean
}

export interface DamageSnapshot {
  dirty: RenderStateDirty
  rows: readonly RenderRow[]
}

export interface RenderCursorViewport {
  wideTail: boolean
  x: number
  y: number
}

export interface RenderCursorSnapshot {
  blinking: boolean
  passwordInput: boolean
  style: TerminalCursorStyle
  viewport?: RenderCursorViewport
  visible: boolean
}
