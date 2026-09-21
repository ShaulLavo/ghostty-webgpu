import type {
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
  RgbColor,
  TerminalScrollbar,
} from '../core/types.js'
import { CanvasRowPainter } from '../render/canvas/painter.js'
import { canonicalRendererTheme } from '../render/config.js'
import { renderCursorState } from '../render/cursor.js'
import type { RendererTheme } from '../render/instances/types.js'
import type { TerminalFittedFont, TerminalFontSettings } from '../term/types.js'
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

type PackedCell = readonly [number, string, number, RgbColor | null, RgbColor | null, number]
interface SavedViewport {
  readonly version: 1
  readonly width: number
  readonly height: number
  readonly columns: number
  readonly rows: readonly (readonly PackedCell[])[]
  readonly scrollbar: Readonly<TerminalScrollbar>
  readonly cursor: RenderCursorSnapshot
  readonly font: TerminalFittedFont
  readonly theme: RendererTheme
  readonly padding: TerminalElementPadding
}

export interface TerminalViewportOptions {
  readonly font?: Partial<TerminalFontSettings>
  readonly theme?: Partial<RendererTheme>
}

export interface TerminalViewportPaint {
  readonly scrollbar: Readonly<TerminalScrollbar>
  readonly lines: readonly string[]
  dispose(): void
}

function packedCell(cell: RenderCell): PackedCell {
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
  const cells: PackedCell[] = []
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
  const rows: PackedCell[][] = []
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

function color(value: unknown): value is RgbColor {
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
  if (value.cursorText !== undefined && !color(value.cursorText)) return false
  return ['background', 'cursor', 'foreground', 'selectionBackground', 'selectionForeground'].every(
    (key) => color(value[key]),
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

function validCell(value: unknown, columns: number): value is PackedCell {
  if (!Array.isArray(value) || value.length !== 6) return false
  if (!integer(value[0], 0, columns - 1) || typeof value[1] !== 'string' || value[1].length > 4096)
    return false
  if (!integer(value[2], 0, 1023) || !integer(value[5], 0, 5)) return false
  return (value[3] === null || color(value[3])) && (value[4] === null || color(value[4]))
}

function validRow(value: unknown, columns: number): value is readonly PackedCell[] {
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

function decodeTerminalViewport(serialized: string): SavedViewport | undefined {
  if (serialized.length * 2 > TERMINAL_VIEWPORT_MAX_BYTES) return undefined
  try {
    const value: unknown = JSON.parse(serialized)
    return validViewport(value) ? value : undefined
  } catch {
    return undefined
  }
}

function unpackCell(value: PackedCell): RenderCell {
  const [x, text, flags, foreground, background, underline] = value
  const style = {
    blink: Boolean(flags & 4),
    bold: Boolean(flags & 8),
    faint: Boolean(flags & 16),
    invisible: Boolean(flags & 32),
    inverse: Boolean(flags & 64),
    italic: Boolean(flags & 128),
    overline: Boolean(flags & 256),
    strikethrough: Boolean(flags & 512),
    underline,
  }
  return {
    x,
    text,
    continuation: Boolean(flags & 1),
    selected: Boolean(flags & 2),
    foreground: foreground ?? undefined,
    background: background ?? undefined,
    style,
  }
}

function unpackRow(row: readonly PackedCell[], y: number, columns: number): RenderRow {
  const cells: RenderCell[] = Array.from({ length: columns }, (_, x) => ({
    x,
    text: '',
    continuation: false,
    selected: false,
  }))
  for (const cell of row) cells[cell[0]] = unpackCell(cell)
  return { y, cells, dirty: true }
}

function matchesAppearance(saved: SavedViewport, options: TerminalViewportOptions): boolean {
  if (
    options.font &&
    !Object.entries(options.font).every(
      ([key, value]) => Reflect.get(saved.font.settings, key) === value,
    )
  )
    return false
  if (!options.theme) return true
  return Object.entries(options.theme).every(([key, value]) => {
    const stored: unknown = Reflect.get(saved.theme, key)
    if (color(value))
      return color(stored) && value.r === stored.r && value.g === stored.g && value.b === stored.b
    return value === stored
  })
}

/** Draws native cells synchronously, without creating a terminal or accepting input. */
export function paintTerminalViewport(
  host: HTMLElement,
  serialized: string,
  options: TerminalViewportOptions = {},
): TerminalViewportPaint | undefined {
  const saved = decodeTerminalViewport(serialized)
  if (!saved || !matchesAppearance(saved, options)) return undefined
  if (
    Math.abs(host.clientWidth - saved.width) > 1 ||
    Math.abs(host.clientHeight - saved.height) > 1
  )
    return undefined
  if (host.ownerDocument.defaultView?.devicePixelRatio !== saved.font.pixelRatio) return undefined
  const canvas = host.ownerDocument.createElement('canvas')
  canvas.width = saved.columns * saved.font.deviceCellWidth
  canvas.height = saved.rows.length * saved.font.deviceCellHeight
  canvas.style.width = `${canvas.width / saved.font.pixelRatio}px`
  canvas.style.height = `${canvas.height / saved.font.pixelRatio}px`
  canvas.style.padding = `${saved.padding.top}px ${saved.padding.right}px ${saved.padding.bottom}px ${saved.padding.left}px`
  canvas.style.pointerEvents = 'none'
  canvas.style.display = 'block'
  canvas.setAttribute('aria-hidden', 'true')
  const context = canvas.getContext('2d')
  if (!context) return undefined
  const painter = new CanvasRowPainter(context, saved.font, canonicalRendererTheme(saved.theme))
  painter.resetContext(saved.font)
  const cursor = renderCursorState(saved.cursor, true)
  const rows = saved.rows.map((row, y) => unpackRow(row, y, saved.columns))
  for (const row of rows) painter.paint(row, cursor, canvas.width)
  const lines = Object.freeze(
    rows.map((row) =>
      row.cells
        .filter((cell) => !cell.continuation)
        .map((cell) => cell.text || ' ')
        .join(''),
    ),
  )
  host.append(canvas)
  return { lines, scrollbar: Object.freeze({ ...saved.scrollbar }), dispose: () => canvas.remove() }
}
