import type {
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
  RgbColor,
  TerminalScrollbar,
} from '../core/types.js'
import type { RendererTheme } from '../render/shared/instances/types.js'
import type { TerminalFittedFont } from '../term/types.js'
import type { TerminalElementPadding } from './elements.js'

/** UTF-16 storage bytes, including the serialized envelope. */
export const TERMINAL_VIEWPORT_MAX_BYTES = 262144
const maxCells = 40000
const maxDimension = 16384
const styleFlags = [
  'blink',
  'bold',
  'faint',
  'invisible',
  'inverse',
  'italic',
  'overline',
  'strikethrough',
] as const

export type PackedViewportCell = readonly [
  number,
  string,
  number,
  RgbColor | null,
  RgbColor | null,
  number,
]

export interface SavedViewport {
  readonly version: 1
  readonly width: number
  readonly height: number
  readonly columns: number
  readonly rows: readonly (readonly PackedViewportCell[])[]
  readonly scrollbar: Readonly<TerminalScrollbar>
  readonly cursor: RenderCursorSnapshot
  readonly font: TerminalFittedFont
  readonly theme: RendererTheme
  readonly padding: TerminalElementPadding
}

function packedCell(cell: RenderCell): PackedViewportCell {
  let flags = (cell.continuation ? 1 : 0) | (cell.selected ? 2 : 0)
  for (const [index, name] of styleFlags.entries()) {
    if (cell.style?.[name]) flags |= 1 << (index + 2)
  }
  return [
    cell.x,
    cell.text,
    flags,
    cell.foreground ?? null,
    cell.background ?? null,
    cell.style?.underline ?? 0,
  ]
}

function hasPaint(cell: RenderCell): boolean {
  return Boolean(
    cell.text ||
    cell.continuation ||
    cell.selected ||
    cell.foreground ||
    cell.background ||
    (cell.style && (cell.style.underline || styleFlags.some((flag) => cell.style?.[flag]))),
  )
}

export function encodeTerminalViewport(
  input: Omit<SavedViewport, 'version' | 'rows'> & { readonly rows: readonly RenderRow[] },
): string | undefined {
  if (input.cursor.passwordInput || input.columns * input.rows.length > maxCells) return undefined
  if (input.font.settings.family.length > 1024) return undefined
  const { rows: source, ...metadata } = input
  const envelopeLength = JSON.stringify({ ...metadata, version: 1, rows: [] }).length
  const rows = packRows(source, TERMINAL_VIEWPORT_MAX_BYTES / 2 - envelopeLength)
  if (!rows) return undefined
  const serialized = JSON.stringify({ ...input, version: 1, rows })
  if (serialized.length * 2 > TERMINAL_VIEWPORT_MAX_BYTES) return undefined
  return decodeTerminalViewport(serialized) ? serialized : undefined
}

function packRow(row: RenderRow, remaining: number) {
  const cells: PackedViewportCell[] = []
  let characters = 3
  for (const cell of row.cells) {
    if (!hasPaint(cell)) continue
    if (cell.text.length > 4096) return undefined
    const packed = packedCell(cell)
    characters += JSON.stringify(packed).length + 1
    if (characters > remaining) return undefined
    cells.push(packed)
  }
  return { cells, characters }
}

function packRows(source: readonly RenderRow[], remaining: number) {
  const rows: PackedViewportCell[][] = []
  for (const row of source) {
    const packed = packRow(row, remaining)
    if (!packed) return undefined
    remaining -= packed.characters
    rows.push(packed.cells)
  }
  return rows
}

