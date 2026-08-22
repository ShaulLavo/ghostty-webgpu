import type { RenderStateDirty } from './abi.js'

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

export interface DecodedPng {
  width: number
  height: number
  pixels: Uint8Array
}

export interface TerminalEffects {
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