function validScrollbar(value: unknown): value is TerminalScrollbar {
  if (!record(value) || !integer(value.total, 0, Number.MAX_SAFE_INTEGER)) return false
  return (
    integer(value.length, 0, value.total) && integer(value.offset, 0, value.total - value.length)
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown, min = 0, max = maxDimension): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function integer(value: unknown, min: number, max: number): value is number {
  return finite(value, min, max) && Number.isInteger(value)
}

export function isRgbColor(value: unknown): value is RgbColor {
  return (
    record(value) &&
    integer(value.r, 0, 255) &&
    integer(value.g, 0, 255) &&
    integer(value.b, 0, 255)
  )
}

function validFont(value: unknown): value is TerminalFittedFont {
  if (!record(value) || !record(value.settings)) return false
  if (!finite(value.charLeft, -1024, 1024)) return false
  const metrics = ['charTop', 'deviceBaseline', 'deviceCharHeight', 'deviceCharWidth']
  if (!metrics.every((key) => finite(value[key]))) return false
  const positive = [
    'cssCellHeight',
    'cssCellWidth',
    'deviceCellHeight',
    'deviceCellWidth',
    'pixelRatio',
  ]
  if (!positive.every((key) => finite(value[key], 0.01, 1024))) return false
  const settings = value.settings
  if (typeof settings.family !== 'string' || settings.family.length > 1024) return false
  if (!finite(settings.letterSpacing, -1024, 1024)) return false
  return ['boldWeight', 'lineHeight', 'size', 'weight'].every((key) =>
    finite(settings[key], 0.01, 1024),
  )
}

function validTheme(value: unknown): value is RendererTheme {
  if (!record(value) || !finite(value.minimumContrast, 1, 21)) return false
  if (value.cursorText !== undefined && !isRgbColor(value.cursorText)) return false
  return ['background', 'cursor', 'foreground', 'selectionBackground', 'selectionForeground'].every(
    (key) => isRgbColor(value[key]),
  )
}

function validCursor(value: unknown, columns: number, rows: number): value is RenderCursorSnapshot {
  if (!record(value) || value.passwordInput !== false) return false
  if (typeof value.blinking !== 'boolean' || typeof value.visible !== 'boolean') return false
  if (!['bar', 'block', 'outline', 'underline'].includes(String(value.style))) return false
  const viewport = value.viewport
  if (viewport === undefined) return true
  return (
    record(viewport) &&
    typeof viewport.wideTail === 'boolean' &&
    integer(viewport.x, 0, columns - 1) &&
    integer(viewport.y, 0, rows - 1)
  )
}

function validCell(value: unknown, columns: number): value is PackedViewportCell {
  if (!Array.isArray(value) || value.length !== 6) return false
  if (!integer(value[0], 0, columns - 1) || typeof value[1] !== 'string' || value[1].length > 4096)
    return false
  if (!integer(value[2], 0, 1023) || !integer(value[5], 0, 5)) return false
  return (value[3] === null || isRgbColor(value[3])) && (value[4] === null || isRgbColor(value[4]))
}

function validRow(value: unknown, columns: number): value is readonly PackedViewportCell[] {
  if (!Array.isArray(value) || value.length > columns) return false
  let previous = -1
  for (const cell of value) {
    if (!validCell(cell, columns) || cell[0] <= previous) return false
    previous = cell[0]
  }
  return true
}

function validViewport(value: unknown): value is SavedViewport {
  if (!record(value) || value.version !== 1 || !validScrollbar(value.scrollbar)) return false
  if (!finite(value.width, 1) || !finite(value.height, 1) || !integer(value.columns, 1, 1000))
    return false
  if (
    !Array.isArray(value.rows) ||
    value.rows.length < 1 ||
    value.columns * value.rows.length > maxCells
  )
    return false
  const columns = value.columns
  if (!value.rows.every((row) => validRow(row, columns))) return false
  if (
    !validFont(value.font) ||
    !validTheme(value.theme) ||
    !validCursor(value.cursor, columns, value.rows.length)
  )
    return false
  const padding = value.padding
  if (!record(padding) || !['top', 'right', 'bottom', 'left'].every((key) => finite(padding[key])))
    return false
  const width = value.font.deviceCellWidth * columns
  const height = value.font.deviceCellHeight * value.rows.length
  if (width * height > 8388608 || width > maxDimension || height > maxDimension) return false
  return (
    width / value.font.pixelRatio <= value.width + 1 &&
    height / value.font.pixelRatio <= value.height + 1
  )
}

export function decodeTerminalViewport(serialized: string): SavedViewport | undefined {
  if (serialized.length * 2 > TERMINAL_VIEWPORT_MAX_BYTES) return undefined
  try {
    const value: unknown = JSON.parse(serialized)
    return validViewport(value) ? value : undefined
  } catch {
    return undefined
  }
}
